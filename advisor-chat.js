/* In-portal AI advisor chat.
   Runs the tool-use loop in the browser: /api/advisor relays each turn to Gemini,
   tool calls run against the portal's own handlers, and results are rendered as cards.
   History is append-only (never edited) so the model's thinking blocks stay valid.
   The conversation is kept in sessionStorage so a reload does not lose it; demo state is
   not, so a restored conversation tells the model the page was reset. */

const MAX_ROUNDS = 6;
const MAX_HISTORY = 70;
const REQUEST_TIMEOUT_MS = 45_000;
const LIMIT_KEY = 'advisorLimitReached';
const CONVO_KEY = 'advisorConvo';
const MAX_SAVED_BYTES = 500_000;
const MAX_INPUT = 2000;

const F = window.AdvisorFormat;
const { esc } = F;
const CARD_NAMES = {
  build_schedule: 'draft schedule', swap_draft_course: 'draft schedule', get_phase1_recommendations: 'Spring recommendations',
  suggest_alternatives: 'alternatives', plan_spring_schedule: 'Spring plan', prepare_advisor_summary: 'advisor summary', confirm: 'confirmation request',
};

function storage(fn) { try { return fn(window.sessionStorage); } catch { return null; } }
const clock = (t = Date.now()) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

class AdvisorHttpError extends Error {
  constructor(status, payload) { super(payload?.error || `HTTP ${status}`); this.status = status; this.payload = payload || {}; }
}

/**
 * @param {object} o
 * @param {Record<string, Function>} o.handlers  tool name -> async (input, {channel:'chat'}) => result object
 * @param {object} o.actions  portal actions used by card buttons, code links and suggestions
 * @param {(text:string)=>Promise<string>} o.offlineReply  rule-based fallback when the AI service is unavailable
 * @param {()=>string} o.getContext  one-line portal context added to the first message of a conversation
 */
export function createAdvisorChat({ endpoint = '/api/advisor', handlers, actions, offlineReply, getContext }) {
  const $ = (id) => document.getElementById(id);
  const thread = $('advisorThread'), input = $('advisorInput'), sendBtn = $('advisorSend'), form = $('advisorForm'), counter = $('advisorCount');
  const welcomeHtml = thread.innerHTML;

  let messages = [];
  let transcript = [];
  let pendingEvents = [];
  let busy = false, controller = null, offline = false, generation = 0;
  let locked = storage(s => s.getItem(LIMIT_KEY) === '1') === true;
  let lastQuestion = '';

  // ---------- Rendering ----------
  function scroll() { thread.scrollTop = thread.scrollHeight; }
  function add(el) { thread.insertBefore(el, typingEl && typingEl.parentNode === thread ? typingEl : null); scroll(); return el; }
  function record(entry) { transcript.push(entry); }

  function turn(role, text, t = Date.now()) {
    const el = document.createElement('div');
    el.className = `advisor-turn ${role}`;
    const body = role === 'ai' ? F.formatAnswer(text) : `<p>${esc(text)}</p>`;
    el.innerHTML = `<div class="who"><span>${role === 'ai' ? 'Advisor' : 'You'}</span><time>${clock(t)}</time></div><div class="txt">${body}</div>`;
    if (role === 'ai') {
      const acts = document.createElement('div');
      acts.className = 'turn-acts';
      acts.innerHTML = '<button type="button" class="turn-btn" data-copy>Copy</button>';
      el.appendChild(acts);
      el.dataset.text = text;
    }
    return add(el);
  }
  function bubble(role, text) {
    record({ k: role, text, t: Date.now() });
    const el = turn(role, text);
    if (role === 'ai') markLastAnswer(el);
    return el;
  }
  function markLastAnswer(el) {
    thread.querySelectorAll('[data-again]').forEach(b => b.remove());
    if (!lastQuestion || locked) return;
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'turn-btn'; b.dataset.again = ''; b.textContent = 'Ask again';
    el.querySelector('.turn-acts').appendChild(b);
  }
  function notice(text, tone = '', { save = true } = {}) {
    if (save) record({ k: 'notice', text, tone });
    const el = document.createElement('div');
    el.className = `advisor-notice ${tone}`;
    el.setAttribute('role', tone === 'error' ? 'alert' : 'status');
    el.textContent = text;
    return add(el);
  }
  function card(html, name) {
    record({ k: 'card', name });
    const el = document.createElement('div');
    el.className = 'advisor-card';
    el.innerHTML = html;
    return add(el);
  }
  function staleCard(name) {
    const el = document.createElement('div');
    el.className = 'advisor-card stale';
    el.textContent = `Earlier ${CARD_NAMES[name] || 'card'} — the page was reloaded, so ask again for a current one.`;
    return add(el);
  }

  // Step log: one collapsible list per question, showing every tool the advisor ran.
  let steps = null;
  function stepsBox() {
    if (steps) return steps;
    const el = document.createElement('details');
    el.className = 'advisor-steps'; el.open = true;
    el.innerHTML = '<summary>Working…</summary><ol></ol>';
    steps = { el, list: el.querySelector('ol'), items: [] };
    add(el);
    return steps;
  }
  function stepStart(name) {
    const box = stepsBox();
    const li = document.createElement('li');
    li.className = 'run';
    li.innerHTML = `<span class="lbl">${esc(F.stepLabel(name, 'running'))}…</span><span class="sum"></span>`;
    box.list.appendChild(li); scroll();
    const item = { label: F.stepLabel(name, 'done'), summary: '', ok: true };
    box.items.push(item);
    return (ok, summary) => {
      item.ok = ok; item.summary = summary;
      li.className = ok ? 'ok' : 'err';
      li.querySelector('.lbl').textContent = item.label;
      li.querySelector('.sum').textContent = summary || '';
    };
  }
  function renderStepsDone(el, items) {
    const failed = items.filter(i => !i.ok).length;
    el.querySelector('summary').textContent = `Checked ${items.length} thing${items.length === 1 ? '' : 's'}${failed ? ` · ${failed} failed` : ''}`;
    el.open = false;
  }
  function closeSteps() {
    if (!steps) return;
    renderStepsDone(steps.el, steps.items);
    record({ k: 'steps', items: steps.items });
    steps = null;
  }
  function restoreSteps(items) {
    const el = document.createElement('details');
    el.className = 'advisor-steps';
    el.innerHTML = `<summary></summary><ol>${items.map(i => `<li class="${i.ok ? 'ok' : 'err'}"><span class="lbl">${esc(i.label)}</span><span class="sum">${esc(i.summary || '')}</span></li>`).join('')}</ol>`;
    renderStepsDone(el, items);
    add(el);
  }

  let typingEl = null;
  function typing(label) {
    if (!typingEl) {
      typingEl = document.createElement('div');
      typingEl.className = 'advisor-typing';
      typingEl.setAttribute('role', 'status');
      thread.appendChild(typingEl);
    }
    typingEl.innerHTML = `<span class="bar" aria-hidden="true"></span><span>${esc(label)}</span>`;
    scroll();
  }
  function stopTyping() { typingEl?.remove(); typingEl = null; }

  function suggestions(list, { save = true } = {}) {
    thread.querySelectorAll('.advisor-chips.follow').forEach(el => el.remove());
    if (!list.length || locked) return;
    if (save) record({ k: 'chips', list });
    const el = document.createElement('div');
    el.className = 'advisor-chips follow';
    el.innerHTML = list.map(q => `<button type="button" class="advisor-chip" data-advisor-prompt="${esc(q)}">${esc(q)}</button>`).join('');
    add(el);
  }

  /** Welcome chips depend on the page the student is on; refreshed while the conversation is empty. */
  function refreshWelcome() {
    const box = thread.querySelector('[data-welcome-chips]');
    if (!box || transcript.length) return;
    const fixed = ['Plan my Spring 2026–27 semester: 4 courses including CSCI 204, nothing before 10am.', "I'm meeting my advisor this week. Prepare a summary with questions to ask."];
    const labels = { [fixed[0]]: 'Plan my Spring', [fixed[1]]: 'Advisor meeting prep' };
    const list = [...fixed, ...F.followUps({ view: actions.getView(), hasDraft: !!actions.getDraft(), limit: 2 })];
    box.innerHTML = list.map(q => `<button type="button" class="advisor-chip" data-advisor-prompt="${esc(q)}">${esc(labels[q] || q)}</button>`).join('');
    if (locked) box.querySelectorAll('button').forEach(b => { b.disabled = true; });
  }

  function setBusy(on) {
    busy = on;
    sendBtn.textContent = on ? 'Stop' : 'Send';
    sendBtn.setAttribute('aria-label', on ? 'Stop the advisor' : 'Send message');
    sendBtn.classList.toggle('stop', on);
    input.disabled = on || locked;
  }

  function lock() {
    locked = true;
    storage(s => s.setItem(LIMIT_KEY, '1'));
    input.disabled = true; sendBtn.disabled = true;
    input.placeholder = 'AI advisor paused — demo usage limit reached';
    thread.querySelectorAll('[data-advisor-prompt], [data-again]').forEach(b => { b.disabled = true; });
  }

  // ---------- Persistence ----------
  function save() {
    const data = JSON.stringify({ v: 1, messages, transcript, lastQuestion });
    storage(s => (data.length > MAX_SAVED_BYTES ? s.removeItem(CONVO_KEY) : s.setItem(CONVO_KEY, data)));
  }
  function restore() {
    const raw = storage(s => s.getItem(CONVO_KEY));
    if (!raw) return;
    let data;
    try { data = JSON.parse(raw); } catch { return; }
    if (data?.v !== 1 || !Array.isArray(data.transcript) || !data.transcript.length) return;
    messages = Array.isArray(data.messages) ? data.messages : [];
    transcript = data.transcript;
    lastQuestion = data.lastQuestion || '';
    thread.querySelector('[data-welcome-chips]')?.remove();
    let lastAi = null, chips = null;
    for (const e of transcript) {
      if (e.k === 'user' || e.k === 'ai') { const el = turn(e.k, e.text, e.t); if (e.k === 'ai') lastAi = el; }
      else if (e.k === 'notice') notice(e.text, e.tone, { save: false });
      else if (e.k === 'steps') restoreSteps(e.items || []);
      else if (e.k === 'card') staleCard(e.name);
      else if (e.k === 'chips') chips = e.list;
    }
    if (lastAi) markLastAnswer(lastAi);
    if (chips) suggestions(chips, { save: false });
    notice('Conversation restored. The demo registration and draft were reset by the reload.', '', { save: false });
    if (messages.length) pendingEvents.push('The page was reloaded: the Fall demo registration, waitlists and draft were reset to their defaults, and any Spring plan on screen was cleared. Earlier cards in this conversation are stale.');
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
        <button type="button" class="btn btn-primary btn-sm" data-act="register">Review &amp; register</button></div>`, 'build_schedule');
    el.querySelector('[data-act="view"]').onclick = () => actions.showView('registration');
    el.querySelector('[data-act="register"]').onclick = (e) => confirmFlow({ action: 'register', courseCodes: d.courses.map(c => c.code) }, e.currentTarget);
  }

  function recommendationCard(result) {
    const recs = (result.recommendations || []).slice(0, 5);
    if (!recs.length) { notice('No eligible Spring recommendations matched this scenario.'); return; }
    const items = recs.map((r, i) => `
      <li><div class="row"><span class="rank">${i + 1}</span><code>${esc(r.code)}</code><b>${esc(r.title)}</b></div>
        <div class="meta">Sec ${esc(r.section)} · ${esc(r.meeting)} · ${r.usableSeats} usable seat${r.usableSeats === 1 ? '' : 's'}</div>
        <div class="why">${esc(r.closes?.length ? `Counts toward: ${r.closes.join(' · ')}` : (r.reasons || [])[0] || '')}</div>
        ${(r.cautions || []).slice(0, 1).map(c => `<div class="warn">${esc(c)}</div>`).join('')}</li>`).join('');
    const el = card(`<div class="hd"><span class="kind rec">Spring 2026–27 · vs your audit</span><span>top ${recs.length}</span></div>
      <ul>${items}</ul><p class="src">${esc(result.dataSource || '')}</p>
      <div class="acts"><button type="button" class="btn btn-ghost btn-sm" data-act="open">Open Spring Planner</button></div>`, 'get_phase1_recommendations');
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
    const el = card(`<div class="hd"><span class="kind draft">Replace ${esc(result.replacing)}</span><span>others stay fixed</span></div><ul>${items}</ul>`, 'suggest_alternatives');
    el.querySelectorAll('[data-take]').forEach(btn => btn.onclick = () => {
      const out = actions.swap(result.replacing, btn.dataset.take);
      el.querySelectorAll('[data-take]').forEach(b => { b.disabled = true; });
      const ok = out && typeof out === 'object';
      notice(ok ? `Draft updated: ${result.replacing} → ${btn.dataset.take}. No seats held.` : String(out), ok ? '' : 'error');
      if (ok) { pendingEvents.push(`Student replaced ${result.replacing} with ${btn.dataset.take} in the draft using the card.`); draftCard(); }
      save();
    });
  }

  function confirmationCard(result) {
    const verb = { register: 'Review & register', drop: 'Review & drop', waitlist: result.leave ? 'Review & leave waitlist' : 'Review & join waitlist' }[result.action];
    const el = card(`<div class="hd"><span class="kind gated">Needs your confirmation</span></div>
      <p class="body">${esc(result.summary)}</p>
      <div class="acts"><button type="button" class="btn btn-primary btn-sm" data-act="confirm">${esc(verb)}</button></div>`, 'confirm');
    el.querySelector('[data-act="confirm"]').onclick = (e) => confirmFlow(result, e.currentTarget);
  }

  async function confirmFlow(request, button) {
    button.disabled = true;
    const outcome = await actions.confirm(request);
    notice(outcome.message, outcome.changed ? 'ok' : '');
    pendingEvents.push(`${outcome.changed ? 'Student confirmed' : 'No change'}: ${outcome.message}`);
    if (!outcome.changed) button.disabled = false;
    save();
  }

  function springPlanCard(result) {
    const plan = result.plans?.[0];
    if (!plan) { notice((result.notes || []).join(' ') || 'No Spring plan fits those limits.', 'warn'); return; }
    const rows = plan.courses.map(c => `
      <li><div class="row"><code>${esc(c.code)}</code><b>${esc(c.title)}</b><span class="cr">${c.credits} cr</span></div>
        ${c.sections.map(x => `<div class="meta">${esc(x.part)} ${esc(x.section.split(' ').pop())} · CRN ${esc(x.crn)} · ${esc(x.meets.join('; ') || 'TBA')}</div>`).join('')}
        ${c.countsToward.length ? `<div class="tag required">${esc(c.countsToward.join(' · '))}</div>` : ''}</li>`).join('');
    const warn = plan.warnings.length ? `<div class="warn">${plan.warnings.length} thing${plan.warnings.length === 1 ? '' : 's'} to check, e.g. ${esc(plan.warnings[0])}</div>` : '';
    const notes = (result.notes || []).map(n => `<div class="warn">${esc(n)}</div>`).join('');
    const el = card(`<div class="hd"><span class="kind draft">Spring 2026–27 · plan 1 of ${result.plans.length}</span><span>${plan.totalCredits} credits · ${plan.coveredItems.length} audit items</span></div>
      ${notes}<ul>${rows}</ul>${warn}<p class="src">Real sections from the Spring snapshot. No seats held — register in Banner with the CRNs.</p>
      <div class="acts"><button type="button" class="btn btn-ghost btn-sm" data-act="plans">See all plans</button>
        <button type="button" class="btn btn-primary btn-sm" data-act="summary">Advisor summary</button></div>`, 'plan_spring_schedule');
    el.querySelector('[data-act="plans"]').onclick = () => actions.showPlanner();
    el.querySelector('[data-act="summary"]').onclick = () => actions.openSummary(0);
  }

  function summaryCard(result) {
    const el = card(`<div class="hd"><span class="kind rec">Advisor meeting summary</span><span>${esc(result.includesPlan || '')}</span></div>
      <p class="body">${(result.questions || []).length} question${(result.questions || []).length === 1 ? '' : 's'} to ask, plus your audit progress${/Plan/.test(result.includesPlan || '') ? ' and Spring plan' : ''}. Print it or copy it as text.</p>
      <div class="acts"><button type="button" class="btn btn-primary btn-sm" data-act="open">Open summary</button></div>`, 'prepare_advisor_summary');
    const planNo = Number((result.includesPlan || '').match(/Plan (\d)/)?.[1] || 1) - 1;
    el.querySelector('[data-act="open"]').onclick = () => actions.openSummary(planNo);
  }

  function renderToolCard(name, result) {
    if (!result || typeof result !== 'object') return;
    if (result.awaitingConfirmation) return confirmationCard(result);
    if ((name === 'build_schedule' || name === 'swap_draft_course') && !result.error) return draftCard();
    if (name === 'get_phase1_recommendations') return recommendationCard(result);
    if (name === 'suggest_alternatives') return alternativesCard(result);
    if (name === 'plan_spring_schedule') return springPlanCard(result);
    if (name === 'prepare_advisor_summary' && !result.error) return summaryCard(result);
  }

  // ---------- Network ----------
  /** POST with automatic waits for temporary limits, so a multi-step answer is not lost halfway. */
  async function postWithRetry(body, gen) {
    for (let attempt = 0; ; attempt++) {
      try { return await post(body); }
      catch (err) {
        const code = err instanceof AdvisorHttpError ? err.payload.code : null;
        const wait = code === 'rate_limited' ? Number(err.payload.retryAfter) || 30 : code === 'upstream_busy' ? 3 : 0;
        if (!wait || attempt >= 2 || wait > 60 || gen !== generation) throw err;
        for (let s = wait; s > 0; s--) {
          if (gen !== generation || controller?.signal.aborted) throw err;
          typing(code === 'rate_limited' ? `Free-tier rate limit — continuing in ${s}s…` : 'The AI service is busy — retrying…');
          await new Promise(r => setTimeout(r, 1000));
        }
      }
    }
  }

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

  async function runTools(blocks, used) {
    const results = [];
    for (const block of blocks) {
      used.push(block.name);
      typing(`${F.stepLabel(block.name, 'running')}…`);
      const done = stepStart(block.name);
      const handler = handlers[block.name];
      try {
        if (!handler) throw new Error(`Unknown tool ${block.name}.`);
        const result = await handler(block.input || {}, { channel: 'chat' });
        done(!(result && typeof result === 'object' && result.error), F.stepSummary(block.name, result));
        renderToolCard(block.name, result);
        results.push({ type: 'tool_result', tool_use_id: block.id, content: typeof result === 'string' ? result : JSON.stringify(result) });
      } catch (err) {
        console.error(err);
        done(false, err.message);
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

  function finishTurn(used) {
    closeSteps();
    suggestions(F.followUps({ view: actions.getView(), tools: used, hasDraft: !!actions.getDraft(), hasSpringPlan: !!actions.hasSpringPlan?.() }));
    save();
  }

  async function ask(text) {
    const clean = String(text || '').trim().slice(0, MAX_INPUT);
    if (!clean || busy) return;
    if (locked) { notice('The AI advisor has reached its demo usage limit and is paused.', 'error'); return; }
    thread.querySelector('[data-welcome-chips]')?.remove();
    thread.querySelectorAll('.advisor-chips.follow').forEach(el => el.remove());
    lastQuestion = clean;
    bubble('user', clean);
    input.value = ''; autosize();
    const used = [];
    if (offline) { setBusy(true); try { await useOffline(clean); } finally { setBusy(false); finishTurn(used); input.focus(); } return; }
    if (messages.length >= MAX_HISTORY) { notice('This conversation is getting long. Start a new conversation to keep going.', 'warn'); save(); return; }

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
        const data = await postWithRetry({ messages }, gen);
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
          const results = await runTools(toolCalls, used);
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
        finishTurn(used);
        if (!locked) input.focus();
      }
    }
  }

  function reset() {
    generation++;
    controller?.abort('user');
    controller = null; typingEl = null; steps = null;
    messages = []; transcript = []; pendingEvents = []; offline = false; lastQuestion = '';
    storage(s => s.removeItem(CONVO_KEY));
    setBusy(false);
    thread.innerHTML = welcomeHtml;
    refreshWelcome();
    if (locked) lock();
  }

  // ---------- Input ----------
  function autosize() {
    input.style.height = 'auto';
    input.style.height = `${input.scrollHeight + 2}px`;
    input.style.overflowY = input.scrollHeight > input.clientHeight + 2 ? 'auto' : 'hidden';
    const n = input.value.length;
    if (counter) { counter.hidden = n < MAX_INPUT - 200; counter.textContent = `${n} / ${MAX_INPUT}`; }
  }

  async function copyAnswer(turnEl, button) {
    const text = turnEl.dataset.text || turnEl.querySelector('.txt').innerText;
    try { await navigator.clipboard.writeText(text); button.textContent = 'Copied'; }
    catch {
      const range = document.createRange(); range.selectNodeContents(turnEl.querySelector('.txt'));
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
      button.textContent = 'Selected — press ⌘C';
    }
    setTimeout(() => { button.textContent = 'Copy'; }, 1800);
  }

  thread.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-advisor-prompt]');
    if (chip) return ask(chip.dataset.advisorPrompt);
    const code = e.target.closest('.code-link');
    if (code) { if (!actions.focusCourse(code.dataset.code)) ask(`Tell me about ${code.dataset.code}.`); return; }
    const copy = e.target.closest('[data-copy]');
    if (copy) return copyAnswer(copy.closest('.advisor-turn'), copy);
    if (e.target.closest('[data-again]') && lastQuestion) return ask(lastQuestion);
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (busy) { controller?.abort('user'); return; }
    ask(input.value);
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!busy) form.requestSubmit(); } });
  input.addEventListener('input', autosize);
  $('advisorReset')?.addEventListener('click', reset);
  restore();
  refreshWelcome();
  if (locked) lock();

  return {
    ask, reset,
    addEvent: (text) => pendingEvents.push(text),
    // Called when the panel opens: a restored thread was laid out while hidden, so scroll it now.
    refresh: () => { refreshWelcome(); scroll(); },
    busy: () => busy,
  };
}
