# CLAUDE.md — Bucknell Course Advisor

Static-HTML course-registration portal with an in-portal Gemini advisor and WebMCP tools. No framework, no bundler, no build step. See @README.md for the product story and @data/README.md for data provenance.

## Stack & layout
- Plain HTML/CSS/JS. `index.html` holds the UI and `TOOL_HANDLERS`; scripts load as classic `<script>` tags, then one `type="module"` block.
- `engine.js`, `phase1-recommender.js`, `spring-planner.js`, `advisor-tools.js` are UMD-style (`module.exports` in Node, global in the browser). Keep them dependency-free and DOM-free so Node tests can load them.
- `advisor-tools.js` is the single source of tool names/descriptions/schemas, shared by WebMCP registration, the in-portal chat and `api/advisor.js`. Change a tool there first, then its handler in `index.html`.
- `api/advisor.js` is a Vercel function (CommonJS) proxying Gemini. It owns the API key, system prompt and tool list; the browser owns state and runs tools.
- `data/*.json` are saved snapshots (degree audit, BSCS 2026–27 requirements, Spring 2027 sections). Refresh sections with `node scripts/fetch-spring-2027.mjs`.

## Commands
- `npm run dev` — `vercel dev` (needs `GEMINI_API_KEY` in `.env.local`)
- `npm test` — runs `test-phase1.js`, `test-planner.js`, `test-advisor-api.js` (plain Node, no test runner)
- No lint/typecheck/build scripts exist. Don't invent them.

## Conventions
- CommonJS in `api/` and the UMD modules; ES module syntax only inside the `index.html` module block.
- Match the existing style: 2-space indent, single quotes, semicolons, terse block comments explaining *why*.
- New pure logic goes in the engine/planner files with a test, not inline in `index.html`.
- Never hardcode secrets. `.env.local` is gitignored; the Gemini key is read from `process.env` only.

## Advisor guardrails (don't weaken)
- The advisor only advises and drafts. `register_course`, `drop_course`, `join_waitlist` must go through the student's confirmation dialog.
- Spring 2026–27 uses real sections via `plan_spring_schedule`; the Fall 2026 catalog is demo data. Don't mix the demo profile's GPA/completed list with the degree audit.
- Always label data as a saved snapshot, never live or official. Seats: subtract reserved seats before calling a section available.
- If you edit the system prompt in `api/advisor.js`, rerun `test-advisor-api.js`.

## Design system
- Tokens live in `styles.css` `:root` (light) with dark overrides under `prefers-color-scheme` and `[data-theme]`. Use the existing tokens (`--bg`, `--panel`, `--text-2`, `--orange`, `--accent`, `--navy`, `--space-*`, `--radius-*`). Don't rename them — inline styles generated in `index.html` read them.
- Type: Geist (sans), Geist Mono (course codes, times), Source Serif 4 (display headings). Don't introduce Inter/Roboto/Arial or Space Grotesk.
- Palette: Bucknell orange is the dominant accent, navy and blue secondary. Draft = dashed blue, registered = solid orange. No purple gradients.
- Every color change must work in both light and dark themes. Body text contrast ≥ 4.5:1.
- Motion: CSS-only, one staggered page-load reveal; respect `prefers-reduced-motion`. No per-element micro-animation noise.
- Keep the layout distinctive and information-dense; avoid generic card-grid-card-grid sections. Semantic HTML, `:focus-visible` states, `aria-label` on icon-only buttons.

## Verifying changes
- Logic: `npm test`.
- UI: run the portal and look at it in both themes and at mobile width before saying it works; for advisor changes, exercise the chat end to end.

## Gotchas
- `.vercel/` and `.env*` are gitignored; `.env.local` contains `VERCEL_OIDC_TOKEN` and `GEMINI_API_KEY` — never print or commit them.
- Model is `gemini-3.5-flash-lite` (free tier); quota errors are classified in `api/advisor.js`.
- Git: branch per task (`feat/`, `fix/`), conventional commits, commit only when asked.
