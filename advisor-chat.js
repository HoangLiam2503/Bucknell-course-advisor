/* In-portal AI advisor chat.
   Runs the tool-use loop in the browser: /api/advisor relays each turn to Gemini,
   tool calls run against the portal's own handlers, and results are rendered as cards.
   History is append-only (never edited) so the model's thinking blocks stay valid. */

const MAX_ROUNDS = 6;
const MAX_HISTORY = 70;
const REQUEST_TIMEOUT_MS = 60_000;
const LIMIT_KEY = 'advisorLimitReached';

const TOOL_LABELS = {
  get_student_profile: 'Reading your profile…',
  search_courses: 'Searching the catalog…',
  check_eligibility: 'Checking eligibility…',
  build_schedule: 'Building a draft schedule…',
  suggest_alternatives: 'Finding alternatives…',
  swap_draft_course: 'Updating the draft…',
  explain_course_impact: 'Checking graduation impact…',
  register_course: 'Preparing registration for your review…',
  drop_course: 'Preparing the drop request…',
  join_waitlist: 'Preparing the waitlist request…',
  get_degree_audit: 'Checking your degree audit…',
  get_phase1_recommendations: 'Ranking Spring 2026–27 courses…',
  get_schedule: 'Reading your schedule…',
  update_preferences: 'Saving your preferences…',
};

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
const plain = (text) => String(text).replace(/\*\*(.+?)\*\*/g, '$1').replace(/^#{1,6}\s+/gm, '').trim();

function storage(fn) { try { return fn(window.sessionStorage); } catch { return null; } }

class AdvisorHttpError extends Error {
  constructor(status, payload) { super(payload?.error || `HTTP ${status}`); this.status = status; this.payload = payload || {}; }
}

/**
 * @param {object} o
 * @param {Record<string, Function>} o.handlers  tool name -> async (input, {channel:'chat'}) => result object
 * @param {object} o.actions  portal actions used by card buttons
 * @param {(text:string)=>Promise<string>} o.offlineReply  rule-based fallback when the AI service is unavailable
 * @param {()=>string} o.getContext  one-line portal context added to the first message of a conversation
 */
export function createAdvisorChat({ endpoint = '/api/advisor', handlers, actions, offlineReply, getContext }) {
  const $ = (id) => document.getElementById(id);
  const thread = $('advisorThread'), input = $('advisorInput'), sendBtn = $('advisorSend'), form = $('advisorForm');
  const welcomeHtml = thread.innerHTML;

  let messages = [];
  let pendingEvents = [];
  let busy = false, controller = null, offline = false, generation = 0;
  let locked = storage(s => s.getItem(LIMIT_KEY) === '1') === true;

  // ---------- Rendering ----------
  function scroll() { thread.scrollTop = thread.scrollHeight; }
  function bubble(role, text) {
    const el = document.createElement('div');
    el.className = `advisor-msg ${role}`;
    el.textContent = role === 'ai' ? plain(text) : text;
    thread.appendChild(el); scroll();
    return el;
  }
  function notice(text, tone = '') {
    const el = document.createElement('div');
    el.className = `advisor-notice ${tone}`;
    el.setAttribute('role', tone === 'error' ? 'alert' : 'status');
    el.textContent = text;
    thread.appendChild(el); scroll();
    return el;
  }
  function card(html) {
    const el = document.createElement('div');
    el.className = 'advisor-card';
    el.innerHTML = html;
    thread.appendChild(el); scroll();
    return el;
  }

  let typingEl = null;
  function typing(label) {
    if (!typingEl) {
      typingEl = document.createElement('div');
      typingEl.className = 'advisor-typing';
      typingEl.setAttribute('role', 'status');
      thread.appendChild(typingEl);
    }
    typingEl.innerHTML = `<span class="dots" aria-hidden="true"><i></i><i></i><i></i></span><span>${esc(label)}</span>`;
    scroll();
  }
  function stopTyping() { typingEl?.remove(); typingEl = null; }

  function setBusy(on) {
    busy = on;
    sendBtn.textContent = on ? '■' : '↑';
    sendBtn.setAttribute('aria-label', on ? 'Stop the advisor' : 'Send message');
    sendBtn.classList.toggle('stop', on);
    input.disabled = on || locked;
  }

  function lock() {
    locked = true;
    storage(s => s.setItem(LIMIT_KEY, '1'));
    input.disabled = true; sendBtn.disabled = true;
    input.placeholder = 'AI advisor paused — demo usage limit reached';
    thread.querySelectorAll('[data-advisor-prompt]').forEach(b => { b.disabled = true; });
  }

  // ---------- Cards built from structured tool results ----------
  function draftCard() {
    const d = actions.getDraft();
    if (!d || !d.courses.length) return;
    const rows = d.courses.map(c => `
      <li><div class="row"><code>${esc(c.code)}</code><b>${esc(c.title)}</b><span class="cr">${c.credits} cr</span></div>
        <div class="meta">${esc(c.schedule)} · ${c.seatsOpen} seat${c.seatsOpen === 1 ? '' : 's'} open · ~${c.weeklyHours} h/wk</div>
        <div class="tag ${c.requirementKind}">${esc(c.requirement)}</div></li>`).join('');
    const el = card(`<div class="hd"><span class="kind draft">Draft · no seats held</span><span>${d.totalCredits} credits · ~${d.weeklyHours} h/wk (${esc(d.workloadBand)})</span></div>
      <ul>${rows}</ul>
      <p class="src">${esc(d.dataSource)}</p>
      <div class="acts"><button type="button" class="btn btn-ghost btn-sm" data-act="view">View on Registration</button>
        <button type="button" class="btn btn-primary btn-sm" data-act="register">Review &amp; register</button></div>`);
    el.querySelector('[data-act="view"]').onclick = () => actions.showView('registration');
    el.querySelector('[data-act="register"]').onclick = (e) => confirmFlow({ action: 'register', courseCodes: d.courses.map(c => c.code) }, e.currentTarget);
  }

  function recommendationCard(result) {
    const recs = (result.recommendations || []).slice(0, 5);
    if (!recs.length) { notice('No eligible Spring recommendations matched this scenario.'); return; }
    const items = recs.map((r, i) => `
      <li><div class="row"><span class="rank">${i + 1}</span><code>${esc(r.code)}</code><b>${esc(r.title)}</b></div>
        <div class="meta">Sec ${esc(r.section)} · ${esc(r.meeting)} · ${r.usableSeats} usable seat${r.usableSeats === 1 ? '' : 's'}</div>
        <div class="why">${esc((r.reasons || [])[0] || '')}</div>
        ${(r.cautions || []).slice(0, 1).map(c => `<div class="warn">${esc(c)}</div>`).join('')}</li>`).join('');
    const el = card(`<div class="hd"><span class="kind rec">Spring 2026–27 · snapshot</span><span>top ${recs.length}</span></div>
      <ul>${items}</ul><p class="src">${esc(result.dataSource || '')}</p>
      <div class="acts"><button type="button" class="btn btn-ghost btn-sm" data-act="open">Open Smart Recommendations</button></div>`);
    el.querySelector('[data-act="open"]').onclick = () => actions.showView('recommendations');
  }

  function alternativesCard(result) {
    if (!result.options?.length) return;
    const items = result.options.map(o => `
      <li><div class="row"><code>${esc(o.code)}</code><b>${esc(o.title)}</b><span class="cr">${o.credits} cr</span></div>
        <div class="meta">${esc(o.schedule)} · ${o.seatsOpen} seats · ~${o.weeklyHours} h/wk</div>
        <div class="tag ${o.requirementKind}">${esc(o.requirement)}</div>
        <div class="why">${esc((o.tradeoffs || []).join(' '))}</div>
        <div class="acts"><button type="button" class="btn btn-ghost btn-sm" data-take="${esc(o.code)}">Use ${esc(o.code)}</button></div></li>`).join('');
    const el = card(`<div class="hd"><span class="kind draft">Replace ${esc(result.replacing)}</span><span>others stay fixed</span></div><ul>${items}</ul>`);
    el.querySelectorAll('[data-take]').forEach(btn => btn.onclick = () => {
      const out = actions.swap(result.replacing, btn.dataset.take);
      el.querySelectorAll('[data-take]').forEach(b => { b.disabled = true; });
      const ok = out && typeof out === 'object';
      notice(ok ? `Draft updated: ${result.replacing} → ${btn.dataset.take}. No seats held.` : String(out), ok ? '' : 'error');
      if (ok) { pendingEvents.push(`Student replaced ${result.replacing} with ${btn.dataset.take} in the draft using the card.`); draftCard(); }
    });
  }

  function confirmationCard(result) {
    const verb = { register: 'Review & register', drop: 'Review & drop', waitlist: result.leave ? 'Review & leave waitlist' : 'Review & join waitlist' }[result.action];
    const el = card(`<div class="hd"><span class="kind gated">Needs your confirmation</span></div>
      <p class="body">${esc(result.summary)}</p>
      <div class="acts"><button type="button" class="btn btn-primary btn-sm" data-act="confirm">${esc(verb)}</button></div>`);
    el.querySelector('[data-act="confirm"]').onclick = (e) => confirmFlow(result, e.currentTarget);
  }

  async function confirmFlow(request, button) {
    button.disabled = true;
    const outcome = await actions.confirm(request);
    notice(outcome.message, outcome.changed ? 'ok' : '');
    pendingEvents.push(`${outcome.changed ? 'Student confirmed' : 'No change'}: ${outcome.message}`);
    if (!outcome.changed) button.disabled = false;
  }

  function renderToolCard(name, result) {
    if (!result || typeof result !== 'object') return;
    if (result.awaitingConfirmation) return confirmationCard(result);
    if ((name === 'build_schedule' || name === 'swap_draft_course') && !result.error) return draftCard();
    if (name === 'get_phase1_recommendations') return recommendationCard(result);
    if (name === 'suggest_alternatives') return alternativesCard(result);
  }

  // ---------- Network ----------
  async function post(body) {
    controller = new AbortController();
    const timer = setTimeout(() => controller.abort('timeout'), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal });
      const text = await res.text();
      let payload = null;
      try { payload = JSON.parse(text); } catch { /* static hosts answer with HTML */ }
      if (!res.ok || !payload) throw new AdvisorHttpError(res.status, payload);
      return payload;
    } finally { clearTimeout(timer); }
  }

  async function runTools(blocks) {
    const results = [];
    for (const block of blocks) {
      typing(TOOL_LABELS[block.name] || 'Working…');
      const handler = handlers[block.name];
      try {
        if (!handler) throw new Error(`Unknown tool ${block.name}.`);
        const result = await handler(block.input || {}, { channel: 'chat' });
        renderToolCard(block.name, result);
        results.push({ type: 'tool_result', tool_use_id: block.id, content: typeof result === 'string' ? result : JSON.stringify(result) });
      } catch (err) {
        console.error(err);
        results.push({ type: 'tool_result', tool_use_id: block.id, content: `Tool failed: ${err.message}`, is_error: true });
      }
    }
    return results;
  }

  // ---------- Conversation ----------
  async function useOffline(text, reason) {
    if (!offline) notice(reason || 'AI service unavailable — using the basic offline assistant.', 'warn');
    offline = true;
    bubble('ai', await offlineReply(text));
  }

  async function ask(text) {
    const clean = text.trim();
    if (!clean || busy) return;
    if (locked) { notice('The AI advisor has reached its demo usage limit and is paused.', 'error'); return; }
    bubble('user', clean);
    input.value = '';
    if (offline) { setBusy(true); try { await useOffline(clean); } finally { setBusy(false); input.focus(); } return; }
    if (messages.length >= MAX_HISTORY) { notice('This conversation is getting long. Start a new conversation to keep going.', 'warn'); return; }

    const gen = generation, checkpoint = messages.length, eventsBefore = pendingEvents;
    const content = [];
    if (!messages.length) content.push({ type: 'text', text: `[Portal context] ${getContext()}` });
    for (const e of pendingEvents) content.push({ type: 'text', text: `[Portal event] ${e}` });
    pendingEvents = [];
    content.push({ type: 'text', text: clean });
    messages.push({ role: 'user', content });

    setBusy(true);
    typing('Thinking…');
    let rolledBack = false;
    const rollback = () => { messages = messages.slice(0, checkpoint); pendingEvents = [...eventsBefore, ...pendingEvents]; rolledBack = true; };
    try {
      for (let round = 0; ; round++) {
        const data = await post({ messages });
        if (gen !== generation) return; // conversation was reset while waiting
        const textOut = data.content.filter(b => b.type === 'text' && b.text.trim()).map(b => b.text).join('\n\n');
        if (data.stop_reason === 'refusal') { rollback(); stopTyping(); bubble('ai', 'I can’t help with that here. I can help with courses, requirements and your schedule.'); break; }
        if (data.stop_reason === 'error') { rollback(); stopTyping(); notice('The advisor had trouble with that request. Try rephrasing it.', 'warn'); break; }
        messages.push({ role: 'assistant', content: data.content });
        const toolCalls = data.content.filter(b => b.type === 'tool_use');
        if (data.stop_reason === 'tool_use' && toolCalls.length) {
          if (textOut) { stopTyping(); bubble('ai', textOut); }
          if (round + 1 >= MAX_ROUNDS) {
            messages.push({ role: 'user', content: toolCalls.map(b => ({ type: 'tool_result', tool_use_id: b.id, content: 'Step limit reached for this question; the tool was not run.', is_error: true })) });
            stopTyping(); notice('I stopped after several steps. Ask me to continue if you need more.', 'warn');
            break;
          }
          const results = await runTools(toolCalls);
          if (gen !== generation) return;
          messages.push({ role: 'user', content: results });
          typing('Thinking…');
          continue;
        }
        stopTyping();
        if (textOut) bubble('ai', textOut);
        if (data.stop_reason === 'max_tokens') notice('That answer was cut short. Ask me to continue.', 'warn');
        else if (!textOut) notice('The advisor returned no text. Try rephrasing.', 'warn');
        break;
      }
    } catch (err) {
      if (gen !== generation) return;
      stopTyping();
      if (!rolledBack) rollback();
      const status = err instanceof AdvisorHttpError ? err.status : 0;
      const code = err instanceof AdvisorHttpError ? err.payload.code : null;
      if (code === 'limit_reached') { notice('The AI advisor has reached its demo usage limit and is paused. Portal registration still works normally.', 'error'); lock(); }
      else if (code === 'rate_limited') notice(`The advisor is busy. Try again in about ${err.payload.retryAfter || 30} seconds.`, 'warn');
      else if (code === 'bad_request' || status === 413) notice(`${err.payload.error || 'That conversation could not be processed.'}`, 'error');
      else if (controller?.signal.aborted && controller.signal.reason !== 'timeout') notice('Stopped.', '');
      else if (controller?.signal.aborted) notice('The advisor took too long to answer. Try again.', 'error');
      else if (code === 'not_configured' || !code) { messages = messages.slice(0, checkpoint); await useOffline(clean); }
      else notice(err.payload?.error || 'The advisor could not answer right now. Try again.', 'error');
    } finally {
      if (gen === generation) {
        controller = null;
        setBusy(false);
        if (!locked) input.focus();
      }
    }
  }

  function reset() {
    generation++;
    controller?.abort('user');
    controller = null; typingEl = null;
    messages = []; pendingEvents = []; offline = false;
    setBusy(false);
    thread.innerHTML = welcomeHtml;
    wireChips();
    if (locked) lock();
  }

  function wireChips() {
    thread.querySelectorAll('[data-advisor-prompt]').forEach(b => b.addEventListener('click', () => ask(b.dataset.advisorPrompt)));
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (busy) { controller?.abort('user'); return; }
    ask(input.value);
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!busy) form.requestSubmit(); } });
  $('advisorReset')?.addEventListener('click', reset);
  wireChips();
  if (locked) lock();

  return { ask, reset, addEvent: (text) => pendingEvents.push(text) };
}
