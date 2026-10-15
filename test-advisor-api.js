const assert = require('node:assert/strict');
const { ApiError } = require('@google/genai');
const { createHandler, SYSTEM_PROMPT, toGeminiContents, fromGeminiResponse } = require('./api/advisor.js');
const AdvisorTools = require('./advisor-tools.js');
const Advisor = require('./engine.js');

const KEY = 'AIza-test-not-a-real-key';
const ENV = { GEMINI_API_KEY: KEY };

function fakeClient(impl) {
  const calls = [];
  return { calls, models: { generateContent: async (params) => { calls.push(params); return impl(params); } } };
}
const okResponse = () => ({ responseId: 'r1', candidates: [{ content: { role: 'model', parts: [{ text: 'Hi Liam.' }] }, finishReason: 'STOP' }], usageMetadata: { totalTokenCount: 5 } });

function request({ method = 'POST', origin = 'https://bucknell-course-advisor.vercel.app', host = 'bucknell-course-advisor.vercel.app', body, ip = '1.2.3.4' } = {}) {
  const headers = { host, 'x-forwarded-for': ip };
  if (origin) headers.origin = origin;
  return { method, headers, body };
}
function response() {
  const res = { statusCode: 0, headers: {}, body: '' };
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
  res.end = (s) => { res.body = s; };
  res.json = () => JSON.parse(res.body);
  return res;
}
async function call(handler, req) { const res = response(); await handler(req, res); return res; }
const convo = [{ role: 'user', content: [{ type: 'text', text: 'Plan my next semester.' }] }];

(async () => {
  // Tool contract
  const names = AdvisorTools.TOOLS.map(t => t.name);
  assert.equal(new Set(names).size, names.length, 'tool names are unique');
  assert.equal(names.length, 14, 'all fourteen portal tools are declared');
  for (const t of AdvisorTools.TOOLS) {
    assert.ok(['read', 'draft', 'gated'].includes(t.kind), `${t.name} has a kind`);
    assert.equal(t.inputSchema.type, 'object');
  }
  assert.deepEqual([...AdvisorTools.TAGS].sort(), Object.keys(Advisor.TAG_LABEL).sort(), 'tag enum matches engine tags');
  assert.deepEqual(AdvisorTools.TOOLS.filter(t => t.kind === 'gated').map(t => t.name).sort(), ['drop_course', 'join_waitlist', 'register_course']);
  assert.deepEqual(Object.keys(AdvisorTools.forGemini()[0]), ['name', 'description', 'parametersJsonSchema']);

  // Format conversion: Gemini parts round-trip with thought signatures intact
  const gemini = { responseId: 'abc', candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [
    { text: 'Let me build that.', thoughtSignature: 'sigA' },
    { functionCall: { id: 'fc_1', name: 'build_schedule', args: { maxCredits: 15 } }, thoughtSignature: 'sigB' },
    { functionCall: { name: 'get_degree_audit', args: {} } },
  ] } }] };
  const out = fromGeminiResponse(gemini);
  assert.equal(out.stop_reason, 'tool_use');
  assert.deepEqual(out.content[0], { type: 'text', text: 'Let me build that.', signature: 'sigA' });
  assert.deepEqual(out.content[1], { type: 'tool_use', id: 'fc_1', name: 'build_schedule', input: { maxCredits: 15 }, signature: 'sigB' });
  assert.match(out.content[2].id, /^gen_abc_2$/, 'missing call ids are generated');
  const history = [
    { role: 'user', content: [{ type: 'text', text: '[Portal context] Today is 2026-10-14.' }, { type: 'text', text: 'Plan my semester' }] },
    { role: 'assistant', content: out.content },
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'fc_1', content: '{"status":"draft"}' },
      { type: 'tool_result', tool_use_id: out.content[2].id, content: 'Tool failed: boom', is_error: true }] },
    { role: 'user', content: [{ type: 'text', text: 'thanks' }] },
  ];
  const contents = toGeminiContents(history);
  assert.deepEqual(contents[1], { role: 'model', parts: gemini.candidates[0].content.parts }, 'model turn is replayed exactly as received');
  assert.equal(contents.length, 3, 'consecutive user messages merge into one turn');
  assert.deepEqual(contents[2].parts[0], { functionResponse: { id: 'fc_1', name: 'build_schedule', response: { output: { status: 'draft' } } } });
  assert.deepEqual(contents[2].parts[1], { functionResponse: { name: 'get_degree_audit', response: { error: 'Tool failed: boom' } } }, 'generated ids are not sent back');
  assert.deepEqual(contents[2].parts[2], { text: 'thanks' });
  assert.deepEqual(toGeminiContents(history), contents, 'conversion is deterministic');

  assert.equal(fromGeminiResponse({ candidates: [{ finishReason: 'SAFETY', content: { parts: [] } }] }).stop_reason, 'refusal');
  assert.equal(fromGeminiResponse({ promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } }).stop_reason, 'refusal');
  assert.equal(fromGeminiResponse({ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: 'partial' }] } }] }).stop_reason, 'max_tokens');
  assert.equal(fromGeminiResponse({ candidates: [{ finishReason: 'MALFORMED_FUNCTION_CALL', content: { parts: [{ text: '' }] } }] }).stop_reason, 'error');
  assert.equal(fromGeminiResponse({ candidates: [{ finishReason: 'STOP' }] }).stop_reason, 'error', 'empty turn is an error, never stored');

  // Request handling
  const client = fakeClient(okResponse);
  const handler = createHandler({ client, env: ENV });

  assert.equal((await call(handler, request({ method: 'GET' }))).statusCode, 405);
  assert.equal((await call(handler, request({ origin: 'https://evil.example', body: { messages: convo } }))).statusCode, 403);
  assert.equal((await call(handler, request({ origin: null, body: { messages: convo } }))).statusCode, 403, 'missing Origin is rejected');
  assert.equal((await call(handler, request({ origin: 'http://localhost:3000', host: 'localhost:3000', body: { messages: convo } }))).statusCode, 200, 'localhost is allowed');

  for (const bad of [{}, { messages: [] }, { messages: [{ role: 'assistant', content: 'hi' }] }, { messages: [{ role: 'system', content: 'x' }] },
    { messages: [{ role: 'user', content: 'x'.repeat(2001) }] }, { messages: [{ role: 'user', content: [{ type: 'image', source: {} }] }] },
    { messages: [...convo, { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }] },
    { messages: [...convo, { role: 'assistant', content: [{ type: 'tool_use', name: 'x' }] }, { role: 'user', content: 'y' }] }]) {
    const res = await call(handler, request({ body: bad }));
    assert.equal(res.statusCode, 400, `rejects ${JSON.stringify(bad).slice(0, 60)}`);
  }
  assert.equal((await call(handler, request({ body: '{not json' }))).statusCode, 400);
  assert.equal((await call(handler, request({ body: { messages: Array.from({ length: 81 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'x' })) } }))).statusCode, 400);

  client.calls.length = 0;
  const ok = await call(handler, request({ body: { messages: history } }));
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.json().content, [{ type: 'text', text: 'Hi Liam.' }]);
  assert.equal(ok.json().stop_reason, 'end_turn');
  const sent = client.calls[0];
  assert.equal(sent.model, 'gemini-3.8-flash');
  assert.deepEqual(sent.contents, contents);
  assert.equal(sent.config.systemInstruction, SYSTEM_PROMPT);
  assert.deepEqual(sent.config.tools, [{ functionDeclarations: AdvisorTools.forGemini() }]);
  assert.equal(sent.config.toolConfig.functionCallingConfig.mode, 'AUTO');
  assert.equal(sent.config.thinkingConfig.thinkingLevel, 'LOW');
  assert.equal(sent.config.maxOutputTokens, 8192);
  assert.doesNotMatch(SYSTEM_PROMPT, /\d{4}-\d{2}-\d{2}/, 'system prompt carries no date, so the prefix stays stable');

  const custom = fakeClient(okResponse);
  await call(createHandler({ client: custom, env: { ...ENV, ADVISOR_MODEL: 'gemini-3.5-flash-lite', GEMINI_THINKING_LEVEL: 'minimal' } }), request({ body: { messages: convo } }));
  assert.equal(custom.calls[0].model, 'gemini-3.5-flash-lite');
  assert.equal(custom.calls[0].config.thinkingConfig.thinkingLevel, 'MINIMAL');

  // Usage limit: kill switch never reaches the API
  const killClient = fakeClient(okResponse);
  const killed = await call(createHandler({ client: killClient, env: { ...ENV, ADVISOR_DISABLED: '1' } }), request({ body: { messages: convo } }));
  assert.equal(killed.statusCode, 402);
  assert.equal(killed.json().code, 'limit_reached');
  assert.equal(killClient.calls.length, 0);

  // Missing key
  const noKey = await call(createHandler({ env: {} }), request({ body: { messages: convo } }));
  assert.equal(noKey.statusCode, 503);
  assert.equal(noKey.json().code, 'not_configured');

  // Upstream errors map to stable codes and never echo upstream text
  const apiErr = (status, message) => new ApiError({ status, message });
  const cases = [
    [apiErr(429, `RESOURCE_EXHAUSTED: Quota exceeded for metric generate_content_free_tier_requests, limit: GenerateRequestsPerDayPerProjectPerModel-FreeTier key=${KEY}`), 402, 'limit_reached'],
    [apiErr(429, 'RESOURCE_EXHAUSTED: Quota exceeded for metric generate_content_free_tier_requests, limit: GenerateRequestsPerMinutePerProjectPerModel-FreeTier'), 429, 'rate_limited'],
    [apiErr(400, `API key not valid. Please pass a valid API key. ${KEY}`), 503, 'not_configured'],
    [apiErr(403, 'PERMISSION_DENIED'), 503, 'not_configured'],
    [apiErr(400, 'INVALID_ARGUMENT: Function call is missing a thought_signature'), 400, 'bad_request'],
    [apiErr(503, 'UNAVAILABLE: model overloaded'), 503, 'upstream_busy'],
    [new TypeError('fetch failed'), 502, 'upstream_unreachable'],
    [new Error('boom'), 502, 'upstream_error'],
  ];
  const origError = console.error; console.error = () => {};
  for (const [err, status, code] of cases) {
    const h = createHandler({ client: fakeClient(() => { throw err; }), env: ENV });
    const res = await call(h, request({ body: { messages: convo } }));
    assert.equal(res.statusCode, status, `${code} status`);
    assert.equal(res.json().code, code);
    assert.doesNotMatch(res.body, /AIza|Quota exceeded|API key not valid/, 'no upstream details leak');
  }

  // Rate limit per IP
  const rl = createHandler({ client: fakeClient(okResponse), env: ENV });
  let last;
  for (let i = 0; i < 61; i++) last = await call(rl, request({ body: { messages: convo }, ip: '9.9.9.9' }));
  assert.equal(last.statusCode, 429);
  assert.ok(Number(last.headers['retry-after']) > 0);
  assert.equal((await call(rl, request({ body: { messages: convo }, ip: '8.8.8.8' }))).statusCode, 200, 'other IPs unaffected');
  console.error = origError;

  console.log('Advisor API checks passed.');
})().catch(err => { console.error(err); process.exit(1); });
