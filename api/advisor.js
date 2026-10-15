/* POST /api/advisor — thin proxy between the in-portal chat and the Claude Messages API.
   The browser owns state and runs the tools; this function owns the API key, the system
   prompt and the tool list, so the client cannot change guardrails. It never edits the
   conversation it is given: history must stay append-only for thinking blocks to stay valid. */
const Anthropic = require('@anthropic-ai/sdk').default;
const AdvisorTools = require('../advisor-tools.js');

const MODEL = process.env.ADVISOR_MODEL || 'claude-sonnet-5-5';
const EFFORT = process.env.ADVISOR_EFFORT || 'medium';
const MAX_TOKENS = 16000;
const MAX_BODY_BYTES = 300 * 1024;
const MAX_MESSAGES = 80;
const MAX_USER_TEXT = 2000;
const RATE_LIMIT = { requests: 60, windowMs: 10 * 60 * 1000 };

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

const TOOLS = AdvisorTools.forClaude();

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

/** Best-effort, per-instance limiter. The hard spend cap is the Anthropic Console spend limit. */
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
  if (messages[0].role !== 'user') return 'The first message must come from the user.';
  if (messages[messages.length - 1].role !== 'user') return 'The last message must come from the user.';
  for (const m of messages) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) return 'Each message role must be user or assistant.';
    if (typeof m.content === 'string') {
      if (m.role === 'user' && m.content.length > MAX_USER_TEXT) return `Messages are limited to ${MAX_USER_TEXT} characters.`;
      continue;
    }
    if (!Array.isArray(m.content) || !m.content.length) return 'Each message needs content.';
    for (const block of m.content) {
      if (!block || typeof block.type !== 'string') return 'Invalid content block.';
      if (m.role === 'user') {
        if (block.type === 'text' && String(block.text || '').length > MAX_USER_TEXT) return `Messages are limited to ${MAX_USER_TEXT} characters.`;
        if (!['text', 'tool_result'].includes(block.type)) return `Unsupported user content type: ${block.type}.`;
      }
    }
  }
  return null;
}

/** Maps SDK errors to responses that never echo upstream messages (which could carry request details). */
function mapError(err) {
  if (err instanceof Anthropic.APIError) {
    const status = err.status;
    const type = err.type || err.error?.error?.type;
    // A spent workspace limit or empty balance is a 402 billing_error; older responses used a 400
    // with a credit-balance message, so that wording is matched as well.
    if (status === 402 || type === 'billing_error' || (status === 400 && /credit balance|spend(ing)? limit|usage limit/i.test(err.message || ''))) {
      return [402, { code: 'limit_reached', error: 'The AI advisor has reached its demo usage limit.' }];
    }
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
      return [503, { code: 'not_configured', error: 'The AI advisor is not configured correctly.' }];
    }
    if (err instanceof Anthropic.RateLimitError) {
      const retry = Number(err.headers?.get?.('retry-after')) || 30;
      return [429, { code: 'rate_limited', error: 'The AI advisor is busy. Try again shortly.', retryAfter: retry }, { 'Retry-After': String(retry) }];
    }
    if (err instanceof Anthropic.BadRequestError) {
      return [400, { code: 'bad_request', error: 'The conversation could not be processed. Start a new conversation.' }];
    }
    if (err instanceof Anthropic.APIConnectionError) {
      return [502, { code: 'upstream_unreachable', error: 'Could not reach the AI service.' }];
    }
    if (status === 529 || status >= 500) {
      return [503, { code: 'upstream_busy', error: 'The AI service is temporarily unavailable.' }];
    }
  }
  return [502, { code: 'upstream_error', error: 'The AI advisor could not answer right now.' }];
}

function createHandler({ client, env = process.env, rateLimiter = createRateLimiter(RATE_LIMIT) } = {}) {
  let lazyClient = client;
  return async function handler(req, res) {
    if (req.method !== 'POST') return send(res, 405, { code: 'method_not_allowed', error: 'Use POST.' }, { Allow: 'POST' });
    if (!originAllowed(req)) return send(res, 403, { code: 'forbidden_origin', error: 'Origin not allowed.' });
    if (env.ADVISOR_DISABLED === '1' || env.ADVISOR_DISABLED === 'true') {
      return send(res, 402, { code: 'limit_reached', error: 'The AI advisor has reached its demo usage limit.' });
    }
    if (!lazyClient && !env.ANTHROPIC_API_KEY) return send(res, 503, { code: 'not_configured', error: 'The AI advisor is not configured.' });

    const limit = rateLimiter(clientIp(req));
    if (!limit.ok) return send(res, 429, { code: 'rate_limited', error: 'Too many requests. Try again shortly.', retryAfter: limit.retryAfter }, { 'Retry-After': String(limit.retryAfter) });

    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { return send(res, 400, { code: 'bad_request', error: 'Body must be JSON.' }); } }
    if (!body || typeof body !== 'object') return send(res, 400, { code: 'bad_request', error: 'Body must be JSON.' });
    if (Buffer.byteLength(JSON.stringify(body)) > MAX_BODY_BYTES) return send(res, 413, { code: 'too_large', error: 'Conversation is too large. Start a new conversation.' });
    const invalid = validateMessages(body.messages);
    if (invalid) return send(res, 400, { code: 'bad_request', error: invalid });

    lazyClient ||= new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, timeout: 55_000, maxRetries: 1 });
    try {
      const response = await lazyClient.messages.create({
        model: env.ADVISOR_MODEL || MODEL,
        max_tokens: MAX_TOKENS,
        output_config: { effort: env.ADVISOR_EFFORT || EFFORT },
        cache_control: { type: 'ephemeral' },
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        messages: body.messages,
      });
      return send(res, 200, {
        content: response.content,
        stop_reason: response.stop_reason,
        stop_details: response.stop_details || null,
        usage: response.usage,
      });
    } catch (err) {
      const [status, payload, headers] = mapError(err);
      console.error('[advisor] upstream error', err?.status, err?.type || err?.name);
      return send(res, status, payload, headers);
    }
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
module.exports.SYSTEM_PROMPT = SYSTEM_PROMPT;
module.exports.validateMessages = validateMessages;
