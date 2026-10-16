/* POST /api/advisor — thin proxy between the in-portal chat and the Gemini API.
   The browser owns state and runs the tools; this function owns the API key, the system
   prompt and the tool list, so the client cannot change guardrails.

   Wire format with the browser (provider-neutral blocks):
     user:      { type:'text', text } | { type:'tool_result', tool_use_id, content, is_error? }
     assistant: { type:'text', text, signature? } | { type:'tool_use', id, name, input, signature? }
                | { type:'thought', text, signature? } | { type:'raw', part }
   Assistant blocks map 1:1 to Gemini parts and keep their thoughtSignature, so history the
   browser sends back reproduces the model's turns exactly. The browser never edits history. */
const { GoogleGenAI, ApiError, FunctionCallingConfigMode, ThinkingLevel } = require('@google/genai');
const AdvisorTools = require('../advisor-tools.js');

const MODEL = 'gemini-3.5-flash-lite';
const THINKING_LEVEL = 'low';
const MAX_OUTPUT_TOKENS = 8192;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_MESSAGES = 80;
const MAX_USER_TEXT = 2000;
const RATE_LIMIT = { requests: 60, windowMs: 10 * 60 * 1000 };
const GENERATED_ID = 'gen_';

const SYSTEM_PROMPT = `You are the academic advisor built into myBucknell, Bucknell University's course registration portal. You are talking with the signed-in student. You help them understand degree progress, choose courses and build a draft schedule.

How to work:
- Use the tools for every fact about the student, courses, requirements, seats and times. Never invent course codes, meeting times, instructors, seat counts or requirements. If a tool does not have the answer, say so.
- Start from get_student_profile when you need personal context. For "what should I take" questions, check requirements (get_phase1_recommendations and/or get_degree_audit) before recommending.
- When you recommend or draft courses, give the reasons that matter: which requirement it satisfies, prerequisites, time conflicts, credits, weekly workload, open seats, and any warning (full section, heavy term, reserved seats, missing prerequisite).
- Respect the student's constraints exactly (credit cap, earliest start, latest end, days off, priorities). If no combination fits, say what blocks it and suggest which constraint to relax.
- To change one course in a draft, use suggest_alternatives or swap_draft_course instead of rebuilding the whole schedule.

Guardrails:
- You only advise and create drafts. A draft holds no seat.
- register_course, drop_course and join_waitlist only REQUEST a change; the portal shows the student a confirmation they must click themselves. Call them only when the student clearly asks to register, drop or waitlist. Never say a course is registered, dropped or waitlisted unless a portal event in the conversation confirms it.
- Be explicit about data provenance. The Fall 2026 catalog used by search, eligibility, the schedule builder and registration is demo sample data for this prototype. The 2026–27 B.S. Computer Science requirements and Spring 2026–27 sections come from official Bucknell sources but are a saved snapshot, not live — seats may have changed. The College of Arts & Sciences core rules come from the Class of 2024 page and may not match the student's cohort. Never present any of it as official real-time data, and suggest confirming with their faculty advisor or the Registrar for final decisions.
- Stay on academic planning at Bucknell. Politely decline unrelated requests.

Style:
- Reply in the student's language (for example Vietnamese if they write Vietnamese). Course codes and titles stay as in the data.
- Be concise: a short answer first, then at most a few bullets using "•". Plain text only — no markdown headings, tables, bold or code blocks. The portal shows cards for drafts and recommendations, so do not repeat every field the card already shows.
- Messages that start with "[Portal context]" or "[Portal event]" are written by the portal, not typed by the student. Treat them as facts about the page state.`;

const FUNCTION_DECLARATIONS = AdvisorTools.forGemini();
const REFUSAL_REASONS = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII']);

function send(res, status, body, headers = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(body));
}

function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  let url;
  try { url = new URL(origin); } catch { return false; }
  if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return true;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  if (host && url.host === host) return true;
  const extra = (process.env.ADVISOR_ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  return extra.includes(origin);
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  return (fwd ? String(fwd).split(',')[0] : req.headers['x-real-ip'] || req.socket?.remoteAddress || 'unknown').trim();
}

/** Best-effort, per-instance limiter. The real cap is the Gemini free-tier quota. */
function createRateLimiter({ requests, windowMs }) {
  const hits = new Map();
  return function check(key, now = Date.now()) {
    const recent = (hits.get(key) || []).filter(t => now - t < windowMs);
    if (recent.length >= requests) {
      hits.set(key, recent);
      return { ok: false, retryAfter: Math.ceil((windowMs - (now - recent[0])) / 1000) };
    }
    recent.push(now);
    hits.set(key, recent);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.some(t => now - t < windowMs)) hits.delete(k);
    return { ok: true };
  };
}

/** Returns an error string, or null when the conversation is acceptable. Never mutates it. */
function validateMessages(messages) {
  if (!Array.isArray(messages) || !messages.length) return 'messages must be a non-empty array.';
  if (messages.length > MAX_MESSAGES) return `Conversation is too long (max ${MAX_MESSAGES} messages). Start a new conversation.`;
  if (messages[0]?.role !== 'user') return 'The first message must come from the user.';
  if (messages[messages.length - 1]?.role !== 'user') return 'The last message must come from the user.';
  for (const m of messages) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) return 'Each message role must be user or assistant.';
    if (typeof m.content === 'string') {
      if (m.role === 'user' && m.content.length > MAX_USER_TEXT) return `Messages are limited to ${MAX_USER_TEXT} characters.`;
      continue;
    }
    if (!Array.isArray(m.content) || !m.content.length) return 'Each message needs content.';
    const allowed = m.role === 'user' ? ['text', 'tool_result'] : ['text', 'tool_use', 'thought', 'raw'];
    for (const block of m.content) {
      if (!block || !allowed.includes(block.type)) return `Unsupported ${m.role} content type: ${block?.type}.`;
      if (m.role === 'user' && block.type === 'text' && String(block.text || '').length > MAX_USER_TEXT) return `Messages are limited to ${MAX_USER_TEXT} characters.`;
      if (block.type === 'tool_use' && (typeof block.name !== 'string' || typeof block.id !== 'string')) return 'tool_use blocks need an id and a name.';
      if (block.type === 'tool_result' && typeof block.tool_use_id !== 'string') return 'tool_result blocks need a tool_use_id.';
    }
  }
  return null;
}

// ---------- Format conversion ----------
function withSignature(part, block) { return block.signature ? { ...part, thoughtSignature: block.signature } : part; }

function parseToolOutput(content) {
  if (typeof content !== 'string') return content ?? null;
  try { return JSON.parse(content); } catch { return content; }
}

/** Browser history -> Gemini contents. Deterministic, so earlier turns render identically on every request. */
function toGeminiContents(messages) {
  const toolNames = new Map();
  const contents = [];
  for (const m of messages) {
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
    const parts = blocks.map(block => {
      switch (block.type) {
        case 'text': return withSignature({ text: block.text }, block);
        case 'thought': return withSignature({ text: block.text, thought: true }, block);
        case 'raw': return block.part;
        case 'tool_use': {
          toolNames.set(block.id, block.name);
          const call = { name: block.name, args: block.input || {} };
          if (!block.id.startsWith(GENERATED_ID)) call.id = block.id;
          return withSignature({ functionCall: call }, block);
        }
        case 'tool_result': {
          const fr = { name: toolNames.get(block.tool_use_id) || 'unknown_tool',
            response: block.is_error ? { error: String(block.content) } : { output: parseToolOutput(block.content) } };
          if (!block.tool_use_id.startsWith(GENERATED_ID)) fr.id = block.tool_use_id;
          return { functionResponse: fr };
        }
      }
      return null;
    }).filter(Boolean);
    const role = m.role === 'assistant' ? 'model' : 'user';
    const prev = contents[contents.length - 1];
    if (prev && prev.role === role) prev.parts.push(...parts);
    else contents.push({ role, parts });
  }
  return contents;
}

/** Gemini response -> browser blocks + a provider-neutral stop reason. */
function fromGeminiResponse(response) {
  const candidate = response.candidates?.[0];
  const parts = candidate?.content?.parts || [];
  const content = parts.map((part, i) => {
    const sig = part.thoughtSignature ? { signature: part.thoughtSignature } : {};
    if (part.functionCall) {
      const fc = part.functionCall;
      return { type: 'tool_use', id: fc.id || `${GENERATED_ID}${response.responseId || 'r'}_${i}`, name: fc.name, input: fc.args || {}, ...sig };
    }
    if (typeof part.text === 'string') return { type: part.thought ? 'thought' : 'text', text: part.text, ...sig };
    return { type: 'raw', part };
  });
  const reason = candidate?.finishReason;
  let stop_reason;
  if (response.promptFeedback?.blockReason || REFUSAL_REASONS.has(reason)) stop_reason = 'refusal';
  else if (!content.length) stop_reason = 'error';
  else if (content.some(b => b.type === 'tool_use')) stop_reason = 'tool_use';
  else if (reason === 'MAX_TOKENS') stop_reason = 'max_tokens';
  else if (reason && reason !== 'STOP') stop_reason = 'error'; // e.g. MALFORMED_FUNCTION_CALL
  else stop_reason = 'end_turn';
  return { content, stop_reason, finish_reason: reason || null };
}

/** Pulls the structured google.rpc details (quota ids, retry delay) out of an SDK error message. */
function googleErrorInfo(err) {
  const message = String(err?.message || '');
  let body = null;
  const start = message.indexOf('{');
  if (start >= 0) { try { body = JSON.parse(message.slice(start)); } catch { /* not JSON */ } }
  const error = body?.error || {};
  const details = Array.isArray(error.details) ? error.details : [];
  const quotaIds = details.flatMap(d => (d.violations || []).map(v => v.quotaId || v.quotaMetric).filter(Boolean));
  const delay = details.find(d => String(d['@type'] || '').endsWith('RetryInfo'))?.retryDelay;
  const retryAfter = delay ? Math.ceil(parseFloat(delay)) : null;
  return { reason: error.status || null, quotaIds, retryAfter: Number.isFinite(retryAfter) ? retryAfter : null };
}

/** Maps SDK errors to responses that never echo upstream messages (which could carry request details). */
function mapError(err) {
  const status = err instanceof ApiError ? err.status : null;
  const message = String(err?.message || '');
  if (status === 429) {
    // Only a spent *daily* quota pauses the advisor; per-minute limits are temporary.
    const info = googleErrorInfo(err);
    if (info.quotaIds.some(id => /PerDay/i.test(id))) {
      return [402, { code: 'limit_reached', error: 'The AI advisor has reached its demo usage limit.' }];
    }
    const retryAfter = Math.min(Math.max(info.retryAfter || 30, 1), 120);
    return [429, { code: 'rate_limited', error: 'The AI advisor is busy. Try again shortly.', retryAfter }, { 'Retry-After': String(retryAfter) }];
  }
  if (status === 401 || status === 403 || (status === 400 && /api key/i.test(message))) {
    return [503, { code: 'not_configured', error: 'The AI advisor is not configured correctly.' }];
  }
  if (status === 400 || status === 404) {
    return [400, { code: 'bad_request', error: 'The conversation could not be processed. Start a new conversation.' }];
  }
  if (status >= 500) return [503, { code: 'upstream_busy', error: 'The AI service is temporarily unavailable.' }];
  if (!status && /fetch failed|network|ECONN|ENOTFOUND|timed? ?out|abort/i.test(message)) {
    return [502, { code: 'upstream_unreachable', error: 'Could not reach the AI service.' }];
  }
  return [502, { code: 'upstream_error', error: 'The AI advisor could not answer right now.' }];
}

function thinkingLevel(value) {
  return ThinkingLevel[String(value || THINKING_LEVEL).toUpperCase()] || ThinkingLevel.LOW;
}

function createHandler({ client, env = process.env, rateLimiter = createRateLimiter(RATE_LIMIT) } = {}) {
  let lazyClient = client;
  return async function handler(req, res) {
    if (req.method !== 'POST') return send(res, 405, { code: 'method_not_allowed', error: 'Use POST.' }, { Allow: 'POST' });
    if (!originAllowed(req)) return send(res, 403, { code: 'forbidden_origin', error: 'Origin not allowed.' });
    if (env.ADVISOR_DISABLED === '1' || env.ADVISOR_DISABLED === 'true') {
      return send(res, 402, { code: 'limit_reached', error: 'The AI advisor has reached its demo usage limit.' });
    }
    if (!lazyClient && !env.GEMINI_API_KEY) return send(res, 503, { code: 'not_configured', error: 'The AI advisor is not configured.' });

    const limit = rateLimiter(clientIp(req));
    if (!limit.ok) return send(res, 429, { code: 'rate_limited', error: 'Too many requests. Try again shortly.', retryAfter: limit.retryAfter }, { 'Retry-After': String(limit.retryAfter) });

    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { return send(res, 400, { code: 'bad_request', error: 'Body must be JSON.' }); } }
    if (!body || typeof body !== 'object') return send(res, 400, { code: 'bad_request', error: 'Body must be JSON.' });
    if (Buffer.byteLength(JSON.stringify(body)) > MAX_BODY_BYTES) return send(res, 413, { code: 'too_large', error: 'Conversation is too large. Start a new conversation.' });
    const invalid = validateMessages(body.messages);
    if (invalid) return send(res, 400, { code: 'bad_request', error: invalid });

    lazyClient ||= new GoogleGenAI({ apiKey: env.GEMINI_API_KEY, httpOptions: { timeout: 30_000 } });
    try {
      const response = await lazyClient.models.generateContent({
        model: env.ADVISOR_MODEL || MODEL,
        contents: toGeminiContents(body.messages),
        config: {
          systemInstruction: SYSTEM_PROMPT,
          tools: [{ functionDeclarations: FUNCTION_DECLARATIONS }],
          toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO } },
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          thinkingConfig: { thinkingLevel: thinkingLevel(env.GEMINI_THINKING_LEVEL) },
        },
      });
      const out = fromGeminiResponse(response);
      return send(res, 200, { ...out, usage: response.usageMetadata || null });
    } catch (err) {
      const [status, payload, headers] = mapError(err);
      const info = googleErrorInfo(err);
      console.error('[advisor] upstream error', err?.status || err?.name, info.reason || '', info.quotaIds.join(',') || '', info.retryAfter ?? '');
      return send(res, status, payload, headers);
    }
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
module.exports.SYSTEM_PROMPT = SYSTEM_PROMPT;
module.exports.validateMessages = validateMessages;
module.exports.toGeminiContents = toGeminiContents;
module.exports.fromGeminiResponse = fromGeminiResponse;
