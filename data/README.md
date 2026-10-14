# Phase 1 data provenance

## Degree requirements

`bscs-2026-27.json` is transcribed from Bucknell's official 2026–27 Bachelor of Science in Computer Science catalog:

https://coursecatalog.bucknell.edu/collegeofartsandsciencescurricula/areasofstudy/computersciencecsci/

The 2026–27 catalog applies to the Class of 2030. A production degree audit must select requirements by the student's entry year rather than always using this file.

`cas-core-class-2024.json` is transcribed from Bucknell's Class of 2024 General University Requirements page. It covers the 32-credit graduation minimum, University writing requirement and College of Arts & Sciences College Core Curriculum. It is intentionally labelled as a different cohort from the 2026–27 BSCS map:

https://www.bucknell.edu/meet-bucknell/class-pages/class-2024/course-information-first-year-students/general-university-requirements

## Spring offerings

`spring-2027-sections.json` was generated from Bucknell Course Information term `202705` (Spring Term 2026–2027):

- `data/course/term/202705`
- `data/banner/term/202705/seats`

The snapshot contains course sections, CRNs, credits, meetings, instructors, requirement designations, reserved-seat counts and the reported live open-seat value. `phase1-recommender.js` subtracts reserved seats before treating a section as available.

Seat data is volatile. Run `node scripts/fetch-spring-2027.mjs` before producing a live recommendation.

Course Information does not expose a public historical grade-distribution or student-outcomes feed. Those signals are intentionally outside Phase 1.
