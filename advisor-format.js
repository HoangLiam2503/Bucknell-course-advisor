/* Advisor chat formatting — pure functions, no DOM, so Node tests can load them.
   Browser global window.AdvisorFormat; Node module for test-advisor-format.js.
   formatAnswer  — model text -> safe HTML (escaped first, then lists and course-code links)
   stepLabel     — what a tool step is doing / did, for the step log
   stepSummary   — a few words about a tool result
   followUps     — suggested next questions for the current page and the tools just used */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AdvisorFormat = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));

  // Demo codes look like CS320, Spring codes like CSCI 204 or CSCI 204L. Words that are not subjects are skipped.
  const CODE_RE = /\b([A-Z]{2,4}) ?(\d{3})([A-Z]?)\b/g;
  const NOT_SUBJECTS = new Set(['CRN', 'GPA', 'AM', 'PM', 'TBA', 'ID']);

  const normCode = (code) => String(code || '').toUpperCase().replace(/\s+/g, '');

  function linkCodes(escaped) {
    return escaped.replace(CODE_RE, (match, subj, num, suffix) => {
      if (NOT_SUBJECTS.has(subj)) return match;
      return `<button type="button" class="code-link" data-code="${subj}${match.includes(' ') ? ' ' : ''}${num}${suffix}">${match}</button>`;
    });
  }

  const inline = (line) => linkCodes(esc(line));
  const BULLET = /^\s*(?:[•\-*–]|(\d+)[.)])\s+/;

  /** Model text -> HTML. The model is told to write plain text with "•" bullets; markdown emphasis is stripped. */
  function formatAnswer(text) {
    const clean = String(text ?? '').replace(/\*\*(.+?)\*\*/g, '$1').replace(/^#{1,6}\s+/gm, '').replace(/\r/g, '').trim();
    if (!clean) return '';
    const out = [];
    let para = [], list = null;
    const flushPara = () => { if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; };
    const flushList = () => { if (list) out.push(`<${list.tag}>${list.items.map(i => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`); list = null; };
    for (const line of clean.split('\n')) {
      const m = line.match(BULLET);
      if (m) {
        flushPara();
        const tag = m[1] ? 'ol' : 'ul';
        if (list && list.tag !== tag) flushList();
        list ||= { tag, items: [] };
        list.items.push(line.slice(m[0].length));
      } else if (!line.trim()) { flushPara(); flushList(); }
      else { flushList(); para.push(line.trim()); }
    }
    flushPara(); flushList();
    return out.join('');
  }

  const STEPS = {
    get_student_profile: ['Reading your profile', 'Read your profile'],
    search_courses: ['Searching the catalog', 'Searched the demo catalog'],
    check_eligibility: ['Checking eligibility', 'Checked eligibility'],
    build_schedule: ['Building a draft schedule', 'Built a draft schedule'],
    suggest_alternatives: ['Finding alternatives', 'Found alternatives'],
    swap_draft_course: ['Updating the draft', 'Updated the draft'],
    explain_course_impact: ['Checking graduation impact', 'Checked graduation impact'],
    register_course: ['Preparing registration', 'Prepared registration'],
    drop_course: ['Preparing the drop request', 'Prepared the drop request'],
    join_waitlist: ['Preparing the waitlist request', 'Prepared the waitlist request'],
    get_degree_audit: ['Reading your degree audit', 'Read your degree audit'],
    get_phase1_recommendations: ['Ranking Spring 2026–27 sections', 'Ranked Spring 2026–27 sections'],
    get_schedule: ['Reading your schedule', 'Read your schedule'],
    update_preferences: ['Saving your preferences', 'Saved your preferences'],
    plan_spring_schedule: ['Building Spring plans from real sections', 'Built Spring plans'],
    explain_section: ['Reading the section details', 'Read the section details'],
    prepare_advisor_summary: ['Preparing your advisor summary', 'Prepared your advisor summary'],
  };

  /** phase: 'running' | 'done' */
  function stepLabel(name, phase = 'running') {
    const pair = STEPS[name];
    if (!pair) return phase === 'running' ? 'Working' : String(name || 'Step');
    return pair[phase === 'running' ? 0 : 1];
  }

  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const clip = (s, n = 70) => { s = String(s); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };

  /** Few-word description of a tool result for the step log. Returns '' when there is nothing useful to say. */
  function stepSummary(name, result) {
    if (result == null) return '';
    if (typeof result === 'string') return clip(result);
    if (result.error) return clip(result.error);
    if (result.awaitingConfirmation) return 'waiting for your confirmation';
    switch (name) {
      case 'search_courses': return plural((result.results || []).length, 'result');
      case 'check_eligibility': return `${result.code}: ${result.status}`;
      case 'build_schedule': return result.courses?.length ? `${plural(result.courses.length, 'course')} · ${result.totalCredits} credits · draft` : 'nothing fits';
      case 'suggest_alternatives': return plural((result.options || []).length, 'option');
      case 'explain_course_impact': return clip(`${result.code}: ${result.requirement}`);
      case 'get_degree_audit': {
        const items = (result.areas || []).flatMap(a => a.items || []);
        return `${plural(items.filter(i => i.status === 'not-met').length, 'open item')} of ${items.length}`;
      }
      case 'get_phase1_recommendations': return `${plural((result.recommendations || []).length, 'section')} ranked`;
      case 'get_schedule': return `${result.totalCredits} credits registered`;
      case 'plan_spring_schedule': {
        const p = result.plans?.[0];
        return p ? `${plural(result.plans.length, 'plan')} · plan 1 is ${p.totalCredits} credits` : 'no plan fits';
      }
      case 'explain_section': return result.code ? `${result.code}${result.section ? `-${result.section}` : ''}` : '';
      case 'prepare_advisor_summary': return plural((result.questions || []).length, 'question');
      default: return '';
    }
  }

  const BY_VIEW = {
    registration: ['Plan my Fall demo semester with nothing before 10am', 'Which courses here am I eligible for?'],
    catalog: ['Which of these courses fit my interests?', 'What is full and worth waitlisting?'],
    schedule: ['Is my current week too heavy?', 'Do I have any time conflicts?'],
    audit: ['What degree requirements do I still have left?', 'Which open item should I close first in Spring?'],
    transcript: ['What does my transcript say about my strengths?', 'Which requirements did my completed courses cover?'],
    recommendations: ['Plan my Spring 2026–27 semester with 4 courses', 'Why is the top recommendation ranked first?'],
  };

  const AFTER_TOOL = {
    plan_spring_schedule: ['Explain the plan B options', 'Prepare my advisor meeting summary', 'What should I check before registering in Banner?'],
    get_phase1_recommendations: ['Plan my Spring 2026–27 semester from these', 'Which of these double-count for two items?'],
    get_degree_audit: ['Which Spring courses close the most open items?', 'Plan my Spring 2026–27 semester'],
    build_schedule: ['Swap the heaviest course for something lighter', 'Register the draft'],
    swap_draft_course: ['How heavy is the draft now?', 'Register the draft'],
    suggest_alternatives: ['Which option is lightest?', 'Keep the original course'],
    explain_section: ['Does this section fit the rest of my plan?', 'Who are the reserved seats for?'],
    prepare_advisor_summary: ['What else should I ask my advisor?'],
    explain_course_impact: ['What happens if I take it next term instead?'],
  };

  /** Up to `limit` suggested questions: what fits the tools just used first, then the current page. */
  function followUps({ view, tools = [], hasDraft = false, hasSpringPlan = false, limit = 3 } = {}) {
    const picks = [];
    for (const name of [...tools].reverse()) picks.push(...(AFTER_TOOL[name] || []));
    picks.push(...(BY_VIEW[view] || BY_VIEW.registration));
    if (hasSpringPlan && !tools.includes('prepare_advisor_summary')) picks.push('Prepare my advisor meeting summary');
    const out = [];
    for (const q of picks) {
      if (!hasDraft && /\bthe draft\b/i.test(q)) continue;
      if (!out.includes(q)) out.push(q);
      if (out.length >= limit) break;
    }
    return out;
  }

  return { esc, normCode, formatAnswer, stepLabel, stepSummary, followUps };
});
