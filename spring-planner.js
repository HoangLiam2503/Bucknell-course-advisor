/* Spring 2026–27 planner — pure logic over the public section feed, no DOM.
   Builds conflict-free plans from real sections (lecture + required lab/recitation), offers a
   plan B per course, flags schedule problems, explains a section in structured form, and drafts
   questions for an advisor meeting. Browser global window.SpringPlanner; Node module for tests. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./phase1-recommender.js'));
  else root.SpringPlanner = factory(root.Phase1Advisor);
})(typeof self !== 'undefined' ? self : this, function (P) {
  const DAY_KEYS = ['M', 'T', 'W', 'R', 'F', 'S', 'U'];
  const DAY_LABEL = { M: 'Mon', T: 'Tue', W: 'Wed', R: 'Thu', F: 'Fri', S: 'Sat', U: 'Sun' };
  const LABEL_DAY = { Mon: 'M', Tue: 'T', Wed: 'W', Thu: 'R', Fri: 'F' };
  const BEAM = 80;

  const toMin = hhmm => { const s = String(hhmm).replace(':', '').padStart(4, '0'); return Number(s.slice(0, 2)) * 60 + Number(s.slice(2)); };
  const clock = min => `${(Math.floor(min / 60) + 11) % 12 + 1}:${String(min % 60).padStart(2, '0')} ${min >= 720 ? 'pm' : 'am'}`;
  const keyOf = s => `${s.Subj}${s.Number}-${s.Section}`;
  const isCompanion = s => /[LR]$/.test(String(s.Number));
  const baseCode = s => `${s.Subj}${String(s.Number).replace(/[LR]$/, '')}`;
  const OCCASIONAL = /exam|few times|not be used every week|only be used/i;

  function meetingsOf(section) {
    const occasionalNote = OCCASIONAL.test(section.Footnote || '');
    return (section.Meetings || []).filter(m => m.Start && m.End).map(m => ({
      days: DAY_KEYS.filter(d => m[d] === 'Y'), start: toMin(m.Start), end: toMin(m.End),
      location: m.Location || '', building: (m.Location || '').split(' ')[0] || '',
      // A zero-credit meeting on a lecture whose note says exams/occasional = an exam slot, not weekly class time.
      occasional: !isCompanion(section) && Number(m.Credit) === 0 && occasionalNote,
      section: keyOf(section),
    }));
  }

  function meetingLabel(m) { return `${m.days.map(d => DAY_LABEL[d]).join('/')} ${clock(m.start)}–${clock(m.end)}${m.location ? ` · ${m.location}` : ''}`; }

  /** Index of a term's sections: lecture sections by course code, plus their labs and recitations. */
  function indexOfferings(offerings) {
    const lectures = new Map(), labs = new Map(), recs = new Map();
    for (const s of offerings) {
      const code = baseCode(s);
      const bucket = !isCompanion(s) ? lectures : String(s.Number).endsWith('L') ? labs : recs;
      if (!bucket.has(code)) bucket.set(code, []);
      bucket.get(code).push(s);
    }
    return { lectures, labs, recs };
  }

  /** Every way to take a course: one lecture section × one lab (if any) × one recitation (if any). */
  function courseOptions(index, code) {
    const lectures = (index.lectures.get(code) || []).filter(s => Number(s.Credit) > 0 || (index.lectures.get(code) || []).every(x => Number(x.Credit) === 0));
    const labs = index.labs.get(code) || [null];
    const recs = index.recs.get(code) || [null];
    const out = [];
    for (const lec of lectures) for (const lab of labs) for (const rec of recs) {
      const parts = [lec, lab, rec].filter(Boolean);
      const own = parts.flatMap(meetingsOf).filter(m => !m.occasional);
      if (own.some((m, i) => own.some((n, j) => j > i && m.section !== n.section && overlap(m, n)))) continue; // a lab that clashes with its own lecture
      out.push({
        code, title: lec.Title, credits: Number(lec.Credit) || 0, parts,
        meetings: parts.flatMap(meetingsOf),
        seats: Math.min(...parts.map(p => P.availableSeats(p))),
        tba: parts.some(p => !meetingsOf(p).length),
      });
    }
    return out;
  }

  function overlap(a, b) { return a.days.some(d => b.days.includes(d)) && a.start < b.end && b.start < a.end; }

  /** Hard clashes (weekly class time) and soft ones (an occasional exam slot is involved). */
  function clashes(option, chosen) {
    const hard = [], soft = [];
    for (const other of chosen) for (const m of option.meetings) for (const n of other.meetings) {
      if (!overlap(m, n)) continue;
      (m.occasional || n.occasional ? soft : hard).push({ a: m, b: n, with: other.code });
    }
    return { hard, soft };
  }

  function fitsConstraints(option, c) {
    if (option.seats <= 0) return false;
    return option.meetings.filter(m => !m.occasional).every(m =>
      (c.earliest == null || m.start >= c.earliest) && (c.latest == null || m.end <= c.latest) && !m.days.some(d => c.avoid.includes(d)));
  }

  function normalizeConstraints(c = {}) {
    return {
      maxCourses: Math.max(1, Math.min(6, Number(c.maxCourses) || 4)),
      maxCredits: Number(c.maxCredits) || 4.5,
      earliest: c.earliestStart ? toMin(c.earliestStart) : null,
      latest: c.latestEnd ? toMin(c.latestEnd) : null,
      avoid: (c.avoidDays || []).map(d => LABEL_DAY[d] || d).filter(d => DAY_KEYS.includes(d)),
      mustInclude: [...new Set((c.mustInclude || []).map(x => String(x).replace(/\s/g, '').toUpperCase()))],
      interests: c.interests || [],
    };
  }

  /**
   * Up to three conflict-free plans from real sections.
   * recommendations = Phase1Advisor.recommendForAudit(...) output (closes, score, eligible, cautions).
   */
  function planSpring({ offerings, audit, recommendations, constraints = {}, candidateLimit = 30 }) {
    const c = normalizeConstraints(constraints);
    const index = indexOfferings(offerings);
    const items = new Map(audit.areas.flatMap(a => a.items.map(i => [i.id, { ...i, areaId: a.id }])));
    const recByCode = new Map(recommendations.map(r => [r.code, r]));
    const notes = [];

    const must = [];
    for (const code of c.mustInclude) {
      const rec = recByCode.get(code);
      if (!index.lectures.has(code)) { notes.push(`${code} is not offered in Spring 2026–27.`); continue; }
      if (rec && !rec.eligible && rec.cautions.some(x => /prerequisite/i.test(x))) { notes.push(`${code}: ${rec.cautions.find(x => /prerequisite/i.test(x))}`); continue; }
      must.push(code);
    }
    const optional = recommendations.filter(r => r.eligible && !must.includes(r.code)).slice(0, candidateLimit).map(r => r.code);
    const candidates = [...must, ...optional].map(code => {
      const options = courseOptions(index, code).filter(o => fitsConstraints(o, c));
      return { code, rec: recByCode.get(code) || { code, closes: [], score: 0, cautions: [], tags: [] }, options, required: must.includes(code) };
    });
    for (const cand of candidates) if (cand.required && !cand.options.length) {
      notes.push(`${cand.code} has no section with open seats that fits your time limits, so the plans leave it out.`);
      cand.required = false; must.splice(must.indexOf(cand.code), 1);
    }

    // Beam search: each state is a partial plan; courses are considered in priority order.
    let beam = [{ picks: [], credits: 0, value: 0, slots: {}, soft: 0 }];
    for (const cand of candidates) {
      const next = [];
      for (const state of beam) {
        if (!cand.required) next.push(state);
        if (state.picks.length >= c.maxCourses) continue;
        for (const option of cand.options.slice(0, 12)) {
          if (state.credits + option.credits > c.maxCredits + 1e-9) continue;
          const clash = clashes(option, state.picks.map(p => p.option));
          if (clash.hard.length) continue;
          const slots = { ...state.slots };
          let gain = 0;
          for (const hit of cand.rec.closes || []) {
            const item = items.get(hit.id);
            if (!item) continue;
            if (item.courses) { gain += item.areaId === 'cs-major' ? 60 : 50; continue; }
            const used = slots[hit.id] || 0;
            if (used < (item.count || 1)) { gain += 22; slots[hit.id] = used + 1; } else gain += 2;
          }
          gain += (cand.rec.tags || []).filter(t => c.interests.includes(t)).length * 6;
          gain += (cand.rec.score || 0) * 0.1 - clash.soft.length * 8;
          const namedItem = (cand.rec.closes || []).some(h => items.get(h.id)?.courses);
          if (!namedItem && (cand.rec.cautions || []).some(x => /Prerequisites are not in the demo data/.test(x))) gain -= 12; // unverified prerequisites on a gen-ed pick
          next.push({ picks: [...state.picks, { cand, option, softClashes: clash.soft }], credits: state.credits + option.credits,
            value: state.value + gain, slots, soft: state.soft + clash.soft.length });
        }
      }
      beam = next.sort((a, b) => b.value - a.value).slice(0, BEAM);
      if (!beam.length) break;
    }

    const complete = beam.filter(s => must.every(code => s.picks.some(p => p.cand.code === code)) && s.picks.length);
    const chosen = [], seen = new Set();
    for (const s of complete) { // prefer different course sets, then different sections
      const sig = s.picks.map(p => p.cand.code).sort().join('+');
      if (seen.has(sig)) continue;
      seen.add(sig); chosen.push(s);
      if (chosen.length === 3) break;
    }
    for (const s of complete) { if (chosen.length >= 3) break; if (!chosen.includes(s)) chosen.push(s); }

    const plans = chosen.map((s, i) => describePlan(s, i, candidates, items, c));
    if (!plans.length && !notes.length) notes.push('No combination fits these limits. Try a later end time, fewer free days or fewer required courses.');
    return { plans, notes, constraints: { ...constraints, maxCourses: c.maxCourses, maxCredits: c.maxCredits } };
  }

  function partKind(s) { return String(s.Number).endsWith('L') ? 'lab' : String(s.Number).endsWith('R') ? 'recitation' : 'lecture'; }

  function describeOption(option) {
    return option.parts.map(p => ({ kind: partKind(p), section: `${p.Subj} ${p.Number}-${p.Section}`, crn: p.Crn,
      instructor: (p.Instructors || []).map(x => x.Display).join(', ') || 'TBA',
      meetings: meetingsOf(p).map(m => meetingLabel(m) + (m.occasional ? ' (exam slot, not weekly)' : '')),
      seats: P.availableSeats(p) }));
  }

  function describePlan(state, i, candidates, items, c) {
    const picks = state.picks;
    const courses = picks.map(p => ({ code: p.cand.code, title: p.option.title, credits: p.option.credits,
      closes: (p.cand.rec.closes || []).map(h => h.item), parts: describeOption(p.option),
      crns: p.option.parts.map(x => x.Crn), cautions: p.cand.rec.cautions || [] }));
    const coveredIds = new Set(picks.flatMap(p => (p.cand.rec.closes || []).map(h => h.id)));
    const plan = { id: `plan-${i + 1}`, courses, totalCredits: Math.round(state.credits * 100) / 100,
      coveredItems: [...coveredIds].map(id => items.get(id)?.label).filter(Boolean),
      meetings: picks.flatMap(p => p.option.meetings.map(m => ({ ...m, code: p.cand.code }))) };
    plan.planB = Object.fromEntries(picks.map((p, idx) => [p.cand.code, planB(picks, idx, candidates)]));
    plan.warnings = planWarnings(plan, picks);
    return plan;
  }

  /** Swaps for one course that keep every other course in the plan as it is. */
  function planB(picks, idx, candidates) {
    const rest = picks.filter((_, j) => j !== idx).map(p => p.option);
    const me = picks[idx];
    const fits = o => !clashes(o, rest).hard.length;
    const out = [];
    for (const o of me.cand.options) {
      if (o === me.option || !fits(o)) continue;
      out.push({ code: me.cand.code, why: 'Same course, another section', parts: describeOption(o) });
      if (out.length >= 2) break;
    }
    if (out.length < 2) {
      const myItems = new Set((me.cand.rec.closes || []).map(h => h.id));
      for (const cand of candidates) {
        if (picks.some(p => p.cand.code === cand.code) || cand.required) continue;
        const shared = (cand.rec.closes || []).filter(h => myItems.has(h.id));
        if (!shared.length) continue;
        const o = cand.options.find(fits);
        if (!o) continue;
        out.push({ code: cand.code, title: o.title, why: `Also counts toward ${shared.map(h => h.item).join('; ')}`, parts: describeOption(o) });
        if (out.length >= 2) break;
      }
    }
    return out;
  }

  const RESTRICTION = /open (only )?to|majors only|only to|not open to|not available to|preference given|by permission|permission of|audition|application|must be majors|discretion of the instructor/i;

  /** Schedule problems a student should see before committing to a plan. */
  function planWarnings(plan, picks) {
    const warnings = [];
    const weekly = plan.meetings.filter(m => !m.occasional);
    for (const d of ['M', 'T', 'W', 'R', 'F']) {
      const day = weekly.filter(m => m.days.includes(d)).sort((a, b) => a.start - b.start);
      for (let i = 1; i < day.length; i++) {
        const a = day.at(i - 1), b = day.at(i);
        if (b.start - a.end <= 10 && a.building && b.building && a.building !== b.building) {
          warnings.push({ kind: 'walk', text: `${DAY_LABEL[d]}: ${a.code} ends ${clock(a.end)} in ${a.building}, ${b.code} starts ${clock(b.start)} in ${b.building} — ${b.start - a.end} minutes to cross campus.` });
        }
      }
      if (day.length >= 4) warnings.push({ kind: 'long-day', text: `${DAY_LABEL[d]} has ${day.length} meetings (${clock(day[0].start)}–${clock(day.at(-1).end)}).` });
    }
    for (const m of plan.meetings) if (m.start >= 18 * 60) {
      warnings.push({ kind: m.occasional ? 'exam-evening' : 'evening', text: `${m.code}: ${meetingLabel(m)}${m.occasional ? ' — evening exam slot, used only some weeks' : ' — weekly evening meeting'}.` });
    }
    for (const p of picks) for (const s of p.softClashes || []) {
      warnings.push({ kind: 'exam-clash', text: `${p.cand.code} and ${s.with} overlap at ${meetingLabel(s.a.occasional ? s.a : s.b)}, an exam slot — check exam dates with both instructors.` });
    }
    const w2 = plan.courses.filter(c => c.closes.some(x => /W2/.test(x)));
    if (w2.length >= 2) warnings.push({ kind: 'writing', text: `${w2.map(c => c.code).join(' and ')} are both W2 courses — a writing-heavy term.` });
    for (const p of picks) {
      const missing = (p.cand.rec.cautions || []).find(x => /prerequisite/i.test(x));
      if (missing) warnings.push({ kind: 'prereq', text: `${p.cand.code}: ${missing}` });
      if (p.option.tba) warnings.push({ kind: 'tba', text: `${p.cand.code}: meeting time TBA for at least one part — the plan cannot rule out a conflict.` });
      for (const part of p.option.parts) {
        const res = Number(part.Res) || 0;
        if (part.HasPerm === 'Y') warnings.push({ kind: 'permission', text: `${part.Subj} ${part.Number}-${part.Section} needs instructor permission.` });
        if (res > 0) warnings.push({ kind: 'reserved', text: `${part.Subj} ${part.Number}-${part.Section}: ${res} seats are reserved for specific students; ${P.availableSeats(part)} are open to everyone.` });
        if (part.Footnote && RESTRICTION.test(part.Footnote)) warnings.push({ kind: 'restriction', text: `${part.Subj} ${part.Number}-${part.Section}: “${String(part.Footnote).replace(/<[^>]+>/g, '').trim().slice(0, 160)}”` });
      }
    }
    return warnings;
  }

  /** Structured facts about one section for plain-language explanation. */
  function explainSection(offerings, code, sectionId, audit) {
    const want = String(code).replace(/\s/g, '').toUpperCase();
    const index = indexOfferings(offerings);
    const lectures = index.lectures.get(want) || [];
    if (!lectures.length) return null;
    const section = lectures.find(s => s.Section === String(sectionId || '').padStart(2, '0')) || lectures[0];
    const footnote = String(section.Footnote || '').replace(/<[^>]+>/g, '').trim();
    const flags = [];
    if (/must (also )?(select|register|choose)|required recitation|select a lab/i.test(footnote) || index.labs.has(want) || index.recs.has(want)) flags.push('Requires a lab and/or recitation section as well.');
    if (OCCASIONAL.test(footnote)) flags.push('Has an evening or extra time slot used only for exams or a few weeks.');
    if (RESTRICTION.test(footnote)) flags.push('Enrollment is restricted or prioritised (see the note).');
    if (/prerequisite/i.test(footnote)) flags.push('The note names a prerequisite.');
    if (/cross-?listed/i.test(footnote)) flags.push('Cross-listed with another department.');
    if (section.HasPerm === 'Y') flags.push('Instructor permission is required.');
    const reserved = Number(section.Res) || 0;
    const companions = [...(index.labs.get(want) || []), ...(index.recs.get(want) || [])].map(s => ({
      kind: partKind(s), section: `${s.Subj} ${s.Number}-${s.Section}`, crn: s.Crn, meetings: meetingsOf(s).map(meetingLabel), seats: P.availableSeats(s) }));
    const areas = audit ? P.auditStatus(audit) : null;
    return {
      code: want, title: section.Title, section: section.Section, crn: section.Crn, credits: section.Credit,
      otherSections: lectures.filter(s => s !== section).map(s => ({ section: s.Section, crn: s.Crn, meetings: meetingsOf(s).map(meetingLabel), seats: P.availableSeats(s) })),
      instructors: (section.Instructors || []).map(x => x.Display),
      meetings: meetingsOf(section).map(m => meetingLabel(m) + (m.occasional ? ' (exam slot, not weekly)' : '')),
      designations: (section.Reqs || []).map(r => ({ code: r.Code, meaning: r.Desc })),
      seats: { unreserved: P.availableSeats(section), reserved, reportedOpen: section.openSeats },
      permissionRequired: section.HasPerm === 'Y', note: footnote || null, flags, companions,
      countsToward: areas ? P.auditItemsForSection(areas, section).map(h => h.item.label) : [],
      courseGuide: section.HasGuide === 'Y' ? 'A Course Guide (syllabus details) is linked from Bucknell Course Information.' : null,
    };
  }

  /** Questions worth bringing to an advisor about a plan and the open audit items. */
  function advisorQuestions(plan, audit, recommendations = []) {
    const qs = [];
    for (const c of plan?.courses || []) {
      const own = c.closes.filter(x => /^[A-Z]{4} \d/.test(x)), others = c.closes.filter(x => !/^[A-Z]{4} \d/.test(x));
      if (own.length && others.length) qs.push(`Besides the ${own.join(' / ')} requirement, will ${c.code} also count toward ${others.join(' and ')}?`);
      else if (others.length > 1) qs.push(`Can ${c.code} count toward ${others.join(', ')} at the same time?`);
      if (c.cautions.some(x => /not in the demo data/.test(x))) qs.push(`What are the prerequisites for ${c.code}, and do I meet them?`);
      if (c.closes.some(x => /W2/.test(x))) qs.push(`Does taking ${c.code} as a W2 this term satisfy the "after the first year" W2, or only the "after W1" one?`);
      if (c.cautions.some(x => /permission/i.test(x))) qs.push(`Should I request permission for ${c.code} now?`);
    }
    if (audit) {
      const offered = new Set(recommendations.map(r => r.code));
      for (const a of audit.areas) for (const i of a.items) {
        if (i.status !== 'not-met' || !i.courses) continue;
        const missing = i.courses.filter(code => !offered.has(code));
        if (missing.length === i.courses.length) qs.push(`${i.label} is not offered in Spring 2026–27 — when should I plan to take it?`);
      }
    }
    return [...new Set(qs)];
  }

  return { toMin, clock, meetingsOf, meetingLabel, indexOfferings, courseOptions, clashes, planSpring, planWarnings, explainSection, advisorQuestions, normalizeConstraints };
});
