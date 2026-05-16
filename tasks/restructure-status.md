# Restructure Status

**Last updated:** 2026-05-15 by Alex
**Current phase:** Phase 1 — v2 Runway (PR6 landed; PR4/5/7/8 deferred — can ship alongside or after booking)
**Next up:** PR-B1 (Booking feature scaffold — `apps/web/src/features/booking/{state,service,data}` skeleton, `BookingFlow` shell, `/book/v2` chooser, vendor stub-mode infrastructure)

> Read [tasks/restructure-plan.md](restructure-plan.md) for the full plan, conventions, and migration backlog.

## Phase 0 — Foundation

- [x] **PR1** — Bootstrap pnpm + Turborepo workspace at root (no moves)
  - Verified locally: `pnpm install` 1m28s, `pnpm turbo run build` 2m08s (a11y clean, all 3 packages green), `next dev` Ready in 2.4s.
  - Vercel project root unchanged (still `fasttrax-web/` at PR1 time; flipped to `apps/web/` as part of PR3 cutover).
  - Files added: `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, `.nvmrc`, `.npmrc`, expanded `.gitignore`.
- [x] **PR2** — Tooling baselines (Prettier, Husky+lint-staged, Vitest, CI, `.env.example`, ADR scaffold) — landed 2026-05-14.
  - Prettier (`.prettierrc`, `.prettierignore`) + one-time format pass across 467 files (`npm run format:check` green).
  - Husky 9 pre-commit hook runs lint-staged (prettier + eslint --fix on staged files).
  - Vitest 2.1.9 with workspace config (`vitest.workspace.ts`) + per-app `vitest.config.ts`; `passWithNoTests` so test task is green until suites exist.
  - GitHub Actions CI at `.github/workflows/ci.yml`: format:check, typecheck, lint, test, build via `npx turbo run`. Lint is `continue-on-error` because of ~105 pre-existing errors (mostly new React 19 `react-hooks/*` rules) — tighten in a dedicated lint-cleanup PR.
  - Root `.env.example` enumerates every env var observed in the codebase (Square, BMI, Conq/QAMF, Pandora, KBF, VT3, Twilio/Vox, SendGrid, Teams bot, admin auth, Vercel KV, blob, SEO verification, feature flags).
  - `docs/adr/` with README, 0000-template, 0001-npm-turbo (captures the 2026-05-06 pnpm → npm switch decision).
  - Workspaces added `typecheck` script (tsc --noEmit); turbo gained `typecheck` and `test` tasks.
- [x] **PR2.5** — Local dev runbook — landed 2026-05-15.
  - Tightened the existing dev `?brand=` override in [middleware.ts](../apps/web/middleware.ts) to:
    - Gate the entire branch on `NODE_ENV !== 'production'` (was always-on — minor footgun on prod where the param could rewrite paths).
    - Compute `isHeadPinz` from the `dev-brand` cookie when in dev, so brand state PERSISTS across navigation (previously the cookie was set but never read — only the per-request `?brand=` param worked).
    - Set-cookie + redirect to the SAME path (no path mangling) so developers see clean URLs like `/fort-myers`, not `/hp/fort-myers`.
  - Root [README.md](../README.md) rewritten: workspace layout, prerequisites, first-time setup, brand switching (`?brand=headpinz` / `?brand=fasttrax`), common commands, troubleshooting (stale Next typegen, husky core.hooksPath corruption, missing cookie).
  - Smoke tested locally: `npm run dev -w fasttrax-web` ready in 688ms; `/` serves FastTrax; `?brand=headpinz` 307s + sets `dev-brand=headpinz; SameSite=lax; Max-Age=604800`; subsequent `/` with cookie serves HeadPinz (title verified). `?brand=fasttrax` clears the cookie.
  - Known Next 16 noise: warns `"middleware" file convention is deprecated. Please use "proxy" instead.` Migrating `middleware.ts` → `proxy.ts` is its own PR — out of PR2.5 scope.
- [x] **PR3** — `git mv fasttrax-web/ → apps/web/` + `apps/web/src/` v2 scaffold + `~/*` alias — landed 2026-05-15 (code change). **Vercel root-dir flip is the cutover step — pending operator window.**
  - `git mv fasttrax-web apps/web` preserved history (457 files, 100% rename detection, zero content changes).
  - Root [package.json](../package.json) workspaces array: removed `"fasttrax-web"`, kept `"apps/*"` glob (auto-picks up `apps/web`). npm workspace NAME is still `fasttrax-web` (defined in `apps/web/package.json`) — `npm run dev -w fasttrax-web` still works.
  - [apps/web/tsconfig.json](../apps/web/tsconfig.json) gained `"~/*": ["./src/*"]` alias so new code at `apps/web/src/features/...` imports as `~/features/...` (visually distinct from v1 `@/lib/*`).
  - [apps/web/src/](../apps/web/src/) scaffolded with `.gitkeep` placeholders for `components/{ui,features}/`, `features/`, `lib/{api,helpers,constants}/`, `hooks/`, `types/`, `context/`, `styles/`. Booking work lands here.
  - [vitest.workspace.ts](../vitest.workspace.ts) and [.prettierignore](../.prettierignore) repointed from `fasttrax-web` → `apps/web`.
  - Docs swept for path refs: README, CLAUDE.md (root), restructure-status, restructure-plan, lessons, seo/README, vt3-bridge/{README,src}, apps/web/{scripts,docs}. ADR 0001 and the various `tasks/future/` + `docs/future/` notes kept their historical refs.
  - Verified post-move: `npm install`, `npm run format:check`, `npx turbo run typecheck` (3/3), `npx turbo run build` (3/3, a11y clean, 1m04s).
  - **Cutover procedure (for the Vercel flip):**
    1. PR3 reviewed + approved (not yet merged).
    2. (Optional but recommended) CLI preview deploy from the moved branch: `cd apps/web && vercel` — builds against `apps/web/` via the existing project, bypasses the dashboard Root Directory setting. Get a real preview URL for validation before changing any settings.
    3. Vercel dashboard → Project Settings → General → Root Directory → `fasttrax-web` → `apps/web`. SAVE. (No deploy is triggered; production keeps serving the last successful build from `fasttrax-web/`.)
    4. (Optional sanity) Dashboard → redeploy current main commit. SHOULD fail (path mismatch). Production unaffected.
    5. Merge PR3 to main. Vercel auto-deploys from `apps/web/`. Success → goes live atomically.
    6. **Rollback if needed:** Dashboard → Deployments → previous good production deploy → "Promote to Production." 1 click, instant. Then revert PR3 + flip Root Directory back.

## Phase 1 — v2 Runway

- [ ] **PR4** — `@ft/env` + `@ft/logger`
- [ ] **PR5** — React Query install + `<QueryProvider>` + `@ft/shared` query-key factory
- [x] **PR6** — `@ft/db` with BMI-safe helpers — landed 2026-05-15.
  - New workspace package at `packages/db/` (scope: `@ft`). Exports:
    - `sql()` / `isDbConfigured()` — ported from `apps/web/lib/db.ts` unchanged.
    - `stringifyWithRawIds(payload, { rawIds })` — replaces `JSON.stringify` for HTTP bodies that carry 17-digit BMI IDs. Validates each raw id is a digit-only string (defense against JSON injection); produces byte-identical output to the hand-rolled pattern in `bookRaceHeat()`. Centralizes the lesson from `tasks/lessons.md` § "BMI ID Precision."
    - `withIdempotency(redis, key, fn, opts?)` — Redis-locked wrapper for endpoints that consume shared inventory. Structurally-typed Redis interface so the package doesn't pull in ioredis. Cache writes only happen on success; throws bypass the cache (matches the pov-codes pattern).
  - `apps/web/lib/db.ts` is now a one-line re-export shim from `@ft/db`. Every existing `@/lib/db` import (16 call sites: `bowling-db`, `bmi-deposit-retry`, several admin routes) works unchanged.
  - Path alias `@ft/db` wired in both `tsconfig.base.json` (for packages/*) and `apps/web/tsconfig.json` (for the Next app). `apps/web/package.json` gained `"@ft/db": "*"` workspace dep.
  - Vitest: `packages/db/src/{raw-ids,idempotency}.test.ts` — **13 tests passing** covering snapshot parity with `bookRaceHeat()` (5 raw-id tests), injection rejection, multi-id appending, and the idempotency cache/retry/TTL/annotation behavior. Reference impl of `bookRaceHeat()`'s string-concat is copied into the test so future regressions are caught by direct diff.
  - Verified: `npm run format:check` ✓, `npx turbo run typecheck` 4/4 ✓, `npx turbo run test --filter=@ft/db` 13/13 ✓, `npx turbo run build` 3/3 ✓ (1m14s, a11y clean).
  - Scope decision: `@ft` (per blocker resolution 2026-05-15 — see below).
- [ ] **PR7** — `@ft/auth-admin` (with tests)
- [ ] **PR8** — `@ft/feature-flags` (Statsig wrapper) + migrate existing two env-flags to gates

> Phase 1 exit gate: a new file at `apps/web/src/features/<example>/hooks.ts` can use React Query + `@ft/db` + `@ft/logger` + `@ft/env` + `@ft/feature-flags`, and an admin route can guard via `@ft/auth-admin`, all without modifying any v1 file.

## Phase 2 — First v2 features

- [ ] **PR9** — v2 SMS Log admin (worked example for `src/features/<feature>/` + React Query + flag-gated cutover)
- [ ] (next v2 features picked per business need — see plan § Phase 2)
- [ ] **PR11+** — Per-customer pricing via Statsig Dynamic Configs (with `pricing_audit` table + charge-time re-eval guard)

## Phase 3 — v1 migration backlog

No fixed PR order. See [restructure-plan.md § Phase 3 v1 migration backlog (prioritized)](restructure-plan.md) for the menu.
Each migration that ships gets a one-line entry below.

- (none yet)

## Phase 4 — Optional hardening (deferred)

- [ ] Sentry error tracking + Sentry Session Replay (`@ft/observability`)
- [ ] Microsoft Clarity for PM/UX exploration
- [ ] Playwright happy-path harness (booking confirmation, POV voucher claim) gated by `TEST_E2E=1`
- [ ] Coverage gates in CI (≥60% on `packages/*` and `apps/web/src/features/*`)
- [ ] Tighten `@ft/env` schema — flip `.optional()` to required for vars that must be present in prod
- [ ] Move bridges to `apps/` (if not already done in Phase 3)

## Open blockers / decisions in flight

- **Statsig identity model** — confirm cookie-based (recommended) vs email-gate vs promo-code-style before PR8.
- **Per-customer pricing scope** — confirm which products get targeting first (race packages? bowling? all?) before PR11.
- **Privacy policy update** — must precede any session-replay PR (Phase 4 blocker).
- ~~**`@ft/*` package scope name**~~ — **RESOLVED 2026-05-15:** `@ft` (chosen for brevity, matches the placeholder in the plan). First package `@ft/db` shipped in PR6.

## Lessons learned during restructure

- **PR2 (2026-05-14):** Next.js 16 generates `.next/dev/types/validator.ts` referencing route layouts that may no longer exist on disk. `tsc --noEmit` fails on stale typegen until `.next/` is cleaned (or a fresh `next build` regenerates it). CI is unaffected because it starts cold; local typecheck after refactoring routes needs `rm -rf apps/web/.next` first.
- **PR2 (2026-05-14):** Surfacing lint via CI exposed ~105 pre-existing errors (mostly new React 19 `react-hooks/set-state-in-effect`, `react-hooks/refs`, `react-hooks/exhaustive-deps`) and ~148 warnings. Both CI lint and the pre-commit lint-staged hook are prettier-only / `continue-on-error` until a dedicated cleanup PR lands. Don't ship new code that triggers these rules.
- **PR2 (2026-05-15):** Husky's `prepare` script on Windows occasionally corrupts `core.hooksPath` to `--version/_` (looks like a `git config --version` output got substituted into the set command). Symptom: every git op prints `env: unknown option -- version/_/<hook-name>` and the hook silently no-ops. Fix: `git config core.hooksPath .husky/_`.
- **PR6 (2026-05-15):** Path aliases for workspace packages need to be declared in BOTH `tsconfig.base.json` (for sibling packages under `packages/*`) AND `apps/web/tsconfig.json` (the Next app doesn't extend the base config — different `target` and `jsx`). Forgetting either side produces "Cannot find module '@ft/db'" at type-check time only. Add to both whenever a new `@ft/*` package lands.

## Update protocol

- **When a restructure PR merges:** check the box above, add the PR number + merge date, bump `Next up`.
- **When a Phase 3 migration ships:** add a one-line entry under "Phase 3" with PR# + date.
- **When a decision changes:** edit `tasks/restructure-plan.md` and add an ADR entry under `docs/adr/`.
- **When a blocker resolves:** strike it from "Open blockers" with date + decision.
