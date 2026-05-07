# Restructure Status

**Last updated:** 2026-05-06 by Alex
**Current phase:** Phase 0 — Foundation
**Next up:** PR2 (Prettier + Husky + Vitest + CI + .env.example + ADR scaffold)

> Read [tasks/restructure-plan.md](restructure-plan.md) for the full plan, conventions, and migration backlog.

## Phase 0 — Foundation

- [x] **PR1** — Bootstrap pnpm + Turborepo workspace at root (no moves)
  - Verified locally: `pnpm install` 1m28s, `pnpm turbo run build` 2m08s (a11y clean, all 3 packages green), `next dev` Ready in 2.4s.
  - Vercel project root unchanged (still `fasttrax-web/`).
  - Files added: `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, `.nvmrc`, `.npmrc`, expanded `.gitignore`.
- [ ] **PR2** — Tooling baselines (Prettier, Husky+lint-staged, Vitest, CI, `.env.example`, ADR scaffold). CLAUDE.md + restructure docs were landed as a separate docs commit immediately after PR1.
- [ ] **PR3** — Move `fasttrax-web/` → `apps/web/` (coordinated Vercel root-dir change)

## Phase 1 — v2 Runway

- [ ] **PR4** — `@ft/env` + `@ft/logger`
- [ ] **PR5** — React Query install + `<QueryProvider>` + `@ft/shared` query-key factory
- [ ] **PR6** — `@ft/db` with BMI-safe helper (`queryWithRawIds`, `withIdempotency`)
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
- **`@ft/*` package scope name** — placeholder; pick final scope (`@ft`, `@fasttrax`, `@ftw`, etc.) before PR4 since it's baked into every package import.

## Lessons learned during restructure

- (append entries here as they come up; significant ones also belong in `tasks/lessons.md`)

## Update protocol

- **When a restructure PR merges:** check the box above, add the PR number + merge date, bump `Next up`.
- **When a Phase 3 migration ships:** add a one-line entry under "Phase 3" with PR# + date.
- **When a decision changes:** edit `tasks/restructure-plan.md` and add an ADR entry under `docs/adr/`.
- **When a blocker resolves:** strike it from "Open blockers" with date + decision.
