# Bucknell Course Advisor — an AI-native student portal built on WebMCP

A university course-registration portal where the AI in your browser acts as an **academic advisor that can actually do things**: read your profile, search the catalog, check prerequisites and seat availability, build a conflict-free schedule from a plain-language request, and register you — with every enrollment change gated behind a confirmation you click yourself.

Students do not need ChatGPT to use the core experience. The portal includes an **Ask AI Advisor** panel powered by Google Gemini: students ask in plain language, the advisor calls the same fourteen portal tools that WebMCP exposes, explains every recommendation (requirement, prerequisites, conflicts, credits, workload, seats, warnings) and builds a draft schedule. It never registers anyone — enrollment changes appear as a card the student must confirm. WebMCP remains an additional client channel rather than the only interface.

Built for the **OpenAI WebMCP Challenge** (webmcp.devpost.com).

## What makes this an advisor, not a schedule filter

- **Change one course, keep the rest.** `suggest_alternatives` holds every other draft course fixed and returns ranked replacements. Rebuilding the whole plan to change one slot is exactly the frustration this avoids.
- **Every recommendation carries a graduation lens.** Each course shows whether it is *required for the major*, *closes a remaining requirement*, or is a *free elective* — and deferring a course reports what it blocks downstream (skipping CS320 pushes CS410 to a later term).
- **Workload, not just credits.** 15 credits is not a light term. Each course carries weekly hours, project count, team-project and lab flags; the draft totals them and names the heaviest course.
- **Draft and registered never blur.** The draft is labelled *"Draft schedule — no seats held"*, appears as dashed blue blocks on the timetable against solid orange for registered courses, and the credit line reads e.g. *"6 of 15 credits registered · 9 in draft"*.

## Why this is a strong fit for WebMCP

Course registration is a task every student dreads: cross-checking prerequisites, GPA cutoffs, open seats and time conflicts across dozens of courses, then clicking through a multi-step form under a deadline. A chatbot can *talk* about it. With WebMCP, the agent works on the **same live page** the student is looking at:

- **Structured, not scraped.** Instead of screenshots and guessed clicks, the page exposes fourteen typed tools with schemas — `search_courses` returns eligibility status with reasons, `build_schedule` returns a plan with the rationale for every pick.
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
| `get_phase1_recommendations` | Official 2026–27 BSCS requirements + Spring 2026–27 sections, ranked with reasons, cautions and reservation-aware seats | – |
| `get_schedule` | Current plan with credits and meeting times | – |
| `suggest_alternatives` | 2–3 replacements for one draft course, keeping the rest fixed; each with requirement, workload and explicit trade-offs | – |
| `swap_draft_course` | Swap one course out of the draft (and optionally another in) without rebuilding | – (draft only) |
| `explain_course_impact` | What a course means for graduation: requirement satisfied, courses it unlocks, workload, cost of deferring | – |
| `join_waitlist` | Join or leave the waitlist for a full course, returns queue position | – |
| `update_preferences` | Persist interests, credit limit, time window, days to avoid | – |

Tool names, descriptions and schemas live in `advisor-tools.js`, shared by the WebMCP registration, the in-portal advisor and the `/api/advisor` function. Handlers are in `index.html` (`TOOL_HANDLERS`). All scheduling and eligibility logic lives in `engine.js` (pure JavaScript, no dependencies) so it can be unit-tested with Node.

## In-portal AI advisor (Gemini)

```
browser: advisor-chat.js ──POST {messages}──▶ api/advisor.js ──▶ Gemini API (generateContent)
   ▲ runs tool_use with the portal's handlers   (API key, system prompt, tool list stay server-side)
   └ sends tool_result back, up to 6 rounds per question
```

- **Separation:** data and rules in `engine.js` / `phase1-recommender.js` / `data/`; tool contract in `advisor-tools.js`; handlers and UI in `index.html`; chat loop and cards in `advisor-chat.js`; LLM call in `api/advisor.js`.
- **Guardrails:** the advisor only drafts. `register_course`, `drop_course` and `join_waitlist` render a confirmation card in the chat; the portal re-checks eligibility and opens the confirm dialog only when the student clicks it.
- **Data honesty:** tool results carry a `dataSource` label (demo Fall 2026 catalog vs. official Spring 2026–27 snapshot, not live) and the system prompt forbids presenting either as real-time.
- **Fallback:** if `/api/advisor` is unreachable or not configured, the panel says so and uses the basic offline (rule-based) assistant.

### Configuration (Vercel environment variables)

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `GEMINI_API_KEY` | yes | – | Gemini API key from Google AI Studio. Never commit it; set it in Vercel or `.env.local`. |
| `ADVISOR_MODEL` | no | `gemini-3.8-flash` | Model id. `gemini-3.5-flash-lite` is faster with a larger free quota. |
| `GEMINI_THINKING_LEVEL` | no | `low` | `minimal` (Flash-Lite only), `low`, `medium` or `high`. Higher is slower and uses more of the quota. |
| `ADVISOR_ALLOWED_ORIGINS` | no | – | Extra comma-separated origins allowed to call the API (same host and localhost are always allowed). |
| `ADVISOR_DISABLED` | no | – | `1` pauses the advisor without calling the API (the panel shows "demo limit reached"). |

```bash
vercel env add GEMINI_API_KEY         # paste the key at the prompt, for Production/Preview/Development
vercel env pull .env.local            # local development (.env.* is git-ignored)
```

### Usage limits and cost

- **Free by construction:** create the key in Google AI Studio for a Google Cloud project **without billing enabled**. Such a project can only use the free tier, so it cannot be charged. When the free quota is used up the API answers `429 RESOURCE_EXHAUSTED`.
- **Paused, not retried:** a spent daily quota (or a billing spend cap) is returned to the browser as `limit_reached`, and the panel pauses itself for the session — no retries, no other model. A per-minute limit shows "try again shortly". `ADVISOR_DISABLED=1` pauses the advisor without calling the API.
- **Soft caps in the function:** origin check, 60 requests per IP per 10 minutes (per instance, best-effort), 2,000 characters per message, 80 messages per conversation, 8,192 output tokens per turn, at most 6 tool rounds per question.
- **Privacy:** Google may use free-tier prompts and responses to improve its products. This prototype only sends the demo profile and demo/snapshot course data; a production deployment with real student records needs the paid tier and a data-processing agreement.

## Run locally

```bash
npm install
vercel dev            # static site + /api/advisor, reads .env.local
# open http://localhost:3000
```

`python3 -m http.server 8080` still serves the static portal; the advisor then falls back to the offline assistant. Serve over HTTP rather than opening the file directly; some browser APIs are restricted on `file://`.

Tests (no API key needed):

```bash
npm test              # Phase 1 data checks + /api/advisor handler checks
```

## Test with a real agent

1. **ChatGPT desktop app** (macOS/Windows): open a Work or Codex chat, press ⌘⇧B / Ctrl⇧B to open the built-in browser, navigate to the URL, and check **Site tools** in the address bar — you should see the fourteen tools. Then ask ChatGPT to plan your semester. Requires a model with WebMCP enabled (GPT-5.6 Sol or Terra at time of writing).
2. **Google Chrome 149+**: enable `chrome://flags/#enable-webmcp-testing`, restart, open the URL.

The status line at the bottom of the page reports whether WebMCP is available. In other browsers the page tries to load the `@mcp-b/webmcp-polyfill` from esm.sh so tool logic can still be exercised from DevTools during development.

## Deploy

Deploy to Vercel (`vercel` for a preview, `vercel --prod` for production) after setting `ANTHROPIC_API_KEY`. The static portal alone still works on any static host (Netlify Drop, Cloudflare Pages) — the advisor then runs in offline mode. Keep `engine.js`, `phase1-recommender.js`, `advisor-tools.js`, `advisor-chat.js` and `data/` beside `index.html`.

## Pages

Registration (catalog + plan side by side), Course Catalog (full width), My Schedule (week grid + day list), Degree Audit, Transcript, and Smart Recommendations (the official-data Phase 1 sandbox). Navigation is hash-based (`#audit`, `#recommendations`, …) so the agent can send the student to a page by calling the matching tool.

## Data

The student's transcript (16 completed courses across four terms — GPA and credits earned are computed from it, not hard-coded), the B.S. Computer Science requirement map, and the Fall 2026 catalog (22 sections with instructors, rooms, prerequisites, GPA minimums, seats, waitlists and meeting times) are seeded in `engine.js` so the demo runs without a backend. Swapping in a real SIS API means replacing `CATALOG`, `DEFAULT_PROFILE`, and the `seats` mutations in `index.html`.

### Phase 1: official 2026–27 Bucknell data

The migration away from demo data has started in a separate, testable layer:

- `data/bscs-2026-27.json` encodes the official 2026–27 B.S. Computer Science requirements, including substitutions and science/writing rules.
- `data/cas-core-class-2024.json` encodes the University writing and College of Arts & Sciences core rules from Bucknell's Class of 2024 requirements page. The UI labels this separately because it is not the same cohort as the 2026–27 major catalog.
- `scripts/fetch-spring-2027.mjs` downloads the public Spring 2026–27 section and live-seat feeds from Bucknell Course Information.
- `data/spring-2027-sections.json` is the generated snapshot used for deterministic testing.
- `phase1-recommender.js` ranks sections by remaining requirements, prerequisite-path value, prior subject performance, interests and seat availability. A high grade only boosts a course when it also closes a remaining named requirement; otherwise it appears as context rather than the main recommendation reason.

Refresh and verify the official snapshot with:

```bash
node scripts/fetch-spring-2027.mjs
node test-phase1.js
```

The 2026–27 catalog applies to the Class of 2030. Production degree audits must select the catalog associated with each student's entry year.

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
