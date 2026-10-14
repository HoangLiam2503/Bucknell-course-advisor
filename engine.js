/* Advisor engine — pure logic, no DOM.
   Works as a browser global (window.Advisor) and as a Node module (for tests). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Advisor = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  // ---------- Helpers ----------
  function toMin(hhmm) { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; }
  function fmt(min) {
    const h = Math.floor(min / 60), m = min % 60;
    const suffix = h >= 12 ? 'pm' : 'am';
    const h12 = ((h + 11) % 12) + 1;
    return `${h12}:${String(m).padStart(2, '0')} ${suffix}`;
  }
  const DAY_LABEL = { Mon: 'Mon', Tue: 'Tue', Wed: 'Wed', Thu: 'Thu', Fri: 'Fri' };

  // ---------- Seed data ----------
  const DEFAULT_PROFILE = {
    name: 'Liam Nguyen',
    studentId: 'BU-2023-4471',
    major: 'Computer Science',
    college: 'College of Arts & Sciences',
    year: 'Junior',
    gpa: 0, creditsCompleted: 0, creditsRequired: 128, completed: [], // filled from transcript below
    interests: ['ai', 'security', 'web'],
    careerGoal: 'Security-focused software engineer with ML exposure',
    maxCredits: 15,
    earliestStart: '10:00',
    latestEnd: '18:00',
    avoidDays: [],
  };

  const TAG_LABEL = {
    ai: 'AI & ML', security: 'Cybersecurity', web: 'Web development', data: 'Data',
    core: 'CS core', ethics: 'Ethics', business: 'Business', design: 'Design',
  };

  // schedule: days[], start/end "HH:MM" (24h)
  const CATALOG = [
    c('CS301', 'Data Structures & Algorithms II', 3, 'Computer Science', ['CS201'], 2.0, 12, 40, ['Mon', 'Wed'], '09:00', '10:15', ['core'],
      'Advanced trees, graphs, amortized analysis and algorithm design paradigms.', 'Prof. Meredith Kwan', 'Dana 118'),
    c('CS320', 'Operating Systems', 3, 'Computer Science', ['CS201', 'CS210'], 2.5, 5, 35, ['Tue', 'Thu'], '13:00', '14:15', ['core'],
      'Processes, threads, scheduling, memory management, file systems and concurrency.', 'Prof. Alan Doyle', 'Dana 234'),
    c('CS340', 'Database Systems', 3, 'Computer Science', ['CS201'], 2.0, 20, 40, ['Mon', 'Wed'], '11:00', '12:15', ['web', 'data'],
      'Relational modeling, SQL, indexing, transactions and an introduction to NoSQL stores.', 'Prof. Priya Raghavan', 'Dana 212'),
    c('CS350', 'Web Application Development', 3, 'Computer Science', ['CS201'], 2.0, 8, 30, ['Tue', 'Thu'], '10:30', '11:45', ['web'],
      'Full-stack web apps: HTTP, REST APIs, modern front-end frameworks and deployment.', 'Prof. Marcus Ellery', 'Breakiron 65'),
    c('CS351', 'Advanced Web Frameworks', 3, 'Computer Science', ['CS350'], 2.5, 15, 30, ['Mon', 'Wed'], '14:00', '15:15', ['web'],
      'Server-side rendering, state management, performance and production architecture.', 'Prof. Priya Raghavan', 'Dana 212'),
    c('CS360', 'Introduction to Artificial Intelligence', 3, 'Computer Science', ['CS201', 'MATH201'], 3.0, 3, 40, ['Mon', 'Wed'], '10:30', '11:45', ['ai'],
      'Search, knowledge representation, planning, and foundations of machine learning.', 'Prof. Hana Sørensen', 'Dana 118'),
    c('CS361', 'Machine Learning', 3, 'Computer Science', ['CS360', 'MATH201'], 3.2, 10, 35, ['Tue', 'Thu'], '15:00', '16:15', ['ai', 'data'],
      'Supervised and unsupervised learning, model evaluation and neural networks.', 'Prof. Hana Sørensen', 'Dana 240'),
    c('CS370', 'Computer Networks', 3, 'Computer Science', ['CS210'], 2.0, 18, 40, ['Tue', 'Thu'], '08:30', '09:45', ['security', 'core'],
      'TCP/IP stack, routing, transport protocols and network programming.', 'Prof. Alan Doyle', 'Breakiron 151'),
    c('CS380', 'Introduction to Cybersecurity', 3, 'Computer Science', ['CS210'], 2.5, 6, 30, ['Mon', 'Wed'], '13:00', '14:15', ['security'],
      'Threat models, authentication, access control, common vulnerabilities and defenses.', 'Prof. Nadia Okonkwo', 'Dana 234'),
    c('CS381', 'Ethical Hacking & Penetration Testing', 3, 'Computer Science', ['CS380'], 3.0, 4, 20, ['Fri'], '10:00', '12:45', ['security'],
      'Hands-on offensive security in a controlled lab: recon, exploitation and reporting.', 'Prof. Nadia Okonkwo', 'Dana 138 Lab'),
    c('CS385', 'Applied Cryptography', 3, 'Computer Science', ['CS201', 'MATH201'], 3.3, 9, 25, ['Tue', 'Thu'], '10:30', '11:45', ['security'],
      'Symmetric and public-key cryptography, hashing, protocols and real-world failures.', 'Prof. Emil Vasquez', 'Olin 268'),
    c('CS390', 'Software Engineering', 3, 'Computer Science', ['CS201'], 2.0, 0, 40, ['Mon', 'Wed'], '15:30', '16:45', ['core', 'web'],
      'Team-based development lifecycle: requirements, design, testing and delivery.', 'Prof. Marcus Ellery', 'Dana 212'),
    c('CS410', 'Cloud Computing', 3, 'Computer Science', ['CS320'], 2.5, 14, 30, ['Tue', 'Thu'], '13:00', '14:15', ['web'],
      'Virtualization, containers, orchestration, serverless and cloud-native design.', 'Prof. Rebecca Tran', 'Breakiron 65'),
    c('CS420', 'Natural Language Processing', 3, 'Computer Science', ['CS360'], 3.3, 7, 25, ['Fri'], '13:00', '15:45', ['ai'],
      'Text representation, language models, sequence labeling and transformers.', 'Prof. Hana Sørensen', 'Dana 240'),
    c('CS430', 'Human-Computer Interaction', 3, 'Computer Science', ['CS201'], 2.0, 11, 30, ['Fri'], '09:00', '11:45', ['web', 'design'],
      'User research, prototyping, usability evaluation and accessible interface design.', 'Prof. Julianne Vance', 'Coleman 22'),
    c('MATH301', 'Linear Algebra', 3, 'Mathematics', ['MATH201'], 2.0, 22, 50, ['Mon', 'Wed'], '08:00', '09:15', ['ai', 'data'],
      'Vector spaces, matrices, eigenvalues and applications to computing.', 'Prof. Emil Vasquez', 'Olin 268'),
    c('MATH310', 'Probability & Statistics', 3, 'Mathematics', ['MATH201'], 2.0, 16, 50, ['Tue', 'Thu'], '09:00', '10:15', ['ai', 'data'],
      'Probability theory, distributions, estimation and hypothesis testing.', 'Prof. Samuel Byrd', 'Olin 372'),
    c('STAT330', 'Data Analysis with Python', 3, 'Statistics', ['MATH201', 'CS102'], 2.5, 9, 30, ['Mon', 'Wed'], '16:00', '17:15', ['data', 'ai'],
      'Practical data wrangling, visualization and statistical modeling in Python.', 'Prof. Samuel Byrd', 'Dana 138 Lab'),
    c('PHIL240', 'Ethics of Technology', 3, 'Philosophy', [], 0, 25, 40, ['Tue'], '14:30', '17:00', ['ethics'],
      'Privacy, algorithmic fairness, autonomy and the responsibilities of technologists.', 'Prof. Claire Whitfield', 'Vaughan 219'),
    c('BUS210', 'Technology Entrepreneurship', 3, 'Business', [], 0, 30, 40, ['Wed'], '17:30', '20:00', ['business'],
      'From idea to venture: customer discovery, business models and pitching.', 'Prof. Daniel Osei', 'Taylor 210'),
    c('CS295', 'Technical Writing for Computer Science', 2, 'Computer Science', ['ENG101'], 0, 20, 30, ['Fri'], '14:00', '15:40', ['core'],
      'Clear documentation, design docs, and communicating technical work to stakeholders.', 'Prof. Claire Whitfield', 'Coleman 14'),
    c('ART150', 'Digital Design Fundamentals', 3, 'Art & Design', [], 0, 12, 25, ['Thu'], '17:00', '19:30', ['design', 'web'],
      'Typography, layout, color and visual hierarchy for screens.', 'Prof. Julianne Vance', 'Coleman 105'),
  ];

  function c(code, title, credits, dept, prereqs, minGpa, seats, capacity, days, start, end, tags, description, instructor, room) {
    return { code, title, credits, dept, prereqs, minGpa, seats, capacity, days, start, end, tags, description, instructor, room, waitlist: seats === 0 ? 9 : 0, onWaitlist: false, waitlistPosition: null };
  }


  // ---------- Transcript (source of truth for completed courses + GPA) ----------
  const GRADE_POINTS = { 'A': 4.0, 'A-': 3.7, 'B+': 3.3, 'B': 3.0, 'B-': 2.7, 'C+': 2.3, 'C': 2.0 };
  const TRANSCRIPT = [
    { term: 'Fall 2024', courses: [
      ['CS101', 'Introduction to Computer Science I', 4, 'A'],
      ['MATH101', 'Calculus I', 4, 'B+'],
      ['ENG101', 'Writing & Rhetoric', 3, 'A-'],
      ['HIST110', 'World History to 1500', 4, 'B'],
    ]},
    { term: 'Spring 2025', courses: [
      ['CS102', 'Introduction to Computer Science II', 4, 'A'],
      ['MATH201', 'Discrete Mathematics', 4, 'B'],
      ['PHYS101', 'Classical & Modern Physics I', 4, 'B+'],
      ['ECON103', 'Principles of Economics', 4, 'B+'],
    ]},
    { term: 'Fall 2025', courses: [
      ['CS201', 'Data Structures & Algorithms I', 4, 'A-'],
      ['CS210', 'Computer Organization', 4, 'B+'],
      ['PSYC100', 'Introduction to Psychology', 4, 'A'],
      ['SPAN101', 'Elementary Spanish I', 4, 'B+'],
    ]},
    { term: 'Spring 2026', courses: [
      ['HUMN201', 'Humanities Seminar', 4, 'B+'],
      ['MUSC120', 'Music Theory Fundamentals', 3, 'A-'],
      ['GEOL110', 'Earth Systems', 4, 'B'],
      ['LING101', 'Introduction to Linguistics', 4, 'A-'],
    ]},
  ];
  function termGpa(courses){ const pts=courses.reduce((s,[,,cr,g])=>s+cr*GRADE_POINTS[g],0), cr=courses.reduce((s,[,,c])=>s+c,0); return cr?pts/cr:0; }
  const ALL_TAKEN = TRANSCRIPT.flatMap(t => t.courses);
  const CREDITS_EARNED = ALL_TAKEN.reduce((s, [,, cr]) => s + cr, 0);
  const CUM_GPA = Math.round(termGpa(ALL_TAKEN) * 100) / 100;

  // ---------- Degree requirements: B.S. Computer Science, 128 credits ----------
  // Each requirement: { name, credits, options: [codes], choose }  — choose = how many of options are needed
  const DEGREE_REQUIREMENTS = [
    { area: 'Computer Science core', items: [
      { name: 'CS I & II', options: ['CS101', 'CS102'], choose: 2 },
      { name: 'Data Structures & Algorithms I/II', options: ['CS201', 'CS301'], choose: 2 },
      { name: 'Computer Organization', options: ['CS210'], choose: 1 },
      { name: 'Operating Systems', options: ['CS320'], choose: 1 },
      { name: 'Database Systems', options: ['CS340'], choose: 1 },
      { name: 'Software Engineering', options: ['CS390'], choose: 1 },
      { name: 'Senior Capstone', options: ['CS499'], choose: 1 },
    ]},
    { area: 'Mathematics', items: [
      { name: 'Calculus I', options: ['MATH101'], choose: 1 },
      { name: 'Discrete Mathematics', options: ['MATH201'], choose: 1 },
      { name: 'Linear Algebra or Probability', options: ['MATH301', 'MATH310'], choose: 1 },
    ]},
    { area: 'Computer Science electives (300/400 level)', items: [
      { name: 'CS elective', options: ['CS350','CS351','CS360','CS361','CS370','CS380','CS381','CS385','CS410','CS420','CS430','STAT330'], choose: 4 },
    ]},
    { area: 'Science & writing', items: [
      { name: 'Laboratory science', options: ['PHYS101', 'GEOL110'], choose: 2 },
      { name: 'Writing & Rhetoric', options: ['ENG101'], choose: 1 },
      { name: 'Technical Writing for CS', options: ['CS295'], choose: 1 },
    ]},
    { area: 'College core curriculum', items: [
      { name: 'Humanities', options: ['HIST110', 'HUMN201', 'MUSC120'], choose: 2 },
      { name: 'Social science', options: ['ECON103', 'PSYC100'], choose: 1 },
      { name: 'Language', options: ['SPAN101'], choose: 1 },
      { name: 'Ethics of Technology', options: ['PHIL240'], choose: 1 },
    ]},
  ];

  /** Returns per-requirement status using transcript + currently registered courses. */
  function degreeAudit(profile, registered) {
    const done = new Set(profile.completed);
    const inProg = new Set(registered.map(c => c.code));
    const areas = DEGREE_REQUIREMENTS.map(a => ({
      area: a.area,
      items: a.items.map(it => {
        const completed = it.options.filter(o => done.has(o));
        const progress = it.options.filter(o => inProg.has(o));
        const have = completed.length + progress.length;
        const status = completed.length >= it.choose ? 'complete' : have >= it.choose ? 'in-progress' : 'remaining';
        const stillNeed = Math.max(0, it.choose - have);
        const available = it.options.filter(o => !done.has(o) && !inProg.has(o) && CATALOG.some(c => c.code === o));
        return { ...it, completed, inProgress: progress, status, stillNeed, availableThisTerm: available };
      })
    }));
    const inProgressCredits = registered.reduce((s, c) => s + c.credits, 0);
    return {
      creditsEarned: CREDITS_EARNED, creditsInProgress: inProgressCredits,
      creditsRequired: 128, creditsRemaining: Math.max(0, 128 - CREDITS_EARNED - inProgressCredits),
      gpa: CUM_GPA, areas,
    };
  }

  DEFAULT_PROFILE.gpa = CUM_GPA;
  DEFAULT_PROFILE.creditsCompleted = CREDITS_EARNED;
  DEFAULT_PROFILE.completed = ALL_TAKEN.map(([code]) => code);

  // ---------- Core logic ----------
  function findCourse(code) {
    if (!code) return null;
    const k = String(code).toUpperCase().replace(/\s+/g, '');
    return CATALOG.find(x => x.code === k) || null;
  }

  function overlaps(a, b) {
    const sharesDay = a.days.some(d => b.days.includes(d));
    if (!sharesDay) return false;
    return toMin(a.start) < toMin(b.end) && toMin(b.start) < toMin(a.end);
  }

  function conflictsWith(course, list) {
    return list.filter(x => x.code !== course.code && overlaps(course, x));
  }

  /**
   * Full eligibility report for one course.
   * registered = array of course objects currently in the plan.
   */
  function evaluate(course, profile, registered) {
    const reasons = [];
    const blockers = [];

    if (profile.completed.includes(course.code)) blockers.push('Already completed.');
    if (registered.some(r => r.code === course.code)) blockers.push('Already in your plan.');

    const missing = course.prereqs.filter(p => !profile.completed.includes(p));
    if (missing.length) blockers.push(`Missing prerequisite${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}.`);
    else if (course.prereqs.length) reasons.push(`Prerequisites met (${course.prereqs.join(', ')}).`);
    else reasons.push('No prerequisites.');

    if (course.minGpa > 0) {
      if (profile.gpa >= course.minGpa) reasons.push(`GPA ${profile.gpa.toFixed(1)} meets the ${course.minGpa.toFixed(1)} requirement.`);
      else blockers.push(`GPA ${profile.gpa.toFixed(1)} is below the ${course.minGpa.toFixed(1)} requirement.`);
    }

    const full = course.seats <= 0;
    if (full) blockers.push('Section is full (waitlist only).');
    else reasons.push(`${course.seats} of ${course.capacity} seats open.`);

    const conflicts = conflictsWith(course, registered);
    if (conflicts.length) blockers.push(`Time conflict with ${conflicts.map(x => x.code).join(', ')}.`);
    else if (registered.length) reasons.push('No time conflict with your current plan.');

    const matched = course.tags.filter(t => profile.interests.includes(t));
    if (matched.length) reasons.push(`Matches your interest in ${matched.map(t => TAG_LABEL[t]).join(' and ')}.`);

    const fitsTime = toMin(course.start) >= toMin(profile.earliestStart) && toMin(course.end) <= toMin(profile.latestEnd)
      && !course.days.some(d => (profile.avoidDays || []).includes(d));

    let status;
    if (blockers.some(b => b.startsWith('Already'))) status = 'taken';
    else if (blockers.some(b => b.startsWith('Missing') || b.startsWith('GPA'))) status = 'ineligible';
    else if (full) status = 'full';
    else if (conflicts.length) status = 'conflict';
    else status = 'eligible';

    return { course, status, eligible: status === 'eligible', reasons, blockers, matched, fitsTime, conflicts };
  }

  function searchCourses(profile, registered, opts = {}) {
    const q = (opts.query || '').toLowerCase().trim();
    const tag = opts.tag ? String(opts.tag).toLowerCase() : null;
    const dept = opts.department ? String(opts.department).toLowerCase() : null;
    return CATALOG
      .map(course => evaluate(course, profile, registered))
      .filter(r => {
        if (q && !(r.course.code.toLowerCase().includes(q) || r.course.title.toLowerCase().includes(q) || r.course.description.toLowerCase().includes(q))) return false;
        if (tag && !r.course.tags.includes(tag)) return false;
        if (dept && !r.course.dept.toLowerCase().includes(dept)) return false;
        if (opts.onlyEligible && !r.eligible) return false;
        return true;
      });
  }

  /**
   * Greedy schedule builder. Returns a proposal (not registered).
   * constraints: { maxCredits, earliestStart, latestEnd, priorities[], avoidDays[] }
   */
  function buildSchedule(profile, registered, constraints = {}) {
    const p = Object.assign({}, profile, {
      maxCredits: constraints.maxCredits || profile.maxCredits,
      earliestStart: constraints.earliestStart || profile.earliestStart,
      latestEnd: constraints.latestEnd || profile.latestEnd,
      avoidDays: constraints.avoidDays || profile.avoidDays || [],
    });
    const priorities = (constraints.priorities && constraints.priorities.length ? constraints.priorities : profile.interests).map(x => String(x).toLowerCase());

    const currentCredits = registered.reduce((s, r) => s + r.credits, 0);
    let budget = p.maxCredits - currentCredits;

    const candidates = CATALOG
      .map(course => evaluate(course, p, registered))
      .filter(r => r.eligible && r.fitsTime)
      .map(r => {
        const prioHits = r.course.tags.filter(t => priorities.includes(t)).length;
        const score = prioHits * 10 + (r.course.tags.includes('core') ? 3 : 0) + (r.course.seats < 8 ? 2 : 0);
        return { ...r, score, prioHits };
      })
      .sort((a, b) => b.score - a.score || a.course.code.localeCompare(b.course.code));

    const plan = [];
    const skipped = [];
    const tryAdd = (cand) => {
      if (cand.course.credits > budget) { skipped.push({ code: cand.course.code, why: 'would exceed credit limit' }); return; }
      const clash = conflictsWith(cand.course, [...registered, ...plan]);
      if (clash.length) { skipped.push({ code: cand.course.code, why: `conflicts with ${clash.map(x => x.code).join(', ')}` }); return; }
      plan.push(cand.course);
      budget -= cand.course.credits;
    };
    // Pass 1: courses in the student's priority areas. Pass 2: fill remaining credits with anything eligible.
    for (const cand of candidates) { if (budget <= 0) break; if (cand.prioHits > 0) tryAdd(cand); }
    for (const cand of candidates) { if (budget <= 0) break; if (cand.prioHits === 0 && !plan.includes(cand.course)) tryAdd(cand); }

    const explanation = plan.map(course => {
      const r = evaluate(course, p, registered);
      return { code: course.code, title: course.title, credits: course.credits, why: r.reasons.join(' ') };
    });

    return {
      plan, explanation, skipped,
      totalCredits: plan.reduce((s, x) => s + x.credits, 0),
      constraints: { maxCredits: p.maxCredits, earliestStart: p.earliestStart, latestEnd: p.latestEnd, priorities, avoidDays: p.avoidDays },
    };
  }

  function joinWaitlist(course) {
    if (course.seats > 0) return { ok: false, message: `${course.code} still has ${course.seats} open seats — register directly instead.` };
    if (course.onWaitlist) return { ok: false, message: `Already on the waitlist for ${course.code} at position ${course.waitlistPosition}.` };
    course.onWaitlist = true;
    course.waitlist += 1;
    course.waitlistPosition = course.waitlist;
    return { ok: true, position: course.waitlistPosition, message: `Added to the ${course.code} waitlist at position ${course.waitlistPosition} of ${course.waitlist}.` };
  }

  function leaveWaitlist(course) {
    if (!course.onWaitlist) return { ok: false, message: `Not on the waitlist for ${course.code}.` };
    course.onWaitlist = false; course.waitlist = Math.max(0, course.waitlist - 1); course.waitlistPosition = null;
    return { ok: true, message: `Removed from the ${course.code} waitlist.` };
  }


  // ---------- Workload profile: credits alone don't describe a term ----------
  const WORKLOAD = {
    CS301: { hours: 11, projects: 2, groupWork: false, labHours: 0, note: "Weekly problem sets and two solo implementation projects." },
    CS320: { hours: 14, projects: 3, groupWork: true, labHours: 0, note: "Three large systems projects, one with a partner. Historically the heaviest CS course at this level." },
    CS340: { hours: 9, projects: 2, groupWork: true, labHours: 0, note: "Two projects, the second is a team database build." },
    CS350: { hours: 11, projects: 4, groupWork: true, labHours: 0, note: "Four build-and-ship projects; the final one is a team app." },
    CS351: { hours: 12, projects: 3, groupWork: true, labHours: 0, note: "Project-heavy, with a substantial team capstone app." },
    CS360: { hours: 10, projects: 2, groupWork: false, labHours: 0, note: "Problem sets plus two solo agent-building projects." },
    CS361: { hours: 12, projects: 3, groupWork: false, labHours: 0, note: "Math-heavy problem sets and three modeling projects." },
    CS370: { hours: 9, projects: 2, groupWork: false, labHours: 2, note: "Weekly two-hour networking lab plus two projects." },
    CS380: { hours: 8, projects: 2, groupWork: false, labHours: 2, note: "Weekly lab in the security sandbox; two short projects." },
    CS381: { hours: 13, projects: 4, groupWork: true, labHours: 3, note: "Three-hour hands-on lab block, four graded engagements, one team red-team exercise." },
    CS385: { hours: 12, projects: 2, groupWork: false, labHours: 0, note: "Proof-based problem sets; lighter on projects, heavy on theory." },
    CS390: { hours: 13, projects: 1, groupWork: true, labHours: 0, note: "One semester-long team project with a real client. Almost all group work." },
    CS410: { hours: 10, projects: 3, groupWork: true, labHours: 0, note: "Three deployment projects, one team infrastructure build." },
    CS420: { hours: 11, projects: 3, groupWork: false, labHours: 0, note: "Three model-building projects; final is open-ended." },
    CS430: { hours: 8, projects: 3, groupWork: true, labHours: 0, note: "Design studio format: sketching, user testing, one team prototype." },
    MATH301: { hours: 8, projects: 0, groupWork: false, labHours: 0, note: "Weekly problem sets, two midterms, no projects." },
    MATH310: { hours: 8, projects: 0, groupWork: false, labHours: 0, note: "Weekly problem sets and a short data write-up." },
    STAT330: { hours: 9, projects: 3, groupWork: false, labHours: 0, note: "Three analysis notebooks, no exams." },
    PHIL240: { hours: 6, projects: 1, groupWork: false, labHours: 0, note: "Reading-driven with weekly short responses and one final paper." },
    BUS210: { hours: 7, projects: 1, groupWork: true, labHours: 0, note: "Team venture pitch developed across the semester." },
    CS295: { hours: 5, projects: 2, groupWork: false, labHours: 0, note: "Short writing assignments; lightest load in the catalog." },
    ART150: { hours: 8, projects: 4, groupWork: false, labHours: 0, note: "Four studio pieces, critique-based." }
  };
  function workloadOf(course) {
    const w = WORKLOAD[course.code] || { hours: course.credits * 3, projects: 0, groupWork: false, labHours: 0, note: '' };
    const band = w.hours >= 12 ? 'heavy' : w.hours >= 9 ? 'moderate' : 'light';
    return { ...w, band };
  }
  function workloadSummary(courses) {
    const hours = courses.reduce((s, c) => s + workloadOf(c).hours, 0);
    const projects = courses.reduce((s, c) => s + workloadOf(c).projects, 0);
    const group = courses.filter(c => workloadOf(c).groupWork);
    const labs = courses.filter(c => workloadOf(c).labHours > 0);
    const heavy = courses.filter(c => workloadOf(c).band === 'heavy');
    const band = hours >= 46 ? 'heavy' : hours >= 34 ? 'balanced' : 'light';
    return { hours, projects, groupCourses: group.map(c => c.code), labCourses: labs.map(c => c.code), heavyCourses: heavy.map(c => c.code), band };
  }

  // ---------- Graduation lens ----------
  /** Which degree requirement(s) a course would satisfy, and whether it is required or elective. */
  function requirementRole(code, profile, registered) {
    const audit = degreeAudit(profile, registered);
    for (const area of audit.areas) {
      for (const item of area.items) {
        if (!item.options.includes(code)) continue;
        const isNamed = item.options.length <= 2 && item.choose >= item.options.length;
        const inMajor = /Computer Science core|Mathematics/.test(area.area);
        const kind = isNamed ? 'required' : 'elective';
        const where = inMajor ? 'the major' : area.area.replace(/^College /, '').toLowerCase();
        const label = isNamed
          ? `Required — ${item.name} (${where})`
          : `Counts toward ${item.name}, ${area.area.toLowerCase()}${item.stillNeed ? ` — ${item.stillNeed} still needed` : ''}`;
        return { area: area.area, requirement: item.name, status: item.status, stillNeed: item.stillNeed, kind, inMajor, label, short: isNamed ? 'REQUIRED' : 'REQUIREMENT' };
      }
    }
    return { area: null, requirement: null, status: 'none', stillNeed: 0, kind: 'free', inMajor: false, label: 'Free elective — does not close a remaining requirement', short: 'ELECTIVE' };
  }

  /** Courses that list this one as a prerequisite. */
  function unlocks(code) { return CATALOG.filter(c => c.prereqs.includes(code)); }

  /** What deferring a course to a later term costs the student. */
  function deferralImpact(code, profile, registered) {
    const course = findCourse(code);
    if (!course) return null;
    const role = requirementRole(code, profile, registered);
    const blocked = unlocks(code);
    const notes = [];
    if (role.kind === 'required') notes.push(`${code} is a required major course, so it has to be taken eventually.`);
    if (blocked.length) notes.push(`Delaying it pushes ${blocked.map(c => c.code).join(' and ')} to a later term, since ${code} is their prerequisite.`);
    if (course.seats <= 6 && course.seats > 0) notes.push(`Only ${course.seats} seats remain this term, so a later term is not guaranteed.`);
    if (!notes.length) notes.push(`No downstream course depends on ${code}, so deferring it is low risk.`);
    return { code, role, blocks: blocked.map(c => ({ code: c.code, title: c.title })), notes };
  }

  /**
   * Alternatives for one course in a draft plan, keeping every other course fixed.
   * Returns ranked options with an explicit trade-off against the course being replaced.
   */
  function findAlternatives(outCode, profile, plan, registered = [], limit = 3) {
    const out = findCourse(outCode);
    if (!out) return { out: null, options: [] };
    const kept = plan.filter(c => c.code !== outCode);
    const keptWithReg = [...registered, ...kept];
    const outRole = requirementRole(outCode, profile, registered);
    const outW = workloadOf(out);
    const priorities = profile.interests.map(x => String(x).toLowerCase());

    const options = CATALOG
      .filter(c => c.code !== outCode && !kept.some(k => k.code === c.code))
      .map(c => evaluate(c, profile, keptWithReg))
      .filter(r => r.eligible && r.fitsTime)
      .map(r => {
        const c = r.course, w = workloadOf(c), role = requirementRole(c.code, profile, registered);
        const prioHits = c.tags.filter(t => priorities.includes(t)).length;
        const score = (role.kind === 'required' ? 14 : role.kind === 'elective' ? 8 : 0) + prioHits * 6
          + (c.credits === out.credits ? 3 : 0) + (c.seats < 8 ? 2 : 0);
        const tradeoffs = [];
        const dh = w.hours - outW.hours;
        if (Math.abs(dh) >= 2) tradeoffs.push(dh > 0 ? `About ${dh} more hours a week than ${outCode}.` : `About ${Math.abs(dh)} fewer hours a week than ${outCode}.`);
        else tradeoffs.push(`Similar weekly load to ${outCode}.`);
        if (w.groupWork && !outW.groupWork) tradeoffs.push('Adds a team project to the term.');
        if (!w.groupWork && outW.groupWork) tradeoffs.push('Removes a team project from the term.');
        if (w.labHours) tradeoffs.push(`Includes a ${w.labHours}-hour weekly lab.`);
        if (c.credits !== out.credits) tradeoffs.push(`${c.credits} credits instead of ${out.credits}.`);
        if (role.kind === 'free' && outRole.kind !== 'free') tradeoffs.push(`Unlike ${outCode}, it does not close a remaining graduation requirement.`);
        if (role.kind !== 'free' && outRole.kind === 'free') tradeoffs.push('Closes a requirement that is still outstanding.');
        return { course: c, role, workload: w, score, prioHits, tradeoffs,
          fit: prioHits ? `Matches your interest in ${c.tags.filter(t => priorities.includes(t)).map(t => TAG_LABEL[t]).join(' and ')}.` : 'Outside your stated interest areas.' };
      })
      .sort((a, b) => b.score - a.score || a.course.code.localeCompare(b.course.code))
      .slice(0, limit);

    return { out, outRole, outWorkload: outW, deferral: deferralImpact(outCode, profile, registered), kept, options };
  }

  function describeSchedule(course) {
    return `${course.days.join('/')} ${fmt(toMin(course.start))}–${fmt(toMin(course.end))}`;
  }

  return { CATALOG, DEFAULT_PROFILE, TAG_LABEL, DAY_LABEL, findCourse, evaluate, searchCourses, buildSchedule, conflictsWith, describeSchedule, joinWaitlist, leaveWaitlist, workloadOf, workloadSummary, requirementRole, unlocks, deferralImpact, findAlternatives, WORKLOAD, toMin, fmt, TRANSCRIPT, GRADE_POINTS, DEGREE_REQUIREMENTS, degreeAudit, termGpa };
});
