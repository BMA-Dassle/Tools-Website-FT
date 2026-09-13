# 0002. The Sales CRM lives at `/admin/crm`, with `/crm` as a redirect

**Status:** Accepted
**Date:** 2026-09-12
**Deciders:** Eric Osborn (owner, decision recorded 2026-09-12 21:58); technical lead for the CRM build

## Context

The group-events Sales CRM is a staff-only tool for the sales reps and their
director. The approved plan's D10 note said "`/crm` on the main site" — the
owner's stated reason was the URL ("why not just use /crm"), not any mechanism.

What already exists (`apps/web/auth.ts`, `src/features/sso/*`, `middleware.ts:251-601`):
an Auth.js v5 provider (`headpinz`, client `fasttrax-admin`), an edge cookie gate
for every `/admin/<slug>` in `SSO_ADMIN_TOOLS`, the `x-admin-route` header that
strips site chrome and skips Microsoft Clarity (CLAUDE.md: never record session
replay on admin routes), the `admin.fasttraxent.com/<slug>` alias, the signed
8-hour API credential (`mintAdminApiToken`), the `/admin/{token}/<slug>` redirect
lane, the registry drift tests and the Playwright sweep. Entra app roles
`fasttrax-admin.sales` / `fasttrax-admin.sales-director` arrive through that gate
as `sales` / `sales-director` with zero gateway change.

A bare `/crm` page tree would need new middleware branches on three hosts, a
`SHARED_TOP_LEVEL_ROUTES` entry, header plumbing to suppress chrome and Clarity,
a new callback-URI negotiation with the gateway — and would still leave
`/api/crm/**` ungated. `middleware.ts` is a file this programme may not edit.

## Decision

The CRM is the SSO admin tool `crm`: pages at `/admin/crm` and `/admin/crm/[...view]`,
route handlers at `/api/admin/crm/**` (every one re-checks the admin credential
AND the SSO session through `withCrmRoute`, so `actor_email` is always the
signed-in person), one cron at `/api/cron/crm-jobs`. `next.config` carries a
non-permanent redirect `/crm/:path*` → `/admin/crm/:path*` (plus bare `/crm`) so
the owner's URL still works: `headpinz.com/crm` and `admin.fasttraxent.com/crm`
both land on the gated tool. Config redirects run before middleware, so the
`/hp` rewrite on the HeadPinz host never sees `/crm`.

Only three public `/api/crm/**` routes are permitted in the whole programme,
each authenticated by its own secret: `graph-webhook`, `3cx/{lookup,journal}`,
`share/[token]`. PR1 ships none of them.

## Consequences

### What this enables

- Sign-in, roles, chrome suppression, Clarity exclusion, the admin-host alias,
  the minted API token, the redirect lane, the drift tests and the e2e sweep —
  all inherited with a two-line registry edit (`SSO_ADMIN_TOOLS` + its test).
- Route handlers learn WHO acted from the same session cookie the page used; no
  body-supplied actor emails (the `/api/group-function/approve` anti-pattern).
- The `/crm` habit survives as a typing convenience without a second gate.

### What this costs

- One `[token]/crm/page.tsx` shim exists only to satisfy the v1→v2 mirror test;
  it always 307s to `/admin/crm` (the CRM cannot render from a token URL — it
  needs the SSO identity for `actor_email`), so the `ADMIN_TOKEN_REDIRECT_DISABLED`
  kill switch does NOT cover the CRM.
- No further `page.tsx` may be added under `app/admin/[token]/crm/` or the
  mirror test demands a v2 twin for each.
- The URL in the address bar is `/admin/crm`, not `/crm`.

### What becomes harder

- A future non-staff surface (a guest-facing share page) cannot live under
  `/admin/crm`; it goes to `/api/crm/share/[token]` with its own token auth.

## Alternatives considered

**A bare `/crm` page tree with its own gate.** Rejected: three hosts' worth of
new middleware branches, a `middleware.ts` edit this programme forbids, header
plumbing for chrome/Clarity, and `/api/crm/**` still ungated. Everything it
would buy is the URL, which the redirect provides.

**`/l/[token]` guest links via `isSharedTopLevelRoute`.** Rejected for the same
reason (a middleware edit plus a fourth top-level guest prefix); share links are
served from `app/api/crm/share/[token]` instead.

**Rendering `AdminToolPage` from the `[token]/crm` shim under the kill switch.**
Rejected: a token-only render has no identity to record as `actor_email`.
