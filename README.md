# Tools-Website-FT

Multi-brand venue site (FastTrax + HeadPinz) and supporting bridges. Single
Next.js app serves both brands via host-based routing; two Node bridges
relay live timing / video event streams to the web app's webhooks.

## Workspace layout

```
Tools-Website-FT/
├── apps/
│   └── web/               # Next 16 + React 19 site (npm workspace name: fasttrax-web)
├── kart-timing-bridge/    # Node service: kart timing WebSocket → web webhook
├── vt3-bridge/            # Node service: VT3 video SSE → web webhook
├── packages/              # (empty; @ft/* workspace packages land PR4+)
├── docs/                  # API docs + architecture decision records
└── tasks/                 # Active plan / status / lessons / open work
```

## Prerequisites

- **Node 24+** (see [.nvmrc](.nvmrc)). Use `nvm use` to match.
- **npm 11+** (pinned via `packageManager` in [package.json](package.json)).
- For local secrets: 1Password vault **"FastTrax Dev"** has shared dev
  credentials for Neon (Postgres) and Upstash (Redis).

## First-time setup

```bash
# 1. Install dependencies (workspace-aware npm install at the root).
npm install

# 2. Copy the env template and fill in values.
cp .env.example apps/web/.env.local
# Open apps/web/.env.local; minimum to boot:
#   DATABASE_URL         (Neon — from 1Password)
#   REDIS_URL            (Upstash — from 1Password)
#   NEXT_PUBLIC_SITE_URL=http://localhost:3000

# 3. Start the dev server.
npm run dev -w fasttrax-web
```

The site is now on `http://localhost:3000`. By default this is the
**FastTrax** brand.

## Switching brand in local dev

Production uses the request `Host` header to pick brand
(`headpinz.com` → HeadPinz, otherwise FastTrax). Localhost has no
brand-bearing host, so [middleware.ts](apps/web/middleware.ts)
exposes a dev-only override:

| URL                                     | Effect                                                                                                                       |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `http://localhost:3000/?brand=headpinz` | Sets the `dev-brand=headpinz` cookie (7 days) and redirects. Subsequent requests render as if you arrived on `headpinz.com`. |
| `http://localhost:3000/?brand=fasttrax` | Clears the cookie. Back to FastTrax.                                                                                         |

The override is gated by `NODE_ENV !== "production"` — production
ignores `?brand=` and the cookie entirely. Safe to leave the cookie set
in your local browser indefinitely.

Direct `/hp/...` URLs also work for HeadPinz pages on localhost (the
middleware sets the brand header for any path under `/hp/`), but using
`?brand=headpinz` once and then navigating clean URLs is usually nicer.

## Common commands

All run from the repo root.

| Command                       | What it does                                 |
| ----------------------------- | -------------------------------------------- |
| `npm run dev -w fasttrax-web` | Start the Next.js dev server.                |
| `npm run build`               | Build every workspace via `turbo run build`. |
| `npm run typecheck`           | `tsc --noEmit` across every workspace.       |
| `npm run lint`                | ESLint across every workspace.               |
| `npm run test`                | Vitest across every workspace.               |
| `npm run format`              | Prettier write across the repo.              |
| `npm run format:check`        | Prettier check — what CI runs.               |

Pre-commit hook (Husky + lint-staged) auto-runs Prettier on staged
files. Never bypass with `--no-verify`.

## Troubleshooting

### Typecheck fails with `Cannot find module '.../layout.js'`

Stale Next.js typegen. Delete the cache and try again:

```bash
rm -rf apps/web/.next
npm run typecheck
```

This happens when a route layout has been removed since the last build
but Next's `.next/dev/types/validator.ts` still references it. CI is
unaffected because it starts cold.

### Pre-commit hook errors with `env: unknown option -- version/_/pre-commit`

Husky's `prepare` script corrupted `core.hooksPath` (Windows shell
quoting bug). Reset it:

```bash
git config core.hooksPath .husky/_
```

### Brand override isn't taking effect

Confirm the cookie was set: open DevTools → Application → Cookies →
`http://localhost:3000`, look for `dev-brand`. If absent, the redirect
didn't fire — check that you hit `?brand=headpinz` (not `?brand=hp`).
If the cookie is set but pages render as FastTrax, check `NODE_ENV` is
not `production` (`echo $NODE_ENV` or check what `.env.local` sets).

### `npm install` is slow / fails

Confirm Node version: `node --version` should be 24+. If npm reports
"unsupported engine" warnings on bridges, you're on an old Node.

## Where to look next

| Looking for...                                             | Read...                                                                                                    |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| What's actively in flight                                  | [tasks/restructure-status.md](tasks/restructure-status.md), [tasks/todo.md](tasks/todo.md)                 |
| Architecture / conventions for new code                    | [tasks/restructure-plan.md](tasks/restructure-plan.md), [CLAUDE.md](CLAUDE.md)                             |
| Lessons + guardrails (BMI ID precision, idempotency, etc.) | [tasks/lessons.md](tasks/lessons.md)                                                                       |
| Architecture decisions                                     | [docs/adr/](docs/adr/)                                                                                     |
| Vendor API docs                                            | [docs/](docs/) (BMI, Pandora, KBF, bowling admin, etc.)                                                    |
| Bridge-specific setup                                      | [kart-timing-bridge/README.md](kart-timing-bridge/README.md), [vt3-bridge/README.md](vt3-bridge/README.md) |

## Deployment

- **Web (fasttrax-web)** → Vercel. Project root is `apps/web/` (moved
  from `fasttrax-web/` in PR3; Vercel root-dir flip is the cutover
  step — see [tasks/restructure-status.md](tasks/restructure-status.md)).
- **Bridges** → Railway. One Railway service per bridge.

CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs
format / typecheck / lint / test / build on every PR. Vercel deploys on
push to main.
