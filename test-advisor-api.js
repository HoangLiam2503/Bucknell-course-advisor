const assert = require('node:assert/strict');
const Anthropic = require('@anthropic-ai/sdk').default;
const { createHandler, SYSTEM_PROMPT } = require('./api/advisor.js');
const AdvisorTools = require('./advisor-tools.js');
const Advisor = require('./engine.js');

const KEY = 'sk-ant-test-not-a-real-key';
const ENV = { ANTHROPIC_API_KEY: KEY };

function fakeClient(impl) {
  const calls = [];
  return { calls, messages: { create: async (params) => { calls.push(params); return impl(params); } } };
}
const okResponse = () => ({ content: [{ type: 'text', text: 'Hi Liam.' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 3 } });

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
  assert.deepEqual(Object.keys(AdvisorTools.forClaude()[0]), ['name', 'description', 'input_schema']);

  // Request handling
  const client = fakeClient(okResponse);
  const handler = createHandler({ client, env: ENV });

  assert.equal((await call(handler, request({ method: 'GET' }))).statusCode, 405);
  assert.equal((await call(handler, request({ origin: 'https://evil.example', body: { messages: convo } }))).statusCode, 403);
  assert.equal((await call(handler, request({ origin: null, body: { messages: convo } }))).statusCode, 403, 'missing Origin is rejected');
  assert.equal((await call(handler, request({ origin: 'http://localhost:3000', host: 'localhost:3000', body: { messages: convo } }))).statusCode, 200, 'localhost is allowed');

  for (const bad of [{}, { messages: [] }, { messages: [{ role: 'assistant', content: 'hi' }] }, { messages: [{ role: 'system', content: 'x' }] },
    { messages: [{ role: 'user', content: 'x'.repeat(2001) }] }, { messages: [{ role: 'user', content: [{ type: 'image', source: {} }] }] },
    { messages: [...convo, { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }] }]) {
    const res = await call(handler, request({ body: bad }));
    assert.equal(res.statusCode, 400, `rejects ${JSON.stringify(bad).slice(0, 60)}`);
  }
  assert.equal((await call(handler, request({ body: '{not json' }))).statusCode, 400);
  assert.equal((await call(handler, request({ body: { messages: Array.from({ length: 81 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'x' })) } }))).statusCode, 400);

  client.calls.length = 0;
  const history = [
    { role: 'user', content: [{ type: 'text', text: '[Portal context] Today is 2026-10-14.' }, { type: 'text', text: 'Plan my semester' }] },
    { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'sig-abc' }, { type: 'tool_use', id: 'tu_1', name: 'build_schedule', input: { maxCredits: 15 } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: '{"status":"draft"}' }] },
  ];
  const snapshot = JSON.stringify(history);
  const ok = await call(handler, request({ body: { messages: history } }));
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.json().content, [{ type: 'text', text: 'Hi Liam.' }]);
  const sent = client.calls[0];
  assert.equal(sent.model, 'claude-sonnet-5-5');
  assert.deepEqual(sent.output_config, { effort: 'medium' });
  assert.deepEqual(sent.cache_control, { type: 'ephemeral' });
  assert.equal(sent.system, SYSTEM_PROMPT);
  assert.deepEqual(sent.tools, AdvisorTools.forClaude());
  assert.equal(sent.thinking, undefined, 'thinking is left to the model default');
  assert.equal(sent.fallbacks, undefined, 'no fallback to a pricier model');
  assert.equal(sent.betas, undefined);
  assert.equal(JSON.stringify(sent.messages), snapshot, 'history is forwarded unchanged (append-only)');
  assert.doesNotMatch(SYSTEM_PROMPT, /\d{4}-\d{2}-\d{2}/, 'system prompt carries no date, so the cached prefix stays stable');

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
  const headers = new Headers({ 'retry-after': '12' });
  const cases = [
    [Anthropic.APIError.generate(402, { error: { type: 'billing_error', message: `spend limit for ${KEY}` } }, `402 spend limit for ${KEY}`, headers), 402, 'limit_reached'],
    [Anthropic.APIError.generate(400, { error: { type: 'invalid_request_error', message: 'Your credit balance is too low' } }, 'Your credit balance is too low', headers), 402, 'limit_reached'],
    [Anthropic.APIError.generate(401, { error: { type: 'authentication_error', message: 'invalid x-api-key' } }, `invalid ${KEY}`, headers), 503, 'not_configured'],
    [Anthropic.APIError.generate(429, { error: { type: 'rate_limit_error', message: 'slow down' } }, 'slow down', headers), 429, 'rate_limited'],
    [Anthropic.APIError.generate(529, { error: { type: 'overloaded_error', message: 'busy' } }, 'busy', headers), 503, 'upstream_busy'],
    [Anthropic.APIError.generate(400, { error: { type: 'invalid_request_error', message: 'bad thinking block' } }, 'bad thinking block', headers), 400, 'bad_request'],
    [new Anthropic.APIConnectionError({ message: 'socket hang up' }), 502, 'upstream_unreachable'],
    [new Error('boom'), 502, 'upstream_error'],
  ];
  const origError = console.error; console.error = () => {};
  for (const [err, status, code] of cases) {
    const h = createHandler({ client: fakeClient(() => { throw err; }), env: ENV });
    const res = await call(h, request({ body: { messages: convo } }));
    assert.equal(res.statusCode, status, `${code} status`);
    assert.equal(res.json().code, code);
    assert.doesNotMatch(res.body, /sk-ant|x-api-key|spend limit for/, 'no upstream details leak');
  }
  console.error = origError;
  const limited = await call(createHandler({ client: fakeClient(() => { throw cases[3][0]; }), env: ENV }), request({ body: { messages: convo } }));
  assert.equal(limited.headers['retry-after'], '12');

  // Rate limit per IP
  const rl = createHandler({ client: fakeClient(okResponse), env: ENV });
  let last;
  for (let i = 0; i < 61; i++) last = await call(rl, request({ body: { messages: convo }, ip: '9.9.9.9' }));
  assert.equal(last.statusCode, 429);
  assert.ok(Number(last.headers['retry-after']) > 0);
  assert.equal((await call(rl, request({ body: { messages: convo }, ip: '8.8.8.8' }))).statusCode, 200, 'other IPs unaffected');

  console.log('Advisor API checks passed.');
})().catch(err => { console.error(err); process.exit(1); });
