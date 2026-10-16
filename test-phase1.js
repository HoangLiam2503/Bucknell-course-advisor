const assert = require('node:assert/strict');
const fs = require('node:fs');
const advisor = require('./phase1-recommender.js');

const program = JSON.parse(fs.readFileSync('./data/bscs-2026-27.json', 'utf8'));
const collegeCore = JSON.parse(fs.readFileSync('./data/cas-core-class-2024.json', 'utf8'));
const offerings = JSON.parse(fs.readFileSync('./data/spring-2027-sections.json', 'utf8'));
const transcript = [
  { code: 'CSCI203', grade: 'A' },
  { code: 'CSCI204', grade: 'A-' },
  { code: 'CSCI205', grade: 'B+' },
  { code: 'MATH201', grade: 'B+' },
  { code: 'MATH202', grade: 'A-' },
  { code: 'MATH241', grade: 'B' },
  { code: 'STAT216', grade: 'A', designations: ['NSMC', 'CCQR', 'W2'] },
  { code: 'PHYS211', grade: 'B+', designations: ['LBSC', 'NSMC'] }
];

const ranked = advisor.recommend({ program, offerings, transcript, interests: ['ai', 'security', 'data'] });
const get = code => ranked.find(x => x.code === code);

assert.equal(get('CSCI306').eligible, true);
assert.match(get('CSCI306').reasons.join(' '), /remaining BSCS requirement/);
assert.equal(get('CSCI307').eligible, false, 'CSCI307 requires CSCI306 first');
assert.match(get('CSCI307').cautions.join(' '), /CSCI306/);
assert.equal(get('CSCI357').eligible, true, 'AI course should be eligible after CSCI204 + STAT216');
assert.ok(get('CSCI306').score > get('STAT217').score, 'A required course outranks a completed-area continuation');
assert.match(get('STAT217').cautions.join(' '), /does not close a remaining named BSCS requirement/);
assert.equal(get('MATH202'), undefined, 'Completed courses must not be recommended');
assert.equal(get('ACFM104'), undefined, 'Unrelated courses must not appear just because seats are open');
assert.equal(advisor.availableSeats({ openSeats: 4, Res: '4' }), 0, 'Reserved seats are not generally available seats');

const collegeTranscript = [
  { code: 'UNIV125', grade: 'A-', designations: ['FOUN', 'W1'] },
  { code: 'SPAN101', grade: 'B+', designations: ['CCFL'] },
  { code: 'HIST110', grade: 'B', designations: ['ARHC', 'GBCC'] },
  { code: 'ECON103', grade: 'B+', designations: ['SLSC', 'DUSC'] },
  ...transcript
];
const coreStatus = advisor.collegeCoreStatus(collegeCore, collegeTranscript);
const core = id => coreStatus.find(x => x.id === id);
assert.equal(core('foundation').status, 'complete');
assert.equal(core('foreign-language').status, 'complete');
assert.equal(core('integrated-perspectives').status, 'remaining');
assert.equal(core('natural-sciences').status, 'remaining', 'the lab science cannot also count among the two additional NSM perspectives');
assert.equal(core('culminating-experience').status, 'advisor-check');

const coreRanked = advisor.recommend({ program, collegeCore, offerings, transcript: collegeTranscript, interests: [] });
assert.ok(coreRanked.some(x => x.reasons.some(r => /Arts & Sciences core/.test(r))), 'remaining college-core designations should influence recommendations');

const withoutScience = transcript.filter(row => row.code !== 'PHYS211' && row.code !== 'STAT216');
const scienceRanked = advisor.recommend({ program, offerings, transcript: withoutScience, interests: [] });
assert.ok(scienceRanked.some(x => x.reasons.some(r => /Natural science elective/.test(r))), 'Science-designated offerings should be surfaced when science requirements remain');

console.log(`Phase 1 checks passed across ${offerings.length} official Spring sections.`);

// ---------- Degree-audit driven ranking (student's Area Requirement Summary) ----------
const audit = JSON.parse(fs.readFileSync('./data/degree-audit-snapshot.json', 'utf8'));
const auditRanked = advisor.recommendForAudit({ audit, offerings, completed: audit.completedCourses, interests: [] });
const pick = code => auditRanked.find(x => x.code === code);
assert.equal(pick('CSCI204').eligible, true, 'CSCI204 is open to a student who has CSCI203');
assert.deepEqual(pick('CSCI204').closes.map(c => c.id), ['csci-204']);
assert.equal(pick('CSCI205').eligible, false, 'CSCI205 needs CSCI204 first');
assert.equal(pick('CSCI476').eligible, false, 'Senior Design II needs CSCI475');
assert.equal(pick('CSCI203'), undefined, 'completed courses are not recommended');
assert.equal(auditRanked.filter(x => x.eligible)[0].code, 'CSCI204', 'the gateway major course ranks first');
for (const r of auditRanked) {
  const w2 = r.closes.filter(c => c.id.startsWith('w2-'));
  assert.ok(w2.length <= 1, `${r.code} fills at most one W2 slot`);
  if (r.closes.some(c => c.id === 'social-science')) assert.equal(r.section.College, 'AS', 'social science must be an Arts & Sciences course');
  if (r.closes.some(c => c.id === 'major-natural-science')) assert.ok(!['CSCI', 'MATH'].includes(r.section.Subj), 'natural science excludes CSCI and MATH');
  assert.ok(!r.closes.some(c => ['w1', 'foreign-language', 'quantitative-reasoning', 'first-semester-seminar', 'natural-science-math'].includes(c.id)), 'met items are not targeted');
}
const multi = auditRanked.find(x => x.eligible && x.closes.length >= 3);
assert.ok(multi && multi.reasons.some(r => /several requirements/.test(r)), 'courses closing several items are called out');
assert.ok(multi.cautions.some(c => /Confirm with your advisor/.test(c)), 'double counting carries a caution');
const simulated = advisor.recommendForAudit({ audit, offerings, completed: audit.completedCourses, extraCompleted: ['STAT227'] });
assert.equal(simulated.find(x => x.code === 'STAT227'), undefined, 'simulated STAT227 drops out');
assert.equal(advisor.auditStatus(audit, ['STAT227']).find(a => a.id === 'major-related').items.find(i => i.id === 'stat-227').status, 'met');
console.log(`Audit ranking checks passed (${auditRanked.filter(x => x.eligible).length} eligible Spring courses for the open items).`);
