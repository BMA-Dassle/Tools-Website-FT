# Admin SSO lockdown — audit report

**Status:** PR 1 (`feat/admin-sso`) implemented. PR 2 (cutover + rotation) NOT started
and needs the owner's go.
**Date:** 2026-08-28. **Branch:** `feat/admin-sso` off `main`.

The goal of the two-PR sequence is one sentence: **no human reaches a FastTrax admin
page without signing in with their Microsoft account.** PR 1 makes that possible
without breaking anyone. PR 2 makes it true, and is the only step that removes
access.

This file is the evidence for PR 2. Every place the codebase touches
`ADMIN_CAMERA_TOKEN`, `ADMIN_ETICKETS_TOKEN`, `x-admin-token` or a `/admin/…` URL
is classified below, so the cutover can be reasoned about rather than guessed at.

---

## Before PR 1 merges — two ordering facts that are not optional

**A. The admin project's SSO env must exist BEFORE the first deploy of this
branch.** Set `SSO_ISSUER`, `SSO_CLIENT_ID`, `SSO_CLIENT_SECRET` and
`AUTH_SECRET` on `tools-website-ft-admin` first. Auth.js validates its
configuration on the first *request*, so with any of them missing the `auth()`
wrapper in `proxy.ts` throws on every request — `/sso/error` and `/api/auth/*`
included — and the shell 500s everything. That project is a working
Vercel-Authentication wall today; deploying without the block trades "walled" for
"broken". (`apps/admin/auth.ts` builds its config in a factory so the values are
read per request, not at import — that fixes stale env, not missing env.)

**B. `apps/web` must not ship more than a window ahead of the shell's domain.**
`src/lib/helpers/admin-url.ts` hard-targets `https://admin.fasttraxent.com`, and
after PR 1 every staff link goes through it: `adminBoardUrl()` (staff email),
`vipBoardUrl()` (Teams cards), and both `/admin/{token}/daily-events` redirect
shims. Until that domain is attached, either attach it in the same window as the
`tools-website-ft` deploy or set `ADMIN_PUBLIC_URL` on `tools-website-ft` to the
shell's `.vercel.app` origin. Otherwise every "Open board" button and every
brand-domain daily-events bookmark points at a domain that does not resolve.

**C. The PR 1 smoke has not been run.** `apps/admin/proxy.test.ts` mocks `./auth`
wholesale, so the real Auth.js wrapper, the `req.auth` shape, the cookie flags
and the sign-in round trip are unverified in this branch. The checklist is in
`tasks/todo.md` under "PR 1 smoke"; treat those behaviours as claims until it is
run on the preview.

---

## The surface, counted

Grepped across `apps/web` (excluding `node_modules`):

| Pattern | Files | Where they land below |
|---|---:|---|
| `ADMIN_CAMERA_TOKEN` | 116 | §1 – §6 |
| `ADMIN_ETICKETS_TOKEN` | 11 | §5 (legacy) |
| `x-admin-token` | 43 | §1 (browsers), §4 (machines) |
| `/admin/` literal | 224 | mostly doc comments; the URL-BUILDING ones are §2 |

Counting files overstates the problem: most of the 116 are a route's own
`process.env.ADMIN_CAMERA_TOKEN` comparison (§3), which never leaves the server.
The dangerous classes are small and are both closed in PR 1.

---

## 1. Browser-facing — the static token was shipped to ~20 client bundles. **FIXED in PR 1.**

Every `/admin/{token}/*` page passed the route param (== `ADMIN_CAMERA_TOKEN`)
into its client component, and every `/admin/embed/*` page passed the env var.
The client then sent it as `x-admin-token` / `?token=`. That is a permanent,
un-rotatable bearer secret in devtools, in screenshots, in `view-source`, and in
anything a staff member pasted into a chat.

**Fix:** the pages call `mintAdminApiToken()` (`apps/web/lib/admin-api-token.ts`)
and pass an 8-hour HMAC credential instead. Client components are untouched —
same prop, same header, different value.

The minted token authenticates **`/api/admin/*` only** — the middleware branch
that accepts it is scoped to that prefix. It is a browser-held credential that
travels in query strings, so treating it as a page credential too would hand
whoever copied one out of a URL bar 8 hours of `/admin/<anything>/…` (including
`api-docs`, a `"use client"` page with no check of its own) and would leave PR 2
step 2 with nothing to lock down. The page credentials remain the shell's
`x-admin-proxy-key` and the static token in the path.

23 pages: `[token]/{briefing, camera-assign, camera-assign/[track], checkin,
daily-events-v2, deals, deposit-failures, discount-codes, e-tickets,
group-approvals, group-functions, kbf, pit, reservations, sales, signage, videos,
web-sales}` + `embed/{bowling, daily-events, daily-events-v2, e-tickets, videos}`.

Three `[token]` pages never passed a token and needed no change: `api-docs`,
`christmas-in-july`, `healthnet` (all render server-fetched rows).

**Pinned by** `apps/web/scripts/check-admin-token-leak.mjs`, wired into
`npm run test -w fasttrax-web`: it fails the build if any `"use client"` module,
anything under `src/components/**`, any `src/features/*/api.ts`, or any
`app/admin/**/*Client*.tsx` references the static token envs again. Verified it
fails on a planted leak.

## 2. Staff links — the token was mailed, posted to Teams, and put in Location headers. **FIXED in PR 1.**

| File | Was | Now |
|---|---|---|
| `src/lib/helpers/admin-email.ts` `adminBoardUrl()` | `https://headpinz.com/admin/{token}/deals` in every staff alert | `adminToolUrl("deals")` → `https://admin.fasttraxent.com/deals` |
| `src/features/vip-move-alerts/config.ts` `vipBoardUrl()` | tokened URL inside every Teams card | `adminToolUrl("reservations", {view:"vip"})` |
| `app/admin/[token]/briefing/BriefingRoomClient.tsx` (×2) | `/admin/${token}/briefing?room=…` — would 404 once the prop became a minted token | `adminToolUrl("briefing", {room})` |
| `app/admin/[token]/deals/DealsAdminClient.tsx` | `/admin/${token}/web-sales?source=deals` | `adminToolUrl("web-sales", {source:"deals"})` |
| `app/admin/[token]/daily-events/page.tsx` | `redirect("/admin/${token}/daily-events-v2")` — a token in a browser-visible `Location` header | `adminToolUrl("daily-events-v2", query)` |
| `app/admin/[token]/daily-events/[projectId]/page.tsx` | same, via the v1 path | `adminToolUrl("daily-events-v2", {event, location, date})` |

`lib/healthnet-almost-here.ts` was on the suspect list and is CLEAR: it uses
`ADMIN_CAMERA_TOKEN` only as an HMAC key fallback for the guest confirm token
(`HEALTHNET_CONFIRM_SECRET || ADMIN_CAMERA_TOKEN`). It builds no admin URL, and
an HMAC never reveals its key. No change needed. Same shape, same verdict:
`src/features/reservation-edit/pay-link.ts` (`EDIT_PAY_LINK_SECRET ||
ADMIN_CAMERA_TOKEN`) — see §6.

Tests assert the static token appears in NEITHER the rendered HTML nor the text
alternative of a staff email, and nowhere in a rendered Teams card.

## 3. Server-side route checks — keep, now credential-agnostic. **CHANGED in PR 1 (additively).**

~45 `/api/admin/*` routes compared the token themselves, on top of the middleware
gate. That is deliberate defense in depth (these routes cancel reservations,
refund cards, and write to screens guests can see) and it stays — but each was
its own copy of `token === process.env.ADMIN_CAMERA_TOKEN`, which is exactly why
the token could never leave the browser: a minted token would have 401'd all of
them.

The comparison moved into `apps/web/lib/admin-request-auth.ts`, once. It accepts:
the static token (crons, `.bat` scripts, old bookmarks), a signed short-lived
token (browsers), or `x-admin-proxy-key` (the shell). It is still a REAL
credential check — a forged `x-admin-route: 1` header proves nothing to it.

`lib/portal-auth.ts` (`verifyPortal`) got the same treatment; that one covers the
eight `/api/admin/daily-events/*` routes the board uses AND the portal's own
`/api/portal/*` integration.

Full list of routes touched is in the commit `08ba96c3f` diff. No route's
response shape, status code, or ordering changed.

## 4. Machine self-fetch / cron — keep, header only, rotate the value at PR 2. **UNCHANGED.**

Nine crons accept `?token=<ADMIN_CAMERA_TOKEN>` as a manual-run bypass beside
`verifyCron`:

`bmi-sync-queue`, `bowling-no-show-close`, `kiosk-bmi-sync-sweep`,
`kiosk-tender-sweep`, `race-cancel-watch`, `race-confirm-reconcile`,
`race-dayof-pay`, `race-session-assign-sweep`, `reservation-status-close`.

These are machine paths, never rendered to a browser, and were deliberately left
on the static token in PR 1 (smallest blast radius). They must be re-verified on
their next scheduled run after the PR 2 rotation.

Three more routes outside `/api/admin/*` gate on the static token and are NOT
called by any admin board (verified by grep across `app/admin`, `src/components`,
`src/features`): `app/api/square/bowling-refund`, `app/api/notifications/cancellation`,
`app/api/bowling/v2/webhook-log`. They keep the static token.

## 5. Legacy `ADMIN_ETICKETS_TOKEN` — delete at PR 2. **UNCHANGED.**

Still live in three places: the middleware's 308 shim
(`/admin/{legacy}/… → /admin/{current}/…`), a soft server-side accept on the
`e-tickets`, `sales` and `deposit-failures` pages, and the `LEGACY_TOKEN` arm of
the four `deposit-failures` API routes. All are inert once the env var is
removed. `app/api/admin-diag` also reads it — see the unresolved list.

## 6. Guest-facing — must never carry the token. **ALL CLEAR, one exception flagged.**

Inspected every file the brief named, plus the two `publicOrigin()` call sites:

| Surface | Verdict |
|---|---|
| `src/features/reservation-edit/pay-link.ts` | **Clear.** Uses `ADMIN_CAMERA_TOKEN` only as an HMAC key fallback; the guest link carries `?t=<hmac(editId)>`, 32 hex chars, no admin secret. |
| `app/pay/edit/[editId]` (the guest page) | **Clear.** Verifies the HMAC; never reads an admin env. |
| `lib/healthnet-almost-here.ts` → `/event/healthnet-2026/confirm` | **Clear.** Same HMAC-key-only pattern. |
| `app/book/**` confirmation links | **Clear.** No admin token reference anywhere in the booking tree. |
| `src/features/kiosk/license/lookup.server.ts` | **Clear.** No admin token. |
| BMI/Pandora "office" calls | **Clear.** Vendor credentials, unrelated envs. |
| VIP voucher QR (`VipComboCards.tsx`) | **Clear**, and now correct on the new domain: it builds `${publicOrigin(window.location.origin)}/v/{code}`, and `publicOrigin()` drops any `admin.*` host (PR 1) so the QR points at `headpinz.com`, not the auth wall. |
| TV player URL (`SignageAdminClient.tsx`) | **Clear**, same mechanism — `${publicOrigin(...)}/tv?screen=…`. |
| **`app/api/admin-diag/route.ts`** | **NOT clear — see unresolved #1.** |

## 7. Device / TV / kiosk URLs — no tokened device URL exists.

The wall boards and kiosks run on **public** routes (`/tv/*`, `/kiosk/*`), which
the middleware early-returns before the admin gate ever sees them. No `.bat`, no
device config, and no kiosk build in this repo embeds an admin token. Nothing in
this class breaks at PR 2.

The one device-adjacent surface is the **briefing wall tablet**
(`/admin/{token}/briefing`), which IS a tokened admin URL on a screen nobody
signs into daily — see unresolved #2.

---

## Unresolved before PR 2

**1. `GET /api/admin-diag` is an unauthenticated token-guessing oracle.**
It is deliberately outside the admin gate ("it exists specifically to debug why
the gate is rejecting") and answers `?token=xxxx` with a boolean
`tokenMatches`. That is an online verifier for a 32-byte secret, reachable by
anyone on the internet, on both brand hosts. It reports against
`ADMIN_ETICKETS_TOKEN`, which PR 2 deletes — so after rotation it is a public
endpoint that always says `false` and still leaks the IP allowlist membership of
its caller. *Proposed fix: delete the route in PR 2.* It has served its purpose
(the gate is understood now), the shell's `/sso/diag` replaces it for the SSO
era, and no code references it.

**2. The briefing wall tablet needs a credential that survives PR 2.**
`/admin/{token}/briefing` runs on a tablet mounted in a briefing room. Once PR 2
requires `x-admin-proxy-key` for pages, that tablet's bookmark dies, and nobody
is going to complete a Microsoft sign-in on a wall tablet every eight hours.
*Proposed fix: point the tablet at the shell (`admin.fasttraxent.com/briefing`)
and let its Auth.js session cookie persist — `maxAge` is already 8h and the
gateway session is sliding, so a tablet that is never closed stays signed in;
sign it in once during the cutover window and verify it survives a reboot.* If
that proves fragile in practice, the alternative is a device-scoped signed token
(`mintAdminApiToken` with a long TTL, stored in the tablet's URL) accepted for
that ONE page — but do not build that until the simple answer is shown to fail.

**3. `apps/web/lib/admin-auth.ts` is dead code that documents the wrong gate.**
Nothing imports `isAdminRequest`, `isTokenValid`, `isIpAllowed` or `getClientIp`
(verified by grep). The file's header still describes an IP-allowlist gate that
was commented out in `middleware.ts` long ago. *Proposed fix: delete the file in
PR 2.* Left in place for PR 1 only because deleting it is unrelated to SSO and
would widen this diff.

**4. The commented-out `ADMIN_ALLOWED_IPS` block in `middleware.ts`.**
Twenty-five lines of dead code marked `TEMPORARY: IP restriction bypassed for
sharing — revert after review`. The review it refers to is this one. *Proposed
fix: delete it in PR 2* — SSO is the access control now, and an IP allowlist on
top of it would break exactly the phones-and-home-networks case that got it
disabled.

**5. `ADMIN_API_SIGNING_SECRET` is not set anywhere yet.**
PR 1 falls back to signing with `ADMIN_CAMERA_TOKEN` so nothing had to wait on a
Vercel variable. That is safe (an HMAC never reveals its key) but it couples the
signing key to the value PR 2 rotates: rotating `ADMIN_CAMERA_TOKEN` invalidates
every outstanding minted token, so every open admin board would need one reload.
*Proposed fix: set a dedicated `ADMIN_API_SIGNING_SECRET` on `tools-website-ft`
BEFORE the rotation, so the two are independent and the rotation is invisible to
anyone with a board open.*

**6. `x-sso-email` / `x-sso-name` are forwarded but nothing consumes them.**
The shell now tells the upstream who is looking. `web-sales-audit-db.ts` still
writes `actor: "admin"` with a comment saying a name "would be fiction" — it is
no longer fiction. *Proposed fix (not blocking PR 2): read `x-sso-email` in the
admin audit writers, gated on the request having arrived with the proxy key, so
the board's action history names a person.*

The precondition for that is already in place: `proxy.ts` **deletes** every
inbound `x-sso-*` (and any inbound `x-admin-proxy-key`) before setting its own,
so those headers are the shell's word or absent — never the visitor's. Without
that strip, a signed-in temp could have signed the audit trail as anyone by
sending one header. Any future identity header must join `IDENTITY_HEADERS` in
`apps/admin/proxy.ts` the day it is added.

**7. The deal-sale alert's recipient list is still the only access control on it.**
`notifyStaffDealSale` mails voucher codes and money facts to
`DEAL_SALE_NOTIFY_EMAILS`. PR 1 removed the admin token from the button, which
was the acute problem; the mail body itself is still sensitive and unencrypted.
*No fix proposed — noted so it is a decision rather than an oversight.*

**8. The static token still reaches the browser — in Next's RSC payload, not in
any component prop.** Found by driving the shell against a local gateway
(2026-08-28, three-server smoke). `ADMIN_CAMERA_TOKEN` appears **twice in the
HTML of every proxied board** — `/pit`, `/reservations`, `/daily-events-v2`,
`/checkin`, `/camera-assign`, `/discount-codes`, `/signage`, `/videos` were all
checked and all leak it:

```
"c":["","admin","<ADMIN_CAMERA_TOKEN>","pit"]        // canonical segment list
["token","<ADMIN_CAMERA_TOKEN>","d",null]            // router state tree
```

Both come from Next serialising the resolved dynamic segment of the upstream
route `/admin/[token]/pit`. **No application code is involved**, so section 1's
fix is not incomplete and `check-admin-token-leak.mjs` is not broken — it looks
for `ADMIN_CAMERA_TOKEN` *references* in client modules, and there are none.
The same smoke confirms the rest of section 1 holds: across 79 browser requests
on `/pit` and ~50 per board on six more, the static token appears in **zero**
URLs, headers or bodies, and each board's HTML carries a freshly minted
`<expMs>.<hex>` credential instead.

Consequence: anyone who can open a board through the SSO shell can read the
static token out of `view-source` and, until PR 2, use it directly at
`fasttraxent.com/admin/{token}/…` from outside the shell. That is a narrower
audience than before PR 1 (SSO holders, not everyone who was ever mailed a
link) but it is not zero, and it means **PR 1 alone does not achieve "no human
path to an admin page without SSO"** — the rotation in PR 2 is what closes it.

*Proposed fix: none needed in PR 1; PR 2 already closes it twice over — step 2
makes a path-only token 404 for pages, and the rotation invalidates every token
scraped before the cutover. The thing to change is the CLAIM: "the static token
never reaches a browser again" is true of application code and false of the
page HTML until the shell stops proxying to a tokened path. If it should be
true literally, the upstream page route has to stop carrying the token as a
route segment (e.g. `/admin/board/[slug]` gated on the proxy key alone), which
is a bigger change than PR 2 and should not be bolted onto it.*

---

## PR 2 checklist (for when the go is given)

1. Set `ADMIN_API_SIGNING_SECRET` (new, random 32 bytes) on `tools-website-ft`.
   Set `ADMIN_PROXY_KEY` on BOTH projects. — *unresolved #5*
2. `/admin/{token}/*` **pages** additionally require `x-admin-proxy-key`; token in
   the path alone → 404. `/admin/embed/*` unchanged (portal HMAC).
3. `/api/admin/*` accepts proxy key, api-key allowlist, or signed token; the
   static token via **header only** (`?token=` static no longer accepted).
4. Kill switch `ADMIN_LOCKDOWN_DISABLED="true"` reverts to PR 1 behaviour —
   ships ON, per the flags-are-kill-switches rule.
5. Delete: `app/api/admin-diag`, `lib/admin-auth.ts`, the commented IP block,
   `ADMIN_ETICKETS_TOKEN` + its 308 shim. — *unresolved #1, #3, #4*
6. Sign the briefing tablet in and verify it survives a reboot. — *unresolved #2*
7. Rotate `ADMIN_CAMERA_TOKEN` on both projects.
8. Verify after rotation: the nine crons in §4 on their next run (Vercel logs);
   the portal's four iframes and its `x-api-key` services; a VIP voucher QR and a
   TV player URL still resolve to `headpinz.com`.
