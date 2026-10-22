const assert = require('node:assert/strict');
const F = require('./advisor-format.js');
const AdvisorTools = require('./advisor-tools.js');

// formatAnswer: escapes before adding markup
const xss = F.formatAnswer('Try <script>alert(1)</script> & "quotes"');
assert.ok(!xss.includes('<script>'), 'script tags are escaped');
assert.ok(xss.includes('&lt;script&gt;') && xss.includes('&amp;') && xss.includes('&quot;'));
assert.ok(!F.formatAnswer('<img src=x onerror=alert(1)> CSCI 204').includes('<img'), 'html never passes through next to a code link');

// Paragraphs, line breaks and lists
assert.equal(F.formatAnswer('One.\n\nTwo.'), '<p>One.</p><p>Two.</p>');
assert.equal(F.formatAnswer('Line a\nLine b'), '<p>Line a<br>Line b</p>');
assert.equal(F.formatAnswer('Plan:\n• First\n• Second'), '<p>Plan:</p><ul><li>First</li><li>Second</li></ul>');
assert.equal(F.formatAnswer('1. A\n2. B'), '<ol><li>A</li><li>B</li></ol>');
assert.equal(F.formatAnswer('**Bold** text\n## Heading'), '<p>Bold text<br>Heading</p>', 'markdown emphasis and headings are stripped');
assert.equal(F.formatAnswer(''), '');
assert.equal(F.formatAnswer(null), '');

// Course codes become buttons, other capitalised numbers do not
const codes = F.formatAnswer('Take CSCI 204 and CS320, plus CSCI 204L. CRN 500 at 10 AM, GPA 300.');
assert.ok(codes.includes('data-code="CSCI 204"'), 'Spring code is linked');
assert.ok(codes.includes('data-code="CS320"'), 'demo code is linked');
assert.ok(codes.includes('data-code="CSCI 204L"'), 'lab suffix is kept');
assert.ok(!codes.includes('data-code="CRN 500"') && !codes.includes('data-code="GPA 300"'), 'CRN and GPA are not subjects');
assert.ok(!F.formatAnswer('CRN 50027').includes('code-link'), 'five-digit numbers are not course numbers');
assert.equal(F.normCode('csci 204'), 'CSCI204');

// Step labels cover every tool
for (const t of AdvisorTools.TOOLS) {
  assert.notEqual(F.stepLabel(t.name, 'running'), 'Working', `${t.name} has a running label`);
  assert.notEqual(F.stepLabel(t.name, 'done'), t.name, `${t.name} has a done label`);
}
assert.equal(F.stepLabel('unknown_tool'), 'Working');

// Step summaries
assert.equal(F.stepSummary('check_eligibility', { error: 'No course with code XX999.' }), 'No course with code XX999.');
assert.equal(F.stepSummary('register_course', { awaitingConfirmation: true }), 'waiting for your confirmation');
assert.equal(F.stepSummary('search_courses', { results: [{}, {}] }), '2 results');
assert.equal(F.stepSummary('plan_spring_schedule', { plans: [{ totalCredits: 4 }, {}] }), '2 plans · plan 1 is 4 credits');
assert.equal(F.stepSummary('plan_spring_schedule', { plans: [] }), 'no plan fits');
assert.equal(F.stepSummary('get_degree_audit', { areas: [{ items: [{ status: 'met' }, { status: 'not-met' }] }] }), '1 open item of 2');
assert.equal(F.stepSummary('build_schedule', { courses: [], totalCredits: 0 }), 'nothing fits');
assert.equal(F.stepSummary('get_student_profile', {}), '');
assert.ok(F.stepSummary('x', 'a'.repeat(200)).length <= 70, 'long strings are clipped');

// Follow-ups: tool first, then page; no draft actions without a draft
const afterPlan = F.followUps({ view: 'recommendations', tools: ['get_degree_audit', 'plan_spring_schedule'] });
assert.equal(afterPlan[0], 'Explain the plan B options');
assert.equal(afterPlan.length, 3);
assert.equal(new Set(afterPlan).size, afterPlan.length, 'no duplicates');
assert.ok(F.followUps({ view: 'audit' })[0].includes('requirements'), 'page suggestions when no tool ran');
assert.ok(!F.followUps({ view: 'registration', tools: ['build_schedule'] }).some(q => /the draft/.test(q)), 'draft actions need a draft');
assert.ok(F.followUps({ view: 'registration', tools: ['build_schedule'], hasDraft: true }).includes('Register the draft'));
assert.equal(F.followUps({ view: 'nowhere' }).length, 2, 'unknown view falls back to registration');

console.log('advisor-format: all checks passed');
