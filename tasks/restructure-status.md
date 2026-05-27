# Restructure Status

**Last updated:** 2026-05-27 by Claude (PR-B3.5 session)
**Current phase:** Phase 2 — First v2 feature (booking) — PR-B2 (race) + PR-B3 (attractions) landed, PR-B3.5 (shared deposit infrastructure) in progress
**Next up:** PR-B3.5 verification + merge, then PR-B4 (Race-pack v2)

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

### Booking rewrite (per `~/.claude/plans/we-are-going-to-polymorphic-hejlsberg.md`)

- [x] **PR-B1** — Booking feature scaffold — landed 2026-05-15.
  - Installed `@tanstack/react-query` + `@tanstack/react-query-devtools` and `zod` in `apps/web` (the React-Query install was deferred from PR5; landed here as the first consumer).
  - [apps/web/src/context/QueryProvider.tsx](../apps/web/src/context/QueryProvider.tsx) — client component, sensible defaults (staleTime 30s, retry 1, no refetch-on-focus), devtools only when `NODE_ENV !== "production"`.
  - QueryProvider scoped to `/book/[activity]/v2` and `/book/kbf/v2` via layout files — v1 booking + every other v1 page pay zero React Query cost.
  - [apps/web/src/features/booking/](../apps/web/src/features/booking/) skeleton: `types.ts` (Activity/Brand/CenterCode/ContactInfo), `state/{types,machine,steps}.ts` (Draft union, reducer, per-activity step registry with placeholder steps for race / race-pack / attraction / bowling / kbf), `service/index.ts` (BookingService interface + `getService()` dispatcher that throws "not implemented" for each activity), `data/index.ts` + `data/mock-mode.ts` + `data/square.ts` + `data/__fixtures__/square.ts` (reference adapter showing the `LOCAL_<VENDOR>_MOCK=1` toggle pattern; in-memory mock so wizard can roundtrip without Square credentials), `queries.ts` (React Query key factory keyed under `["booking", ...]`), `schemas.ts` (zod placeholders), `hooks/index.ts` (empty, fills per-activity), `index.ts` (public surface).
  - [apps/web/src/components/features/booking/BookingFlow.tsx](../apps/web/src/components/features/booking/BookingFlow.tsx) — orchestrator shell. Drives the reducer, renders the current step's component, handles breadcrumb + Next/Back. Step components are placeholders that render nothing yet — the host is ready for per-activity PRs to fill them in.
  - Routes wired (all build cleanly):
    - `/book/v2` — brand-aware chooser server component, reads `x-brand` header, preselects FastTrax's race tile or HeadPinz's bowling tile.
    - `/book/[activity]/v2` — dynamic route, slug → Activity mapping (race / race-pack / bowling / attractions). Unknown slugs → 404.
    - `/book/kbf/v2` — separate route for KBF (different SEO + COPPA model).
  - **Vendor stub-mode pattern established** — `isMockMode("vendor")` returns false in prod (hard guard) and only true when `LOCAL_<VENDOR>_MOCK=1` in dev. `square.ts` demonstrates the real/mock dispatch; bmi/conq/pandora/kbf adapters follow the same shape when they land.
  - Verified: `npm run format:check` ✓, `npx turbo run typecheck` 4/4 ✓, `npx turbo run test` 13/13 ✓ (no booking-feature tests yet — those land per-activity), `npx turbo run build` 3/3 ✓ (a11y clean, 1m27s). Three new routes show in the build manifest: `/book/v2`, `/book/[activity]/v2`, `/book/kbf/v2`.
- [x] **PR-B2** — Race v2 (real BMI adapter, heat picker, party management, checkout) — landed 2026-05-27.
- [x] **PR-B3** — Attraction v2 (gel-blaster / laser-tag / duck-pin / shuffly) — landed 2026-05-27.
- [ ] **PR-B3.5** — Shared deposit + reservations infrastructure (in progress, 2026-05-27).
  - Deliverable 1: Neon reservations schema widened (`bowling-db.ts`) — `ReservationProductKind` includes "race" | "attraction", `booking_metadata` JSONB column, `productKinds` filter on `listBowlingReservations()`.
  - Deliverable 2: Shared deposit service (`features/booking/service/deposit.ts`) — extracted from bowling-orders into `createDepositAndCharge()` + `rollbackDeposit()`.
  - Deliverable 2b: Square catalog map (`features/booking/data/square-catalog-map.ts`) — 57+ race + 12+ attraction BMI product IDs → Square catalog variation IDs.
  - Deliverable 2 addon: GAN regex updated for RACE/ATTR prefixes in `square-gift-card.ts`.
  - Deliverable 3: v2 Reserve API route (`/api/booking/v2/reserve`) — builds Square day-of order + deposit + BMI payment/confirm + Neon reservation.
  - Deliverable 4: v2 checkout wiring — `reserveBooking()` in checkout.ts, `onTokenize` prop on PaymentForm, CheckoutStep uses v2 reserve flow, confirmation page skips payment/confirm for `v2=1`.
  - Deliverable 5: Admin dashboard — product kind badges (Race green, Attr orange), kind filter tabs, BMI bill ID fields.
  - Build verified: `npx turbo run build` passes clean.
- [ ] **PR-B4** — Race-pack v2 (multi-component heats, Pandora deposit credits)
- [ ] **PR-B5** — Bowling v2 (Conq adapter, gift-card-as-deposit)
- [ ] **PR-B6** — KBF v2 (identity gate, conditional Square anchor for paid add-ons)

### Other v2 features (independent of booking)

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
