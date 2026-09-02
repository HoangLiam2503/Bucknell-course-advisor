# Bucknell Course Advisor — an AI-native student portal built on WebMCP

A university course-registration portal where the AI in your browser acts as an **academic advisor that can actually do things**: read your profile, search the catalog, check prerequisites and seat availability, build a conflict-free schedule from a plain-language request, and register you — with every enrollment change gated behind a confirmation you click yourself.

Built for the **OpenAI WebMCP Challenge** (webmcp.devpost.com).

## What makes this an advisor, not a schedule filter

- **Change one course, keep the rest.** `suggest_alternatives` holds every other draft course fixed and returns ranked replacements. Rebuilding the whole plan to change one slot is exactly the frustration this avoids.
- **Every recommendation carries a graduation lens.** Each course shows whether it is *required for the major*, *closes a remaining requirement*, or is a *free elective* — and deferring a course reports what it blocks downstream (skipping CS320 pushes CS410 to a later term).
- **Workload, not just credits.** 15 credits is not a light term. Each course carries weekly hours, project count, team-project and lab flags; the draft totals them and names the heaviest course.
- **Draft and registered never blur.** The draft is labelled *"Draft schedule — no seats held"*, appears as dashed blue blocks on the timetable against solid orange for registered courses, and the credit line reads e.g. *"6 of 15 credits registered · 9 in draft"*.

## Why this is a strong fit for WebMCP

Course registration is a task every student dreads: cross-checking prerequisites, GPA cutoffs, open seats and time conflicts across dozens of courses, then clicking through a multi-step form under a deadline. A chatbot can *talk* about it. With WebMCP, the agent works on the **same live page** the student is looking at:

- **Structured, not scraped.** Instead of screenshots and guessed clicks, the page exposes thirteen typed tools with schemas — `search_courses` returns eligibility status with reasons, `build_schedule` returns a plan with the rationale for every pick.
- **Shared context.** The student sees exactly what the agent does: search filters change on screen, the proposed schedule appears as dashed blocks on the timetable, and the activity log labels every action as **You** or **Advisor agent**.
- **Human-in-the-loop for sensitive actions.** `register_course` and `drop_course` open a confirmation dialog and the tool call *waits* for the student's click. The agent gets back "confirmed" or "declined" — it cannot enroll anyone on its own. This mirrors the pattern OpenAI and Chrome describe for purchases and other consequential actions.

## What people and agents can do together that was hard before

> "Plan my next semester: max 15 credits, nothing before 10 am, prioritize AI, cybersecurity and web development."

The agent calls `get_student_profile`, then `build_schedule` with those constraints. The page shows a five-course, 15-credit, conflict-free proposal with a reason for each course (prerequisites met, GPA ok, seats open, matches your interests) and lists what was skipped and why. The student reads it, asks a follow-up ("swap Operating Systems for something in data"), and when satisfied says "register them" — the agent calls `register_course`, the confirmation dialog appears, the student clicks Confirm. Timetable and credit total update instantly.

## WebMCP tools registered

| Tool | Purpose | Confirmation |
|---|---|---|
| `get_student_profile` | Major, year, GPA, completed courses, interests, preferences | – |
| `search_courses` | Catalog search with eligibility status + reasons | – |
| `check_eligibility` | Detailed report for one course; expands it on screen | – |
| `build_schedule` | Optimized proposal from credit cap, time window, priorities, days to avoid | – (proposal only) |
| `register_course` | Enroll in one or more courses | **Student must click Confirm** |
| `drop_course` | Remove a course from the plan | **Student must click Confirm** |
| `get_degree_audit` | Credits earned/in progress/remaining and every graduation requirement with status; opens the Degree Audit page | – |
| `get_schedule` | Current plan with credits and meeting times | – |
| `suggest_alternatives` | 2–3 replacements for one draft course, keeping the rest fixed; each with requirement, workload and explicit trade-offs | – |
| `swap_draft_course` | Swap one course out of the draft (and optionally another in) without rebuilding | – (draft only) |
| `explain_course_impact` | What a course means for graduation: requirement satisfied, courses it unlocks, workload, cost of deferring | – |
| `join_waitlist` | Join or leave the waitlist for a full course, returns queue position | – |
| `update_preferences` | Persist interests, credit limit, time window, days to avoid | – |

Tools are registered with `document.modelContext.registerTool(...)` in `index.html`. All scheduling and eligibility logic lives in `engine.js` (pure JavaScript, no dependencies) so it can be unit-tested with Node.

## Run locally

Static site, no build step.

```bash
python3 -m http.server 8080
# open http://localhost:8080
```

Serve over HTTP rather than opening the file directly; some browser APIs are restricted on `file://`.

## Test with a real agent

1. **ChatGPT desktop app** (macOS/Windows): open a Work or Codex chat, press ⌘⇧B / Ctrl⇧B to open the built-in browser, navigate to the URL, and check **Site tools** in the address bar — you should see the thirteen tools. Then ask ChatGPT to plan your semester. Requires a model with WebMCP enabled (GPT-5.6 Sol or Terra at time of writing).
2. **Google Chrome 149+**: enable `chrome://flags/#enable-webmcp-testing`, restart, open the URL.

The status line at the bottom of the page reports whether WebMCP is available. In other browsers the page tries to load the `@mcp-b/webmcp-polyfill` from esm.sh so tool logic can still be exercised from DevTools during development.

## Deploy

Drag the folder (`index.html`, `engine.js`) onto Netlify Drop, or `vercel --prod`, or connect the repo to Render / Cloudflare Pages with no build command.

## Pages

Registration (catalog + plan side by side), Course Catalog (full width), My Schedule (week grid + day list), Degree Audit (requirements with complete / in-progress / remaining status, driven by the transcript and current registrations), and Transcript. Navigation is hash-based (`#audit`, `#schedule`, …) so the agent can send the student to a page by calling the matching tool.

## Data

The student's transcript (16 completed courses across four terms — GPA and credits earned are computed from it, not hard-coded), the B.S. Computer Science requirement map, and the Fall 2026 catalog (22 sections with instructors, rooms, prerequisites, GPA minimums, seats, waitlists and meeting times) are seeded in `engine.js` so the demo runs without a backend. Swapping in a real SIS API means replacing `CATALOG`, `DEFAULT_PROFILE`, and the `seats` mutations in `index.html`.

## Verify the engine

```bash
node -e "
const A=require('./engine.js');
const b=A.buildSchedule(A.DEFAULT_PROFILE,[],{maxCredits:15,earliestStart:'10:00',priorities:['ai','security','web']});
console.log(b.plan.map(c=>c.code), b.totalCredits, b.skipped);
"
```

## License

MIT — see `LICENSE`.
