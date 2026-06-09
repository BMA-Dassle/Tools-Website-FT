# Claude Working Guidelines — FastTrax Tools Monorepo

## Active multi-session work

**Monorepo restructure** in flight. Always read these BEFORE suggesting structural changes
or starting new feature work:

- [tasks/restructure-status.md](tasks/restructure-status.md) — current phase, next PR, what's done
- [tasks/restructure-plan.md](tasks/restructure-plan.md) — full plan: phases, conventions, migration backlog, guardrails
- [tasks/lessons.md](tasks/lessons.md) — accumulated lessons & guardrails (BMI ID precision, idempotency, etc.)
- [tasks/todo.md](tasks/todo.md) — open in-flight feature work (separate from restructure)

## Workspace shape (post-PR3)

- **npm workspaces + Turborepo** at root. `packageManager: npm@11.6.4`. Node 22+.
- **One Next app** at `apps/web/` (moved here in PR3 from `fasttrax-web/`; npm workspace name is still `fasttrax-web` — directory move did not rename the package).
- **Two Node bridges** at `kart-timing-bridge/` and `vt3-bridge/` (Railway-deployed; move to `apps/` in Phase 3).
- **`packages/*` and `apps/*` globs** reserved for future `@ft/*` packages (added PR4+).
- Run everything via npm + turbo:
  - `npm install` — at root (generates/updates the single workspace `package-lock.json`)
  - `npx turbo run build` — workspace-wide build
  - `npm run dev -w fasttrax-web` — dev server (the `-w` flag scopes to a workspace by package name)
- **One lockfile only** — the root `package-lock.json`. Workspace packages do NOT have their own lockfiles.
- **Why npm not pnpm:** see `tasks/lessons.md` "pnpm + Vercel = quagmire (2026-05-06)". Short version: pnpm 9/10's URLSearchParams bug + Vercel's bundled-pnpm version override fought us through three PRs and never converged. npm + Turborepo gives us 95% of the value without the fight.

## Where NEW code goes (v2 structure)

After PR3, all new code lives under `apps/web/src/`:

- **New features:** `apps/web/src/features/<name>/{data,service,hooks,queries,schemas,types,index}.ts`
- **Shared UI components:** `apps/web/src/components/ui/` — hand-rolled (Button, Card, Input, Modal, Spinner). **NO Shadcn.**
- **Feature-scoped components:** `apps/web/src/components/features/<feature>/`
- **Cross-feature hooks:** `apps/web/src/hooks/`
- **Generic utilities:** `apps/web/src/lib/{api,helpers,constants}/` — **NO business logic** (that goes in `features/<x>/service.ts`)
- **Routes stay at `apps/web/app/`** (App Router constraint). `route.ts` and `page.tsx` are thin shells: parse zod → auth → delegate to `~/features/<feature>/service.ts`.

Old code at `apps/web/{components,lib}/` keeps working unchanged. Migrate opportunistically per
[restructure-plan.md § Phase 3 v1 migration backlog](tasks/restructure-plan.md).

## Project-specific hard rules (non-negotiable)

Each rule below comes from a real production incident. Violating any of these is a senior-level
mistake — read the linked lesson before working in the affected area.

- **NEVER use `Number()` or `JSON.stringify()` on BMI personId / billId / orderId.** They exceed `Number.MAX_SAFE_INTEGER`. Use raw-text JSON injection (`stringifyWithRawIds` from `@ft/db`). See [tasks/lessons.md § BMI ID Precision](tasks/lessons.md).
- **NEVER `res.json()` / `JSON.parse()` a BMI or Pandora response that carries an id** (personId/billId/orderId/reservationId/projectId/orderItemId/billLineId). Standard parsing rounds 17-digit ids (the production off-by-one). Use `parseWithRawIds(await res.text())` from `@ft/db` (pair with `serializeWithRawIds` for GET→mutate→PUT round-trips). A `: string` type annotation does NOT prevent the corruption. See [tasks/lessons.md § BMI ID Precision → INBOUND](tasks/lessons.md).
- **NEVER add a new top-level page that uses `headers()` to switch on host without updating `isSharedTopLevelRoute` in `middleware.ts`** (PR3+: `SHARED_TOP_LEVEL_ROUTES` in `@ft/shared`). HeadPinz visitors will 404 otherwise.
- **NEVER install Shadcn/ui** or any other component-library kit. Custom components in `src/components/ui/` only.
- **NEVER introduce an ORM** (Prisma / Drizzle / Kysely). Raw SQL via `@neondatabase/serverless` stays — BMI precision constraint forbids ORMs that auto-cast bigints through JSON.
- **NEVER read `process.env` directly outside `@ft/env`** (once that package exists in PR4). Use the typed `env` export.
- **NEVER record session replay on admin routes** (`/admin/*`, `/api/admin/*`) — staff views of customer PII. (KBF routes ARE recorded as of 2026-06-09 per owner decision — no kids PII is captured; the prior COPPA-driven KBF exclusion is lifted. Keep Microsoft Clarity masking on "Strict" so typed input is never recorded.) See [restructure-plan.md § Statsig + Session Replay](tasks/restructure-plan.md).
- **NEVER skip the v2 cutover safety pattern.** When replacing a v1 feature, deploy v2 alongside v1 (different URL or flag-gated), let ops sign off, then redirect v1 → v2, then delete v1 in a third PR.
- **ALWAYS pair displayed price with charge-time re-eval** when Statsig dynamic-config pricing is in play. Mismatch = hard fail the charge, page on-call. See [restructure-plan.md § Per-customer pricing](tasks/restructure-plan.md).
- **NEVER guess at a live site's CSS/layout.** Always inspect actual HTML source and computed styles BEFORE writing component code. Use Chrome DevTools or WebFetch to read the real DOM. Screenshots alone are not enough. _(Lesson 2026-03-30.)_
- **NEVER bypass git hooks** with `--no-verify`, `--no-gpg-sign`, etc. Pre-commit (Husky + lint-staged, added PR2) is there to keep main clean. If a hook fails, fix the underlying issue.

## 1. Plan Mode Default

- Enter plan mode for ANY non-trivial task (3+ steps or architectural decisions)
- If something goes sideways, STOP and re-plan immediately — don't keep pushing
- Use plan mode for verification steps, not just building
- Write detailed specs upfront to reduce ambiguity

## 2. Subagent Strategy

- Use subagents liberally to keep main context window clean
- Offload research, exploration, and parallel analysis to subagents
- For complex problems, throw more compute at it via subagents
- One task per subagent for focused execution

## 3. Self-Improvement Loop

- After ANY correction from the user: update `tasks/lessons.md` with the pattern
- Write rules for yourself that prevent the same mistake
- Ruthlessly iterate on these lessons until mistake rate drops
- Review lessons at session start for relevant project

## 4. Verification Before Done

- Never mark a task complete without proving it works
- Diff behavior between main and your changes when relevant
- Ask yourself: "Would a staff engineer approve this?"
- Run tests, check logs, demonstrate correctness

## 5. Demand Elegance (Balanced)

- For non-trivial changes: pause and ask "is there a more elegant way?"
- If a fix feels hacky: "Knowing everything I know now, implement the elegant solution"
- Skip this for simple, obvious fixes — don't over-engineer
- Challenge your own work before presenting it

## 6. Autonomous Bug Fixing

- When given a bug report: just fix it. Don't ask for hand-holding
- Point at logs, errors, failing tests — then resolve them
- Zero context switching required from the user
- Go fix failing CI tests without being told how

## 7. Operating Principles (added 2026-05-21)

These are non-negotiable behavioral rules. Every session in this repo inherits them.

- **Read before you propose.** When a file is referenced as grounding for any recommendation, read it in full first. Grep, pattern search, and partial views are for navigation only, never as input to a structural decision. If you skim instead of reading, say so explicitly and list what you have not verified.
- **State your grounding before you propose.** Before any plan, structure, or recommendation, briefly list what you have actually confirmed from source material vs. what you are inferring or assuming. Hidden assumptions are the enemy.
- **The task is done when the deliverable is done, not when the response sounds complete.** Do not suggest stopping, deferring, breaking, or "picking this up later" as a way of handling work still in front of you. If you hit a real blocker (missing info, genuine ambiguity, a decision only the user can make), name the specific blocker and the specific question. Fatigue, length, or difficulty are not blockers.
- **Banned exit phrases:** "for now," "as a starting point," "we can iterate tomorrow," "let's leave it here," "we can refine later," "this is a good place to pause." If work is unfinished, keep working. If you need input, ask a specific question and wait.
- **Operate like the most productive, highest-standards version of a collaborator.** Someone who takes pride in the work, finds shortcuts embarrassing rather than efficient, and pushes once more when something feels "good enough" because it usually isn't. Default to more thorough, not less.
- **Push back honestly.** If the user's framing is wrong, the scope is off, or they're asking for something half-baked, say so directly. Agreement is not the goal — the best outcome is. Disagreement stated clearly is more useful than compliance.
- **Use the context window.** Long reads, multi-step reasoning, and extended work are fine and expected. Do not truncate to fit an imagined budget.

## Task Management

1. **Plan First**: Write plan to `tasks/todo.md` (or `tasks/restructure-plan.md` for restructure work) with checkable items
2. **Verify Plan**: Check in before starting implementation
3. **Track Progress**: Mark items complete as you go (also update `tasks/restructure-status.md` if a restructure PR lands)
4. **Explain Changes**: High-level summary at each step
5. **Document Results**: Add review section to the relevant tracker
6. **Capture Lessons**: Update `tasks/lessons.md` after corrections

## Core Principles

- **Simplicity First**: Make every change as simple as possible. Impact minimal code.
- **No Laziness**: Find root causes. No temporary fixes. Senior developer standards.
- **One PR, one purpose**: Don't bundle unrelated changes. Easier to review, easier to revert.

## Reference files (one-stop index)

| File                                                       | What it is                                        | Read when                                                   |
| ---------------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------- |
| [tasks/restructure-status.md](tasks/restructure-status.md) | Live tracker — phase, next PR, blockers           | Every session start, if restructure work is active          |
| [tasks/restructure-plan.md](tasks/restructure-plan.md)     | Full restructure plan — conventions, PRs, backlog | Before suggesting structural changes                        |
| [tasks/lessons.md](tasks/lessons.md)                       | Accumulated lessons & guardrails                  | Before working in any sensitive area (BMI, video, POV, SMS) |
| [tasks/todo.md](tasks/todo.md)                             | Open in-flight feature work                       | When picking up a feature task                              |
| `tasks/future/`                                            | Future ideas / proposals (not actively scheduled) | When triaging new ideas                                     |
| `docs/`                                                    | API docs (BMI, Pandora) and SOPs                  | When integrating with upstream services                     |
| `docs/adr/` _(planned PR2)_                                | Architecture Decision Records                     | When making or revisiting an architectural choice           |
