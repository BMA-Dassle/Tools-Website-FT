# 0001. npm workspaces + Turborepo (replaces pnpm)

**Status:** Accepted
**Date:** 2026-05-06
**Deciders:** Alex

## Context

The monorepo restructure (PR1) originally chose pnpm + Turborepo. After
three failed Vercel deploys and ~6 hours of debugging
(`ERR_PNPM_META_FETCH_FAIL`, `ERR_INVALID_THIS`, Vercel-bundled pnpm
overriding pinned versions, Node 24 strict `URLSearchParams` checks), we
abandoned pnpm. See [tasks/lessons.md](../../tasks/lessons.md) "pnpm +
Vercel = quagmire" for the full incident.

The constraint: this codebase deploys to Vercel (web) and Railway (bridges).
Both platforms test against npm by default. Vercel walks UP from the
configured project root looking for any lockfile — finding a workspace-root
pnpm lockfile flipped its install command in unrecoverable ways.

## Decision

The monorepo uses **npm workspaces + Turborepo** at the root. The single
lockfile lives at the repo root as `package-lock.json`. `packageManager`
is pinned to `npm@11.6.4` in root `package.json`. Workspace packages
do NOT have their own lockfiles.

Turborepo orchestration (build, dev, lint, typecheck, test) is unchanged
— it's package-manager-agnostic.

## Consequences

### What this enables

- One install command at the root: `npm install`.
- Vercel auto-detects npm from the root lockfile; no install-command override
  required.
- Aligns with the dominant lockfile platform builders test against.
- Local install behavior matches Vercel install behavior.

### What this costs

- pnpm's strict isolated `node_modules` model is lost. Transitive deps now
  hoist — e.g. `fasttrax-web/eslint.config.mjs` can import
  `eslint-plugin-jsx-a11y` without declaring it (transitively pulled via
  `eslint-config-next`). We're not catching that class of bug at install
  time.
- npm install is slower than pnpm install on cold caches.

### What becomes harder

- Adding a dependency safely (without accidentally relying on a hoisted
  transitive) requires discipline. If this becomes a real source of bugs,
  add `depcheck` or `knip` to CI.
- Cross-workspace symlinks behave per npm's hoisting heuristics, not pnpm's
  isolation guarantees.

## Alternatives considered

- **pnpm + Turborepo** — what we tried in PR1; failed for the reasons
  above. The ergonomic upside was real but the Vercel deploy risk was too.
- **Yarn 4 / Berry** — adds a third package manager to learn; same risk
  class as pnpm on Vercel.
- **Nx** instead of Turborepo — heavier opinionation than this monorepo
  needs; Turbo is already in and working.
