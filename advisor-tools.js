/* Advisor tool contract — names, descriptions and input schemas only, no behaviour.
   Shared by the WebMCP registration and the in-portal chat (browser global window.AdvisorTools)
   and by the /api/advisor function (Node module). Handlers live in index.html.
   kind: 'read'  — reads data, may navigate the page
         'draft' — edits the draft or preferences; never holds a seat
         'gated' — enrollment change; the student must confirm in the portal */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AdvisorTools = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const TAGS = ['ai', 'security', 'web', 'data', 'core', 'ethics', 'business', 'design'];
  const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
  const code = (description) => ({ type: 'string', description });

  const TOOLS = [
    { name: 'get_student_profile', kind: 'read',
      description: 'Return the signed-in Bucknell student’s academic profile: major, class year, GPA, credits earned, completed courses, interests, career goal, credit cap and scheduling preferences. Call this first to personalize any advice.',
      inputSchema: { type: 'object', properties: {} } },

    { name: 'search_courses', kind: 'read',
      description: 'Search the Fall 2026 demo catalog. Every result carries an eligibility verdict (eligible, ineligible, full, conflict, taken) with plain-language reasons derived from the student’s prerequisites, GPA, seat availability and current schedule.',
      inputSchema: { type: 'object', properties: {
        query: { type: 'string', description: 'Free-text match on course code, title or description.' },
        tag: { type: 'string', enum: TAGS, description: 'Topic filter, e.g. ai, security, web, data, core.' },
        department: { type: 'string', description: 'Department filter, e.g. "Computer Science".' },
        onlyEligible: { type: 'boolean', description: 'Return only courses the student can register for right now.' } } } },

    { name: 'check_eligibility', kind: 'read',
      description: 'Full eligibility report for one course: prerequisites, GPA minimum, open seats, waitlist size, and time conflicts against the student’s registered courses. Expands the course on screen.',
      inputSchema: { type: 'object', properties: { courseCode: code('Course code such as CS360.') }, required: ['courseCode'] } },

    { name: 'build_schedule', kind: 'draft',
      description: 'Propose an optimized semester schedule from the student’s constraints: credit cap, earliest start, latest end, priority topics, days to keep free. Only eligible, non-conflicting courses are selected. This produces a DRAFT shown on the page — no seats are held and nobody is enrolled. The result also reports the weekly workload in hours, project and team-work load, and which graduation requirement each course satisfies. Use suggest_alternatives or swap_draft_course to change one course without rebuilding, then register_course once the student agrees.',
      inputSchema: { type: 'object', properties: {
        maxCredits: { type: 'integer', minimum: 1, maximum: 21, description: 'Credit cap for the semester.' },
        earliestStart: { type: 'string', description: '24h time such as "10:00" — no class may start earlier.' },
        latestEnd: { type: 'string', description: '24h time such as "17:00" — no class may end later.' },
        priorities: { type: 'array', items: { type: 'string', enum: TAGS }, description: 'Topic areas to prioritize, most important first.' },
        avoidDays: { type: 'array', items: { type: 'string', enum: DAYS }, description: 'Weekdays to keep free.' } } } },

    { name: 'suggest_alternatives', kind: 'draft',
      description: 'For one course in the current DRAFT schedule, return 2-3 replacement options that fit around every other draft course unchanged. Each option states which graduation requirement it satisfies, its weekly workload in hours, whether it has a team project or lab, how well it matches the student’s interests, and the explicit trade-off against the course being replaced. Also returns what deferring the original course costs — whether it is required for the major and which later courses it unblocks. Use this when the student wants to change one course without rebuilding the whole schedule.',
      inputSchema: { type: 'object', properties: { courseCode: code('The draft course to replace, e.g. CS320.') }, required: ['courseCode'] } },

    { name: 'swap_draft_course', kind: 'draft',
      description: 'Swap one course out of the DRAFT schedule and optionally another in, leaving every other draft course exactly as it is. Omit replaceWith to simply remove the course and leave the slot open. This edits the draft only — no seats are held and nothing is registered.',
      inputSchema: { type: 'object', properties: {
        remove: code('Course code to take out of the draft.'),
        replaceWith: code('Course code to put in its place. Omit to leave the slot empty.') }, required: ['remove'] } },

    { name: 'explain_course_impact', kind: 'read',
      description: 'Explain what one course means for the student’s path to graduation: which requirement it satisfies, whether it is required or elective, which later courses it unlocks as a prerequisite, its weekly workload and project/lab profile, and what deferring it to a later term would cost.',
      inputSchema: { type: 'object', properties: { courseCode: code('Course code such as CS320.') }, required: ['courseCode'] } },

    { name: 'register_course', kind: 'gated',
      description: 'Request registration for one or more courses. SENSITIVE ACTION: the portal asks the student to confirm, and nothing is enrolled until they click Confirm themselves. The result states what happened — never tell the student they are registered unless it says so.',
      inputSchema: { type: 'object', properties: { courseCodes: { type: 'array', items: { type: 'string' }, description: 'Course codes, e.g. ["CS360","CS380"].' } }, required: ['courseCodes'] },
      annotations: { destructiveHint: false, idempotentHint: false } },

    { name: 'drop_course', kind: 'gated',
      description: 'Request dropping a registered course. SENSITIVE ACTION: the student must confirm in the portal before anything changes.',
      inputSchema: { type: 'object', properties: { courseCode: code('Registered course to drop.') }, required: ['courseCode'] },
      annotations: { destructiveHint: true } },

    { name: 'join_waitlist', kind: 'gated',
      description: 'Request adding the student to the waitlist for a course that has no open seats (or leaving it). The student confirms in the portal; the result reports the queue position once applied.',
      inputSchema: { type: 'object', properties: {
        courseCode: code('Course code with no open seats.'),
        leave: { type: 'boolean', description: 'Set true to remove the student from that waitlist instead.' } }, required: ['courseCode'] } },

    { name: 'get_degree_audit', kind: 'read',
      description: 'Return the student’s degree audit (Area Requirement Summary, Computer Science B.S.): every requirement area and item with Met / Not Met status taken from the student’s own audit snapshot, the major courses already completed, and for each open item the eligible Spring 2026–27 sections that would count toward it (or why a required course cannot be taken yet). Opens the Degree Audit page. Use this for any question about what the student still needs.',
      inputSchema: { type: 'object', properties: {} } },

    { name: 'get_phase1_recommendations', kind: 'read',
      description: 'Rank real Spring 2026–27 sections (public Bucknell feed, saved snapshot — not live) against the open items in the student’s degree audit. Each result lists which open audit items it would count toward (courses that close several rank higher), prerequisites, unreserved seats, instructor permission, section footnotes and other cautions. Opens Smart Recommendations.',
      inputSchema: { type: 'object', properties: {
        interests: { type: 'array', items: { type: 'string', enum: ['ai', 'security', 'data'] }, description: 'Interest signals to include in ranking.' },
        stat227Completed: { type: 'boolean', description: 'Test switch: treat STAT 227 as completed to show how the ranking changes.' } } } },

    { name: 'get_schedule', kind: 'read',
      description: 'Return the student’s registered courses with instructors, meeting times, rooms, total credits, any waitlists they are on, and the current draft if one exists.',
      inputSchema: { type: 'object', properties: {} } },

    { name: 'update_preferences', kind: 'draft',
      description: 'Save the student’s advising preferences so later recommendations respect them: interests, credit cap, earliest start, latest end, days to keep free. Only call when the student asks to change their defaults.',
      inputSchema: { type: 'object', properties: {
        interests: { type: 'array', items: { type: 'string', enum: TAGS } },
        maxCredits: { type: 'integer', minimum: 1, maximum: 21 },
        earliestStart: { type: 'string', description: '24h time such as "10:00".' },
        latestEnd: { type: 'string', description: '24h time such as "18:00".' },
        avoidDays: { type: 'array', items: { type: 'string', enum: DAYS } } } } },
  ];

  /** Function declarations in Gemini API shape (stable order, no extra keys). */
  function forGemini() {
    return TOOLS.map(t => ({ name: t.name, description: t.description, parametersJsonSchema: t.inputSchema }));
  }

  return { TOOLS, TAGS, DAYS, forGemini };
});
