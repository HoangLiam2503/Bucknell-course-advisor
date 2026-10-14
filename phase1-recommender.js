/* Explainable Phase 1 recommender for Bucknell course planning.
   Requirements decide graduation value; grades are only an affinity signal. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Phase1Advisor = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const PREREQUISITES = {
    CSCI204: [['CSCI203', 'ECEG230']],
    CSCI205: [['CSCI204']],
    CSCI306: [['CSCI204']],
    CSCI307: [['CSCI306', 'CSCI206']],
    CSCI308: [['CSCI205']],
    CSCI311: [['CSCI204'], ['MATH241', 'CSCI241']],
    CSCI315: [['CSCI306']],
    CSCI341: [['MATH241', 'MATH280']],
    CSCI357: [['CSCI204'], ['STAT216', 'STAT227', 'MATH216', 'MATH227']],
    CSCI476: [['CSCI475']],
    MATH202: [['MATH201']],
    STAT217: [['STAT216']],
    STAT405: [['STAT217']]
  };

  const TAGS = {
    CSCI307: ['security', 'networks'],
    CSCI315: ['systems'],
    CSCI345: ['ethics'],
    CSCI357: ['ai', 'data'],
    DATA101: ['ai'],
    DATA145: ['ai', 'data'],
    DATA250: ['data'],
    STAT216: ['statistics', 'data'],
    STAT217: ['statistics', 'data'],
    STAT227: ['statistics'],
    STAT230: ['statistics', 'data'],
    STAT405: ['statistics', 'data']
  };

  const UNLOCKS = Object.entries(PREREQUISITES).reduce((out, [course, groups]) => {
    for (const option of groups.flat()) (out[option] ||= []).push(course);
    return out;
  }, {});

  function codeOf(section) { return `${section.Subj}${section.Number}`.replace(/\s/g, '').toUpperCase(); }
  function subjectOf(code) { return String(code).match(/^[A-Z]+/)?.[0] || ''; }
  function availableSeats(section) {
    const open = Number(section.openSeats ?? section.Seats ?? 0);
    const reserved = section.Res !== '' && section.Res != null && !Number.isNaN(Number(section.Res)) ? Number(section.Res) : 0;
    return Math.max(0, open - reserved);
  }

  function prerequisiteStatus(code, completed) {
    const groups = PREREQUISITES[code] || [];
    const missing = groups.filter(options => !options.some(c => completed.has(c)));
    return { met: missing.length === 0, missing };
  }

  function requirementStatus(program, completed, transcript = []) {
    const naturalSciences = transcript.filter(row => {
      const subject = subjectOf(row.code);
      const designations = row.designations || [];
      return !['MATH', 'CSCI'].includes(subject) && (designations.includes('NSMC') || designations.includes('LBSC'));
    });
    const labSciences = naturalSciences.filter(row => (row.designations || []).includes('LBSC'));
    return program.requirements.map(requirement => {
      if (requirement.id === 'lab-science') return { ...requirement, status: labSciences.length ? 'complete' : 'remaining' };
      if (requirement.id === 'science-elective') return { ...requirement, status: naturalSciences.length >= 2 ? 'complete' : 'remaining' };
      if (!requirement.courses) return { ...requirement, status: 'needs-designation-check' };
      const fulfilledBy = requirement.courses.find(code => completed.has(code));
      return { ...requirement, status: fulfilledBy ? 'complete' : 'remaining', fulfilledBy: fulfilledBy || null };
    });
  }

  function subjectAffinity(transcript, subject) {
    const points = { A: 4, 'A-': 3.7, 'B+': 3.3, B: 3, 'B-': 2.7, 'C+': 2.3, C: 2, 'C-': 1.7, D: 1 };
    const rows = transcript.filter(row => subjectOf(row.code) === subject && points[row.grade] != null);
    if (!rows.length) return null;
    return rows.reduce((sum, row) => sum + points[row.grade], 0) / rows.length;
  }

  function collegeCoreStatus(core, transcript = []) {
    return core.requirements.map(requirement => {
      if (requirement.manualCheck) return { ...requirement, status: 'advisor-check', matchedCourses: [], progress: 'Advisor verification required' };
      const matched = transcript.filter(row => {
        const codes = row.designations || [];
        const excluded = requirement.excludeDesignations || [];
        return requirement.designations.some(code => codes.includes(code)) && !excluded.some(code => codes.includes(code));
      });
      const learningGoalMatches = requirement.learningGoalDesignations
        ? matched.filter(row => requirement.learningGoalDesignations.some(code => (row.designations || []).includes(code)))
        : [];
      const countMet = matched.length >= requirement.count;
      const goalMet = !requirement.learningGoalCount || learningGoalMatches.length >= requirement.learningGoalCount;
      const status = countMet && goalMet ? 'complete' : 'remaining';
      const progressParts = [`${Math.min(matched.length, requirement.count)}/${requirement.count} course${requirement.count === 1 ? '' : 's'}`];
      if (requirement.learningGoalCount) progressParts.push(`${Math.min(learningGoalMatches.length, requirement.learningGoalCount)}/${requirement.learningGoalCount} learning goal`);
      return { ...requirement, status, matchedCourses: matched.map(row => row.code), progress: progressParts.join(' · ') };
    });
  }

  function coreMatchesForSection(coreStatuses, section) {
    if (!coreStatuses.length) return [];
    const sectionCodes = (section.Reqs || []).map(req => req.Code);
    return coreStatuses.filter(requirement => {
      if (requirement.status !== 'remaining' || requirement.manualCheck) return false;
      if ((requirement.excludeDesignations || []).some(code => sectionCodes.includes(code))) return false;
      return requirement.designations.some(code => sectionCodes.includes(code));
    });
  }

  function recommend({ program, collegeCore = null, offerings, transcript = [], interests = [], includeIntro = false }) {
    const completed = new Set(transcript.map(row => String(row.code).replace(/\s/g, '').toUpperCase()));
    const statuses = requirementStatus(program, completed, transcript);
    const coreStatuses = collegeCore ? collegeCoreStatus(collegeCore, transcript) : [];
    const remaining = new Map(statuses
      .filter(r => r.status === 'remaining')
      .flatMap(r => (r.courses || []).map(code => [code, r])));
    const remainingDesignations = statuses.filter(r => r.status === 'remaining' && r.designation);

    const byCourse = new Map();
    for (const section of offerings) {
      if (String(section.Number).endsWith('L') || String(section.Number).endsWith('R') || Number(section.Credit) === 0) continue;
      const code = codeOf(section);
      if (completed.has(code)) continue;
      const prereq = prerequisiteStatus(code, completed);
      const courseRequirement = remaining.get(code);
      const designationRequirement = remainingDesignations.find(r => {
        if ((r.excludedSubjects || []).includes(section.Subj)) return false;
        return (section.Reqs || []).some(req => req.Code === r.designation);
      });
      const requirement = courseRequirement || designationRequirement;
      const affinity = subjectAffinity(transcript, section.Subj);
      const tags = TAGS[code] || [];
      const interestMatches = tags.filter(tag => interests.includes(tag));
      const coreMatches = coreMatchesForSection(coreStatuses, section);
      const unlocks = (UNLOCKS[code] || []).filter(next => !completed.has(next));
      const openSeats = availableSeats(section);
      const isIntroOnly = ['CSCI100', 'CSCI101', 'DATA101'].includes(code);
      if (isIntroOnly && !includeIntro && !requirement) continue;

      let score = 0;
      const reasons = [];
      const cautions = [];
      if (requirement) {
        score += 60;
        reasons.push(`Completes remaining BSCS requirement: ${requirement.label}.`);
      }
      if (unlocks.length) {
        score += Math.min(20, unlocks.length * 5);
        reasons.push(`Unlocks ${unlocks.join(', ')}.`);
      }
      if (requirement && affinity != null && affinity >= 3.3) {
        score += Math.min(15, Math.round((affinity - 3) * 15));
        reasons.push(`Strong prior performance in ${section.Subj} (${affinity.toFixed(2)} average).`);
      } else if (!requirement && affinity != null && affinity >= 3.3) {
        cautions.push(`Strong ${section.Subj} performance noted, but this course does not close a remaining named BSCS requirement.`);
      }
      if (interestMatches.length) {
        score += interestMatches.length * 8;
        reasons.push(`Matches interest: ${interestMatches.join(', ')}.`);
      }
      if (coreMatches.length) {
        score += Math.min(36, coreMatches.length * 18);
        reasons.push(`Advances Arts & Sciences core: ${coreMatches.map(r => r.label).join('; ')}.`);
      }
      if (openSeats > 0) {
        score += Math.min(5, Math.ceil(openSeats / 5));
        reasons.push(`${openSeats} open seat${openSeats === 1 ? '' : 's'} in this section.`);
      } else cautions.push('No currently reported open seats.');
      if (!prereq.met) cautions.push(`Missing one prerequisite group: ${prereq.missing.map(x => x.join(' or ')).join('; ')}.`);

      const hasAcademicSignal = Boolean(requirement || coreMatches.length || unlocks.length || interestMatches.length || (affinity != null && affinity >= 3.3));
      if (!hasAcademicSignal) continue;

      const candidate = { code, title: section.Title, score, eligible: prereq.met && openSeats > 0, reasons, cautions, tags, coreRequirements: coreMatches.map(r => r.id), section };
      const existing = byCourse.get(code);
      if (!existing || candidate.score > existing.score || openSeats > Number(existing.section.openSeats || 0)) byCourse.set(code, candidate);
    }

    return [...byCourse.values()].sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.score - a.score || a.code.localeCompare(b.code));
  }

  return { PREREQUISITES, TAGS, codeOf, availableSeats, prerequisiteStatus, requirementStatus, collegeCoreStatus, subjectAffinity, recommend };
});
