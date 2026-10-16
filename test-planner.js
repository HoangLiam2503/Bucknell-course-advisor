const assert = require('node:assert/strict');
const fs = require('node:fs');
const advisor = require('./phase1-recommender.js');
const S = require('./spring-planner.js');

const offerings = JSON.parse(fs.readFileSync('./data/spring-2027-sections.json', 'utf8'));
const audit = JSON.parse(fs.readFileSync('./data/degree-audit-snapshot.json', 'utf8'));
const recs = advisor.recommendForAudit({ audit, offerings, completed: audit.completedCourses, interests: [] });
const plan = (constraints) => S.planSpring({ offerings, audit, recommendations: recs, constraints });

// Options pair a lecture with its required lab and never clash with themselves
const index = S.indexOfferings(offerings);
const cs204 = S.courseOptions(index, 'CSCI204');
assert.equal(cs204.length, 4, 'two CSCI204 lectures x two labs');
assert.ok(cs204.every(o => o.parts.some(p => p.Number === '204L')), 'every CSCI204 option includes a lab');
for (const o of S.courseOptions(index, 'BIOL204')) {
  const weekly = o.meetings.filter(m => !m.occasional);
  assert.ok(!weekly.some((m, i) => weekly.some((n, j) => j > i && m.section !== n.section && m.days.some(d => n.days.includes(d)) && m.start < n.end && n.start < m.end)), 'no lab clashes with its own lecture');
}

// A normal request: conflict-free, inside the limits, required course included
const r = plan({ maxCourses: 4, earliestStart: '10:00', mustInclude: ['CSCI204'] });
assert.ok(r.plans.length >= 2, 'several plans are offered');
for (const p of r.plans) {
  assert.ok(p.courses.length <= 4 && p.totalCredits <= 4.5);
  assert.ok(p.courses.some(c => c.code === 'CSCI204'), 'required course is in every plan');
  const weekly = p.meetings.filter(m => !m.occasional);
  for (let i = 0; i < weekly.length; i++) for (let j = i + 1; j < weekly.length; j++) {
    const a = weekly[i], b = weekly[j];
    if (a.code === b.code) continue;
    assert.ok(!(a.days.some(d => b.days.includes(d)) && a.start < b.end && b.start < a.end), `${a.code} and ${b.code} do not clash in ${p.id}`);
  }
  assert.ok(weekly.every(m => m.start >= 600), 'nothing weekly before 10:00');
  assert.ok(p.courses.every(c => c.crns.length >= 1), 'every course lists its CRNs');
  assert.ok(Object.keys(p.planB).length === p.courses.length, 'plan B entry per course');
}
assert.equal(new Set(r.plans.map(p => p.courses.map(c => c.code).sort().join('+'))).size, r.plans.length, 'plans differ in course sets');

// Constraints that cannot be met are explained, not silently dropped
const noFri = plan({ maxCourses: 4, avoidDays: ['Fri'], mustInclude: ['CSCI204'] });
assert.ok(noFri.notes.some(n => /CSCI204 has no section/.test(n)), 'MWF-only CSCI204 cannot fit a free Friday');
assert.ok(noFri.plans.every(p => p.meetings.filter(m => !m.occasional).every(m => !m.days.includes('F'))), 'no weekly Friday meetings');
const blocked = plan({ mustInclude: ['CSCI205', 'CSCI999'] });
assert.ok(blocked.notes.some(n => /CSCI205: Missing prerequisite: CSCI204/.test(n)));
assert.ok(blocked.notes.some(n => /CSCI999 is not offered/.test(n)));

// Warnings surface exam slots and walking time
const all = r.plans.flatMap(p => p.warnings.map(w => w.kind));
assert.ok(all.includes('exam-evening'), 'STAT 227 evening exam slot is flagged');

// Section explanation and advisor questions
const ex = S.explainSection(offerings, 'CSCI 204', null, audit);
assert.equal(ex.code, 'CSCI204');
assert.ok(ex.flags.some(f => /lab/.test(f)) && ex.companions.length === 2, 'the required lab is explained');
assert.deepEqual(ex.countsToward, ['CSCI 204']);
assert.equal(S.explainSection(offerings, 'CSCI999'), null);
const qs = S.advisorQuestions(r.plans[0], audit, recs);
assert.ok(qs.some(q => /CSCI 201 is not offered in Spring/.test(q)), 'flags required courses missing from Spring');

console.log(`Planner checks passed (${r.plans.length} plans; ${r.plans[0].courses.map(c => c.code).join(', ')}).`);
