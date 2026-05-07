# FastTrax Tools — Monorepo Restructure & v2 Conventions

## Context

`Tools-Website-FT` today is three sibling directories at the repo root (`fasttrax-web/`, `kart-timing-bridge/`, `vt3-bridge/`) with no workspace orchestration, no shared packages, no env validation, no tests, no Prettier, no React Query, and a 43-file flat `lib/` god folder inside the Next app. The app is healthy and serves real revenue (9 Vercel crons, 75+ API endpoints, 2 brands), but it has no organizational seams to grow into. New features get bolted onto `lib/`, conventions drift, and recent regressions ([tasks/lessons.md](lessons.md)) point at exactly the kind of mistakes a thoughtful structure prevents (BMI ID precision, idempotency on shared inventory, multi-source data cascade, stale `useCallback` closures, middleware allow-list desync).

This effort stands up the bones: a real pnpm + Turborepo workspace, a defined shape for new code (per [Best Practices for Organizing Your Next.js 15 — bajrayejoon/dev.to](https://dev.to/bajrayejoon/best-practices-for-organizing-your-nextjs-15-2025-53ji)), the dev-environment / code-style / testing / React Query / docs conventions from [gregsantos's CLAUDE.md gist](https://gist.github.com/gregsantos/2fc7d7551631b809efa18a0bc4debd2a), and the painful lessons from `tasks/lessons.md` codified into compile-time / lint-time guardrails.

**Scope guard:** Existing code stays where it is. Only PR3 relocates `fasttrax-web/` → `apps/web/`. Migration of legacy `lib/*` happens later, opportunistically, against the prioritized backlog (Section 8). New code follows the new pattern from day one.

## Confirmed decisions

| Decision | Choice |
|---|---|
| Workspace tooling | **pnpm + Turborepo** |
| v2 scope | **Reorganize-shape only.** New code follows the new pattern; existing code migrates opportunistically. |
| Brands | **One Next app**, brand-aware via host middleware (current pattern stays) |
| Cadence | **Incremental, one PR at a time** |
| UI library | **Do NOT install Shadcn/ui or any other component-library kit.** Custom components stay; Tailwind is the design system. |
| Reference structure | Link 1 (dev.to article) for file structure (`src/` layout, `components/ui` vs `components/features`, route groups). Link 2 (gist) for dev environment, code style, testing, React Query, and docs/onboarding ONLY (gist's structure sections are ignored). |
| Feature flags | **Statsig** (PR8 in Phase 1 v2 Runway). Per-customer pricing via Statsig Dynamic Configs in a follow-up PR with strict guardrails. |
| Session replay | **Sentry Session Replay** for engineering, **Microsoft Clarity** for PM/UX. Both in Phase 4. KBF and admin routes NEVER recorded. |

## What this codebase ALREADY matches from the references

Worth being explicit so we don't redo settled work:

- ✅ **TypeScript strict mode** ([fasttrax-web/tsconfig.json](../fasttrax-web/tsconfig.json) line 7)
- ✅ **Next.js App Router** (no Pages Router, all routes in `app/`)
- ✅ **Tailwind CSS v4** with custom palette
- ✅ **ESLint flat config** with `eslint-config-next` + a11y rules ([fasttrax-web/eslint.config.mjs](../fasttrax-web/eslint.config.mjs))
- ✅ **Path alias** `@/*` → `./` (per-app)
- ✅ **Route groups & dynamic segments** (`[token]`, `[slug]`, etc.)
- ✅ **Domain-grouped components** in [fasttrax-web/components/](../fasttrax-web/components/) (`booking/`, `home/`, `headpinz/`, `seo/`, `square/`)
- ✅ **CSP, HSTS, security headers** in [fasttrax-web/next.config.ts](../fasttrax-web/next.config.ts)
- ✅ **pnpm + Turborepo workspace at root** (PR1 ✅)

## What's missing and gets added in this effort

- ❌ `src/` directory (per Link 1) — added in PR3
- ❌ `components/ui/` separation from `components/features/` (per Link 1) — added in PR3
- ❌ Prettier — added in PR2
- ❌ Typed env validation (zod) — added in PR4
- ❌ Vitest / any test runner (zero tests today) — added in PR2
- ❌ React Query (`@tanstack/react-query` not in [fasttrax-web/package.json](../fasttrax-web/package.json)) — added in PR5
- ❌ Structured logger (currently `console.log`) — added in PR4
- ❌ Husky + lint-staged — added in PR2
- ❌ ADRs / `docs/adr/` directory — added in PR2
- ❌ CI workflow (`.github/workflows/` doesn't exist) — added in PR2
- ❌ `.env.example` — added in PR2
- ❌ Statsig feature flags — added in PR8
- ❌ Session replay — added in Phase 4

## Target monorepo layout (final shape)

```
Tools-Website-FT/
├── package.json                  # workspace root (devDeps: turbo, prettier, vitest, husky, lint-staged)
├── pnpm-workspace.yaml
├── turbo.json
├── tsconfig.base.json            # shared compiler options + path aliases
├── .nvmrc                        # Node 22
├── .npmrc                        # node-linker=isolated
├── .prettierrc, .prettierignore  # PR2
├── .husky/                       # PR2 — pre-commit: lint-staged
├── .github/workflows/ci.yml      # PR2 — typecheck, lint, test, build
├── docs/
│   ├── adr/                      # NEW — Architecture Decision Records
│   └── (existing API docs)
├── apps/
│   ├── web/                      # Next.js app (was fasttrax-web/, moved in PR3)
│   ├── kart-timing-bridge/       # moved in Phase 3
│   └── vt3-bridge/               # moved in Phase 3
├── packages/
│   ├── env/                      # zod env schema, typed `env` export
│   ├── logger/                   # pino structured logger
│   ├── auth-admin/               # token / IP / api-key admin gate (extracted)
│   ├── db/                       # Neon sql tag + BMI-safe raw-id helper
│   ├── feature-flags/            # Statsig wrapper (PR8)
│   ├── observability/            # Sentry + replay wrapper (Phase 4)
│   ├── services/                 # vendor clients: twilio, sendgrid, square, vt3, pandora, kbf, bmi
│   └── shared/                   # Brand type, SHARED_TOP_LEVEL_ROUTES, IdempotencyKey, query keys
├── seo/                          # unchanged
├── tasks/                        # unchanged
└── CLAUDE.md, README.md          # CLAUDE.md updated post-PR1
```

### Inside `apps/web/` — Link 1's `src/` shape, applied to NEW code only

Existing folders (`app/`, `components/`, `lib/`, `middleware.ts`, `next.config.ts`, `vercel.json`) **stay at `apps/web/` root** — they continue to work unchanged. New code lives under `apps/web/src/`:

```
apps/web/
├── app/                          # EXISTING — App Router routes (stays at root for Next.js)
├── components/                   # EXISTING — current components (migrate opportunistically)
├── lib/                          # EXISTING — current 43-file lib (migrate per Section 8)
├── middleware.ts, next.config.ts, vercel.json, tsconfig.json
└── src/                          # NEW — Link 1 layout for all new code
    ├── components/
    │   ├── ui/                   # shared, design-system-level (Button, Card, Input, etc.)
    │   └── features/             # feature-scoped components (e.g. features/sms-log/SmsLogTable.tsx)
    ├── features/                 # NEW — feature modules (data, service, hooks, types)
    │   └── <feature>/
    │       ├── data.ts           # DB queries (calls @ft/db)
    │       ├── service.ts        # business logic (calls @ft/services/*)
    │       ├── hooks.ts          # React Query hooks for this feature
    │       ├── queries.ts        # query-key factory + queryFn for this feature
    │       ├── schemas.ts        # zod schemas (request/response shapes)
    │       ├── types.ts          # feature-specific TS types
    │       └── index.ts          # public surface
    ├── lib/                      # utility code, NOT business logic
    │   ├── api/                  # generic API helpers (fetch wrapper, error normalization)
    │   ├── helpers/              # generic helpers (formatters, date utils)
    │   └── constants/            # constants
    ├── hooks/                    # cross-feature React hooks (useDebounce, useMediaQuery, etc.)
    ├── types/                    # cross-feature TS types
    ├── context/                  # React Context providers (QueryClientProvider lives here PR5)
    └── styles/                   # global styles (only if needed beyond Tailwind)
```

**Routing stays at `apps/web/app/`** — Next.js does not support split route directories. New routes added there continue, but the `route.ts` / `page.tsx` body delegates to `src/features/<feature>/`.

### Workspace package names — `@ft/*` (placeholder; pick a final scope before PR4)

| Package | Purpose | Initial population |
|---|---|---|
| `@ft/env` | zod-validated env schema, typed `env` export | seed in PR4 |
| `@ft/logger` | pino with redaction + `child({ requestId })` | seed in PR4 |
| `@ft/auth-admin` | `requireAdminToken()`, `requireApiKey()`, `requireBoth()` | extracted from [middleware.ts](../fasttrax-web/middleware.ts) lines 22–132 in PR7 |
| `@ft/db` | `sql` tag + `queryWithRawIds()` (BMI-safe JSON) | extracted from [lib/db.ts](../fasttrax-web/lib/db.ts) in PR6 |
| `@ft/feature-flags` | Statsig server + client wrapper, typed gate names + dynamic config helpers | seed in PR8 |
| `@ft/observability` | Sentry init + session-replay route allow-list | seed in Phase 4 |
| `@ft/services` | grouped vendor client modules | empty stubs in PR4; populated as features migrate |
| `@ft/shared` | `Brand`, `SHARED_TOP_LEVEL_ROUTES`, `IdempotencyKey`, query keys | seed in PR5 |

Path aliases in `tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "paths": {
      "@ft/env":           ["packages/env/src/index.ts"],
      "@ft/db":            ["packages/db/src/index.ts"],
      "@ft/db/*":          ["packages/db/src/*"],
      "@ft/logger":        ["packages/logger/src/index.ts"],
      "@ft/auth-admin":    ["packages/auth-admin/src/index.ts"],
      "@ft/feature-flags": ["packages/feature-flags/src/index.ts"],
      "@ft/observability": ["packages/observability/src/index.ts"],
      "@ft/services/*":    ["packages/services/src/*"],
      "@ft/shared":        ["packages/shared/src/index.ts"]
    }
  }
}
```

`apps/web/tsconfig.json` keeps `"@/*": ["./*"]` so existing imports continue to resolve. New imports inside `src/` use a second alias `"~/*": ["./src/*"]` to keep new code visually distinct.

## PR sequence — phased around v2-first delivery

The order below prioritizes **getting v2 features buildable as fast as possible**. Phases 0–1 are mandatory and blocking; Phase 2 is where v2 features ship; Phase 3 is opportunistic v1 migration that happens whenever a file gets touched (no fixed order); Phase 4 is optional hardening.

```
Phase 0  ─ Foundation                  (PRs 1–3)   blocking      ~1 week
Phase 1  ─ v2 Runway                   (PRs 4–8)   blocking      ~2 weeks
─────────── v2 features can now be built ───────────
Phase 2  ─ First v2 features           (PRs 9+)    ongoing       business-driven
Phase 3  ─ v1 migration backlog        (no fixed order)         opportunistic
Phase 4  ─ Optional hardening          (deferred)
```

---

### Phase 0 — Foundation (mandatory, blocking)

#### PR1 — Bootstrap workspace at root, no moves ✅

- Add: root `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, `.nvmrc`, `.npmrc`.
- `pnpm-workspace.yaml`: `["fasttrax-web", "kart-timing-bridge", "vt3-bridge", "packages/*", "apps/*"]`
- **Vercel impact:** none. Root stays `fasttrax-web/`.
- **Verified:** `pnpm install` (1m28s), `pnpm turbo run build` (2m08s, a11y clean), `next dev` (Ready in 2.4s).

#### PR2 — Tooling baselines: Prettier, Husky+lint-staged, Vitest, CI, CLAUDE.md, .env.example, in-repo plan & status tracker

- **Prettier:** `.prettierrc` (2-space, double quotes, trailing comma, print width 100), `.prettierignore`. Add `pnpm format` script.
- **Husky + lint-staged:** pre-commit runs `prettier --write` + `eslint --fix` on staged files. Never bypass with `--no-verify`.
- **Vitest:** root `vitest.workspace.ts`, per-package `vitest.config.ts`. Tests colocate as `*.test.ts(x)`.
- **CI:** `.github/workflows/ci.yml` runs `pnpm install --frozen-lockfile && pnpm -w turbo run typecheck lint test build` on PR.
- **`.env.example`:** generated from keys observed in [middleware.ts](../fasttrax-web/middleware.ts), [vercel.json](../fasttrax-web/vercel.json), `lib/*`.
- **CLAUDE.md & docs in repo:** the new CLAUDE.md, this restructure-plan.md, and restructure-status.md (already landed as a separate docs commit after PR1).
- **No code moves. No app behavior change.**
- **Risk:** low.

#### PR3 — Move `fasttrax-web/` → `apps/web/` (Vercel coordination)

- `git mv fasttrax-web apps/web`. Drop `"fasttrax-web"` from `pnpm-workspace.yaml`.
- **Vercel change required:** Project → Settings → Root Directory: `fasttrax-web` → `apps/web`. Same merge window.
- **Crons:** `vercel.json` paths are app-relative — unaffected.
- **Risk:** high (404 storm if root-dir not flipped). Mitigations: preview-deploy with root-dir flipped first; 1-line revert PR ready; merge during quiet window.
- **Add** `apps/web/src/` empty scaffold with `.gitkeep` files so the convention is visible.
- **Add** alias `"~/*": ["./src/*"]` in `apps/web/tsconfig.json`.
- **Delete** `fasttrax-web/package-lock.json` (stale npm lockfile, no longer needed once Vercel uses workspace pnpm-lock.yaml at the new root).

> **Phase 0 exit gate:** Workspace builds. Vercel deploys. New `apps/web/src/` scaffold is visible. Bridges, brands, crons, admin auth — all unchanged.

---

### Phase 1 — v2 Runway (mandatory, blocking)

Everything a v2 feature needs to exist on day one.

#### PR4 — `@ft/env` + `@ft/logger`

- **`@ft/env`:** `packages/env/src/{index.ts,schema.ts}`. Pure zod. Schema marks current vars `.optional()` initially; tighten later.
- **`@ft/logger`:** pino, JSON in prod / pretty in dev, `child({ requestId })`.
- Wire [lib/db.ts](../fasttrax-web/lib/db.ts) and `lib/redis.ts` to read `env` from `@ft/env`.
- **Risk:** medium — missing required env crashes prod boot; mitigated by `.optional()` initially.

#### PR5 — React Query install + `<QueryProvider>` + `@ft/shared` query-key factory

- Install `@tanstack/react-query` and `@tanstack/react-query-devtools` in `apps/web`.
- Create `apps/web/src/context/QueryProvider.tsx` (client component) wrapping `QueryClientProvider` with defaults: `staleTime: 30_000`, `refetchOnWindowFocus: false`, `retry: 1`. Devtools mount only when `process.env.NODE_ENV !== "production"`.
- Wire `<QueryProvider>` into [apps/web/app/layout.tsx](../fasttrax-web/app/layout.tsx) inside the `<body>`.
- Create `packages/shared/src/queryKeys.ts` with the central query-key factory.
- Also seed `packages/shared/src/index.ts` with `Brand`, `SHARED_TOP_LEVEL_ROUTES`, `IdempotencyKey` branded type.
- **Risk:** low — purely additive.

#### PR6 — `@ft/db` with BMI-safe helper

- Move [lib/db.ts](../fasttrax-web/lib/db.ts) to `packages/db/src/index.ts`. Re-export from old path for one release as a shim.
- Add `queryWithRawIds(text, params, { rawIdFields: string[] })` — string-concat JSON for listed fields, never `JSON.stringify(bigint)`. Pattern from `bookRaceHeat()` in `lib/data.ts`.
- Add `withIdempotency(key, fn)` Redis-locked wrapper.
- Snapshot test against captured `bookRaceHeat()` JSON output.
- **Risk:** medium — corrupting a 17-digit BMI ID = lost revenue. Tests are the safety net.

#### PR7 — `@ft/auth-admin` (with tests)

- Move admin token + IP + api-key logic from [middleware.ts](../fasttrax-web/middleware.ts) lines 22–132 and `lib/admin-auth.ts` into `packages/auth-admin/src/`.
- Provide route-handler helpers: `requireAdminToken(req)`, `requireApiKey(req, surface)`, `requireBoth(req, surface)`.
- Test matrix: token ok/wrong/missing × api-key surfaces × admin paths × public spec exception × legacy-token 308 redirect.
- **Risk:** medium — regression 404s the entire admin surface. Behavior must be bit-for-bit identical.

#### PR8 — Statsig feature-flags foundation (`@ft/feature-flags`)

- Install `statsig-node` (server) + `@statsig/react-bindings` (client).
- `@ft/feature-flags` package wrapping both with typed gate names + dynamic config helpers.
- `STATSIG_SERVER_SECRET_KEY` + `NEXT_PUBLIC_STATSIG_CLIENT_KEY` added to `@ft/env`.
- `<StatsigProvider>` in `apps/web/src/context/` next to `<QueryProvider>`.
- CSP update in [next.config.ts](../fasttrax-web/next.config.ts) — add `https://api.statsig.com` and `https://events.statsigapi.net` to `connect-src`.
- Identity model: anonymous cookie UUID + brand custom property; BMI personId added later when needed.
- ESLint rule banning `process.env.NEXT_PUBLIC_*_ENABLED` reads outside `@ft/feature-flags`.
- Migrate existing `NEXT_PUBLIC_ROOKIE_PACK_ENABLED` and `NEXT_PUBLIC_ULTIMATE_QUALIFIER_ENABLED` from `lib/packages.ts` to Statsig gates as the worked example.
- **Risk:** low — existing flags keep working until their migration commit lands.
- **Why now:** v2 cutovers in Phase 2 use flag-gated rollouts (`videos_admin_v2`, `sms_log_v2`, etc.) instead of binary URL cutover. Much safer.

> **Phase 1 exit gate:** A new file at `apps/web/src/features/<example>/hooks.ts` can `import { useQuery } from "@tanstack/react-query"`, call a queryFn that uses `@ft/db`, log via `@ft/logger`, read config via `@ft/env`, gate features via `@ft/feature-flags`, and an admin route at `app/api/admin/<example>/route.ts` can guard via `@ft/auth-admin` — all without modifying any v1 file. **Team is unblocked to ship v2 features.**

---

### Phase 2 — First v2 features (ongoing, business-driven)

Once Phase 1 lands, every new feature is a v2 feature. PR9 is the **first v2 worked example** — it proves the conventions and becomes the reference all subsequent v2 features copy.

#### PR9 — First v2 worked example: SMS Log admin (v2)

- Create `apps/web/src/features/sms-log/`: `data.ts`, `service.ts`, `schemas.ts`, `queries.ts`, `hooks.ts`, `types.ts`, `index.ts`.
- Create `apps/web/src/components/features/sms-log/SmsLogTable.tsx` (client component using `useSmsLogQuery`).
- New v2 route `app/admin/[token]/sms-log/v2/page.tsx`. v1 page at `app/admin/[token]/sms-log/page.tsx` keeps working.
- Gate v2 access via `@ft/feature-flags` gate `sms_log_v2_enabled` (default false; flip on per ops user, then 100%, then redirect v1 → v2).
- Unit tests (service.ts) + integration tests (hooks.ts with MSW).
- **Risk:** low — entirely additive; v1 untouched.

#### PR10+ — Subsequent v2 features (order decided per business need)

Suggested next candidates ranked by recent-touch + RQ value:

- **Videos admin v2** — admin table + block/unblock mutations + polling refresh.
- **Camera-assign v2** — live status polling + drag-and-drop assignments + optimistic updates.
- **Voucher / POV admin v2** — list + claim + retry mutations; addresses idempotency lessons inline.
- **Sales report v2** — Swagger-backed table + filters.
- **E-tickets admin v2** — resend mutations.

#### PR11+ (parallel track) — Per-customer pricing via Statsig Dynamic Configs

Separate PR after PR8 has baked. ~3-5 days plus design review.

- Define `pricing_*` Dynamic Config namespace (`pricing_race_packages`, `pricing_bowling`, etc.).
- **Pricing-eval audit table** in Neon — every render of a custom-flagged price writes `(personId, packageId, displayedPrice, defaultPrice, configRuleId, evaluatedAt)`. Non-negotiable.
- **Charge-time re-eval guard** — the BMI/Square charge handler re-evaluates the same Dynamic Config with the same identity and confirms `displayedPrice === chargedPrice`. Mismatch → hard fail the charge, page on-call.
- Ops admin tool: upload CSV of BMI personIds → Statsig segment via their REST API.
- Add to `tasks/lessons.md` BEFORE shipping:

  > **Pricing rule:** A customer's displayed price MUST equal their charged price. Every UI render that shows a custom-flagged price must be paired with a server-side re-eval at charge time using the SAME identity. The eval result is logged to `pricing_audit` before the charge fires. Any mismatch fails the charge. No exceptions.

> **Phase 2 exit gate (per feature):** v2 surface in production behind its own URL or flag, ops sign-off, v1 redirects or scheduled for deletion in follow-up PR.

---

### Phase 3 — v1 migration backlog (opportunistic, no fixed order)

The rule: **whenever you touch a v1 file, consider migrating it.** Three triggers justify pulling from Phase 3:

1. **A v2 feature needs to share code with v1.** Example: v2 Videos admin needs `lib/vt3.ts` — extract to `@ft/services/vt3` so both consume it.
2. **A v1 file is being modified anyway** for a bug fix or new behavior. Migrate while you're in there.
3. **A v1 file has been touched 3+ times in 6 months** (high-churn signal). Promote it to a scheduled migration.

Bridges (`kart-timing-bridge/`, `vt3-bridge/`) move whenever convenient — isolated, mechanical (`git mv` + Railway root-dir update).

> **Phase 3 has no exit gate.** Runs continuously alongside v2 work. Done when there's nothing left in `apps/web/lib/` worth migrating.

---

### Phase 4 — Optional hardening (deferred)

- **Sentry + Session Replay (`@ft/observability`):**
  - `@sentry/nextjs` for error tracking.
  - Sentry Session Replay for engineering ("show me the replay leading to this error").
  - Route allow-list module — KBF (`/hp/kids-bowl-free/*`, `/api/kbf/*`) and admin (`/admin/*`, `/api/admin/*`) NEVER recorded. Build-time check fails CI on violation.
  - Sampling: `replaysSessionSampleRate: 0.1`, `replaysOnErrorSampleRate: 1.0`.
  - `SESSION_REPLAY_ENABLED` env var kill-switch.
  - All form inputs masked by default; `<MaskedInput>` wrapper for explicit cases.
- **Microsoft Clarity** for PM/UX exploration — free, anonymous, separate from Sentry. Same route allow-list logic.
- **Playwright e2e:** booking → confirmation, POV voucher claim. `apps/web/e2e/`, gated by `TEST_E2E=1`.
- **Coverage gates in CI:** require ≥60% on `packages/*` and `apps/web/src/features/*` once we have ≥30 tests.
- **Tighten env schema:** flip `.optional()` to required for vars that are actually required in prod.
- **Move bridges to apps/** as a planned PR (if not already done opportunistically in Phase 3).

## Conventions for new code (the "v2 structure")

### File structure (Link 1)

- New code goes under **`apps/web/src/`**.
- **Routes stay at `apps/web/app/`** (Next.js App Router constraint). Route handlers and pages are thin shells that import from `~/features/<feature>`.
- **`src/components/ui/`** — reusable, design-system-level components. Hand-rolled (NO Shadcn). Examples: `Button`, `Card`, `Input`, `Modal`, `Spinner`. Each in its own folder with colocated test.
- **`src/components/features/<feature>/`** — feature-scoped components.
- **`src/features/<feature>/`** — feature module (data, service, hooks, queries, schemas, types, index).
- **`src/lib/`** — generic utilities only. Subdirs: `api/`, `helpers/`, `constants/`. **No business logic** — that goes in `src/features/<feature>/service.ts`.
- **`src/hooks/`** — cross-feature React hooks (`useDebounce`, `useMediaQuery`).
- **Anti-patterns to refuse:** the "Utils Black Hole"; excessive nesting (>4 levels); business logic in `src/lib/`; feature-specific components in `src/components/ui/`.

### Route handlers & pages (thin shells)

- `app/api/*/route.ts` max ~30 lines: parse zod schema → auth via `@ft/auth-admin` → delegate to `~/features/<feature>/service.ts` → shape response.
- `app/<page>/page.tsx` (RSC): call `~/features/<feature>/data.ts` directly (server-side fetch, no React Query). Hand to colocated client components.
- Client components needing reactive data → use `~/features/<feature>/hooks.ts` (React Query).

### Code style (Link 2)

- **Arrow functions** preferred for components and helpers.
- **Always annotate return types** on exported functions (lint rule: `@typescript-eslint/explicit-module-boundary-types: warn`).
- **Destructure props** in component signatures.
- **No `any`** — use `unknown` + narrow, or generics. (`@typescript-eslint/no-explicit-any: error` in `src/`.)
- **Import order** (enforced via `eslint-plugin-import` `import/order`): React → Next → third-party → `@ft/*` workspace → `~/` (apps/web/src) → `@/` (apps/web root) → relative.
- **Prettier:** 2-space, double quotes, trailing comma, semicolons, print width 100.
- **Comments:** brief usage comment per component/hook; document only the WHY when non-obvious. Per CLAUDE.md "no laziness" rule — no temp fixes, root-cause everything.

### React Query

**Use React Query for:**
- Client-side admin tables and lists — replace existing `useEffect + fetch + setState`.
- Polling surfaces (camera-assign live status, video-match progress) via `refetchInterval`.
- Mutations from admin UIs (resend ticket, block/unblock video, claim POV code) via `useMutation` + `queryClient.invalidateQueries({ queryKey: [...] })`.
- Booking flow client-side lookups (Pandora schedule fetches, KBF availability checks).

**Do NOT use React Query for:**
- React Server Components — they fetch directly via `data.ts`.
- Cron handlers, webhooks, server actions performing writes — server-side only.
- One-off fetches inside server functions.
- Static marketing pages — RSC suffices.

**Conventions:**
- Each feature owns `~/features/<feature>/queries.ts` (query-key factory + queryFn) and `~/features/<feature>/hooks.ts` (`useFooQuery`, `useFooMutation` exports).
- Query keys: domain-prefixed tuples — `['sms-log', 'page', { source, dateRange }]`, `['videos', 'list', filters]`, `['videos', 'detail', id]`. Centralize in `@ft/shared/queryKeys.ts` for cross-feature invalidations.
- Defaults set on the root `QueryClient` in `src/context/QueryProvider.tsx`: `staleTime: 30_000`, `refetchOnWindowFocus: false`, `retry: 1`.
- Devtools mount only in dev (`process.env.NODE_ENV !== "production"`).
- Skip Suspense mode initially — admin tables don't need it; revisit per feature.
- Mocking in tests: `MSW` (Mock Service Worker) for queryFn, NOT `vi.mock` of the hook.

### Feature flags (Statsig)

**Use Gates for:**
- Boolean feature toggles (`sms_log_v2_enabled`, `videos_admin_v2_enabled`).
- v2 cutover rollouts: deploy → flip for one ops user → expand to admins → canary 10% public → 100% → delete v1.

**Use Dynamic Configs for:**
- Per-customer pricing variants (return structured `{ price, label, currency }` per user).
- A/B copy / layout variants where the variant is more than a boolean.

**Conventions:**
- All flag access goes through `@ft/feature-flags`. ESLint bans `process.env.NEXT_PUBLIC_*_ENABLED` outside that package.
- Identity model: anonymous cookie UUID for marketing pages; BMI personId for booking flows. Brand always passed as custom property.
- For pricing flags: see "Pricing rule" in `tasks/lessons.md` — displayed price MUST be re-eval'd server-side at charge time.

### Session replay (Sentry + Clarity)

**Use for:**
- Engineering debugging via Sentry: replay correlated with the error stack.
- PM/UX exploration via Clarity: anonymous, watch users navigate marketing/booking flows.

**HARD RULES:**
- KBF routes (`/hp/kids-bowl-free/*`, `/api/kbf/*`) **NEVER recorded** — COPPA.
- Admin routes (`/admin/*`, `/api/admin/*`) **NEVER recorded** — customer PII.
- All form inputs masked by default; `<MaskedInput>` wrapper for explicit fields.
- `SESSION_REPLAY_ENABLED` env var kill-switch — flip off instantly if something goes wrong.
- Build-time check: any new route opting in to replay under `/kbf` or `/admin` patterns → CI fail.

### Testing

- **Vitest** as runner (chosen over Jest for ESM + speed + Turborepo integration).
- **React Testing Library** for component tests.
- **MSW** for API mocking in both unit and integration tests.
- **Tests colocate** as `*.test.ts(x)` next to source.
- **Coverage targets** (none enforced yet; add to CI once we have ≥30 tests):
  - `packages/*`: every public function gets a unit test
  - `src/features/<feature>/service.ts`: unit tests for happy path + each error branch
  - `src/features/<feature>/hooks.ts`: integration tests with MSW + `renderHook`
- **No e2e in CI yet.** Playwright happy-path is a Phase 4 deferred item, gated by `TEST_E2E=1` when added.

### Documentation & onboarding

- **Root `README.md`:** getting-started (`pnpm install && pnpm dev`), workspace map, link to `docs/adr/` and `CLAUDE.md`.
- **Per-package `README.md`:** purpose, public API, an example. Required for every `packages/*`.
- **`CLAUDE.md`:** the table-of-contents for future Claude sessions. Updated whenever a hard rule changes.
- **`docs/adr/`:** Architecture Decision Records, numbered (`0001-pnpm-turbo.md`, `0002-react-query.md`, `0003-no-shadcn.md`, ...). Format: Status / Context / Decision / Consequences. Created when a decision constrains future work.
- **JSDoc:** brief usage comment per exported component, hook, service. Skip the verbose `@param`/`@returns` ceremony — TypeScript types carry that load.
- **Onboarding checklist** in `README.md`: clone → `nvm use` → `pnpm install` → copy `.env.example` to `.env.local` → `pnpm --filter web dev` → first-PR walkthrough link.

## Lessons-as-guardrails (from [tasks/lessons.md](lessons.md))

| Lesson | Concrete enforcement |
|---|---|
| **BMI ID precision** | `@ft/db` exports `queryWithRawIds(text, params, { rawIdFields: string[] })`; ESLint `no-restricted-syntax` bans `JSON.stringify` in `**/bmi*.ts` and files importing from `@ft/services/bmi` or passing IDs to `@ft/feature-flags`. |
| **Idempotency on shared inventory** | `@ft/db.withIdempotency(key, fn)` Redis-locked by `(endpoint, billId\|sessionId\|personId)`. Service functions touching shared inventory accept `IdempotencyKey` (branded type from `@ft/shared`) as first arg → compile-time error if missing. |
| **Multi-source data cascade** | `@ft/shared.cascade<T>(...sources)` helper. Convention: files under `**/confirmation/**` or `**/admin/**` read via `cascade(live, cached, fallback)`. Soft lint rule flags direct `cachedSource?.x` access without sibling live read. |
| **`useCallback` dep arrays** | `react-hooks/exhaustive-deps: "error"` scoped to `apps/web/src/**` (new code). Existing components stay at `warn` so no PR is blocked retroactively. |
| **`isSharedTopLevelRoute` middleware desync** | `@ft/shared.SHARED_TOP_LEVEL_ROUTES: readonly string[]`; [middleware.ts:337-339](../fasttrax-web/middleware.ts) imports it. Vitest test scans `apps/web/app/*/page.tsx` directories at depth 1 and fails CI if any page uses `headers()` to switch on host but isn't in the const. |
| **Per-customer pricing displayed ≠ charged** | `@ft/feature-flags` `evaluatePricing()` writes audit row before returning. Charge handler re-eval'd via same helper; mismatch throws and pages on-call. (Lesson appended to `tasks/lessons.md` before PR11 ships.) |
| **Session replay on PII routes** | `@ft/observability` route allow-list with build-time check denying KBF + admin patterns. CI fails if violated. |

## Phase 3 v1 migration backlog (prioritized)

This is the menu Phase 3 pulls from. No fixed PR order — items move when one of the three Phase 3 triggers fires.

**High** (active touch points, recent commits — most likely to be needed by early v2 features):

1. [lib/sms-log.ts](../fasttrax-web/lib/sms-log.ts), `lib/sms-quota.ts`, `lib/sms-retry.ts`, [lib/twilio-send.ts](../fasttrax-web/lib/twilio-send.ts) → `src/features/sms/` + `@ft/services/twilio`. Pulled by **PR9 v2 SMS log worked example**.
2. `lib/video-event-processor.ts`, `lib/video-match.ts`, `lib/video-notify.ts`, `lib/video-block.ts`, `lib/vt3.ts`, `lib/vt3-shadow-log.ts` → `src/features/videos/` + `@ft/services/vt3`. **High React Query value** — likely pulled by v2 Videos admin.
3. `lib/race-tickets.ts`, `lib/heat-conflict.ts`, `lib/camera-assign.ts`, `app/api/admin/pov-codes/*` → `src/features/race-day/`. Pulled by v2 camera-assign / voucher admin.
4. `lib/sales-lead-card.ts`, `lib/sales-lead-config.ts`, `lib/sales-lead-copy.ts`, `lib/sales-log.ts`, `components/SalesLeadForm.tsx` (43KB!) → `src/features/sales-leads/`. Component must be split during migration.

**Medium**:

5. `lib/bmi-*.ts` + `lib/data.ts` `bookRaceHeat()` → `@ft/services/bmi` + `src/features/booking/`. **Blocker:** must follow PR6 (`queryWithRawIds`).
6. `lib/pandora-*.ts` → `@ft/services/pandora` + `src/features/parties/`.
7. `lib/kbf-*.ts` → `@ft/services/kbf` + `src/features/kbf/`.
8. `lib/sendgrid.ts` + `emails/` → `@ft/services/sendgrid` + `src/features/emails/`.
9. `lib/packages.ts` flag reads → `@ft/feature-flags` (after PR8 lands).

**Low** (defer; cost > benefit until they need to change):

10. `lib/attractions-data.ts` (41KB), `lib/alternatives-data.ts` → `apps/web/src/lib/constants/` static data.
11. `lib/clickwrap.ts`, `lib/a11y.ts`, `lib/analytics.ts`, `lib/use-visible-interval.ts` → `apps/web/src/hooks/` or `src/lib/helpers/`.
12. `lib/headpinz-locations.ts`, `lib/booking-location.ts` → `@ft/shared/brand`.
13. `lib/teams-bot.ts`, `lib/google-auth.ts`, `lib/indexnow.ts` → `@ft/services/<vendor>/`. Low traffic.

**Bridges** (mechanical, schedule when convenient): `kart-timing-bridge/` and `vt3-bridge/` → `apps/`. Coordinated Railway "Root Directory" config change per service.

## What this plan deliberately does NOT do

- **Does not install Shadcn/ui** or any other component-library kit. Custom `src/components/ui/` only.
- **Does not move existing app code** in Phase 0–1 (PR3 relocates the directory but no file contents change; v1 migrations are entirely Phase 3, opportunistic).
- **Does not introduce an ORM** — raw SQL stays. BMI precision constraint forbids any layer that auto-casts bigints through JSON.
- **Does not replace admin auth** with NextAuth/Clerk.
- **Does not split brands into two apps**.
- **Does not change deploy targets** (Vercel for web, Railway for bridges).
- **Does not retroactively enforce the new ESLint rules** on existing code.
- **Does not bump Next, React, or Tailwind versions.**
- **Does not modify `vercel.json` cron paths.**
- **Does not adopt Suspense Mode for React Query** initially.
- **Does not add Storybook, MSW UI, tRPC, or any other framework.**
- **Does not force-migrate existing pages to React Query.** v1 pages keep their `useEffect+fetch+setState`. New v2 features use React Query; v1 pages convert only when they're being rewritten as v2 in Phase 2 or migrated as part of Phase 3.
- **Does not record session replay on KBF or admin routes** under any circumstances.

## Persistence & cross-session tracking

This effort spans multiple days, sessions, and potentially other people picking up where someone left off. The plan and progress live in three files:

| File | Purpose | Audience |
|---|---|---|
| **`tasks/restructure-plan.md`** *(this file)* | Canonical full plan: phases, PRs, conventions, migration backlog, guardrails. Source of truth for the whole effort. | Everyone with repo access — humans, future Claude sessions, new teammates. |
| **`tasks/restructure-status.md`** | Live progress tracker: phase/PR checkboxes, dates landed, current "next up", any open blockers. Updated as PRs land. | Everyone. **Read first** when picking up the work. |
| `CLAUDE.md` | Adds pointers to this file and status so future Claude sessions load them on startup. | Future Claude sessions. |
| `tasks/lessons.md` *(existing)* | Lessons & guardrails (BMI ID precision, idempotency, etc.). New lessons learned during the restructure get appended here per the existing CLAUDE.md self-improvement loop. | Everyone. |
| `tasks/todo.md` *(existing)* | Open in-flight feature work. The restructure does NOT take this over — that file keeps tracking feature-level open tasks (e.g. the HeadPinz `/book` metadata task). | Everyone. |

### Update protocol

- **When a restructure PR merges:** check the box in `tasks/restructure-status.md`, fill in the PR number + date, and bump `Next up`. Same PR.
- **When a Phase 3 v1 migration ships:** add a one-line entry under "Phase 3 — v1 migration backlog" of the status file: `- [x] sms-log → src/features/sms (#<pr>, YYYY-MM-DD)`.
- **When a decision changes** (e.g. you decide to split brands after all, or swap Vitest for Jest): edit this file directly and add an ADR entry under `docs/adr/`.
- **When a new lesson surfaces:** add to `tasks/lessons.md` per the existing convention; if it's a restructure-specific lesson, also note it in the status file's "Lessons learned during restructure" section.

## Critical files for implementation reference

- [fasttrax-web/package.json](../fasttrax-web/package.json) — current deps; becomes `apps/web/package.json` in PR3
- [fasttrax-web/tsconfig.json](../fasttrax-web/tsconfig.json) — extends `tsconfig.base.json` after PR1; gains `~/*` alias in PR3
- [fasttrax-web/vercel.json](../fasttrax-web/vercel.json) — 9 cron paths, must not change
- [fasttrax-web/middleware.ts](../fasttrax-web/middleware.ts) — 409-line load-bearing brand router; auth block (22–132) extracted in PR7; `isSharedTopLevelRoute` (337–339) replaced by `@ft/shared` const in PR5
- [fasttrax-web/next.config.ts](../fasttrax-web/next.config.ts) — CSP, www→apex 301s, `/documents/*` rewrite — preserve as-is; CSP gets Statsig + Sentry endpoints in PR8 / Phase 4
- [fasttrax-web/eslint.config.mjs](../fasttrax-web/eslint.config.mjs) — flat config; new rules layered in PR2 scoped to `src/`
- [fasttrax-web/app/layout.tsx](../fasttrax-web/app/layout.tsx) — `<QueryProvider>` wired in PR5, `<StatsigProvider>` in PR8
- [fasttrax-web/lib/db.ts](../fasttrax-web/lib/db.ts) — extracted in PR6
- [fasttrax-web/lib/admin-auth.ts](../fasttrax-web/lib/admin-auth.ts) — extracted in PR7
- [fasttrax-web/lib/packages.ts](../fasttrax-web/lib/packages.ts) — env-flag reads migrate to `@ft/feature-flags` in PR8
- [fasttrax-web/scripts/a11y-gate.mjs](../fasttrax-web/scripts/a11y-gate.mjs) — postbuild a11y check, must keep working
- [tasks/lessons.md](lessons.md) — source of guardrail requirements
- [tasks/todo.md](todo.md) — open in-flight work to coordinate around (HeadPinz metadata on shared `/book`)
