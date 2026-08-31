# Admin SSO lockdown — audit report

**Status:** PR A (the gate) is LIVE, in three merges — #45 moved the gate into
`apps/web`, #46 set the tool split, and `feat/admin-sso-remaining` (this branch)
moved the remaining fourteen tools and added the redirect lane. PR B (retire the
shell + rotate) has NOT started and needs the owner's go.
**Date:** 2026-08-28, revised 2026-08-30. **Branch:** `feat/admin-sso-remaining` off `main`.

The goal of the sequence is one sentence: **no human reaches a FastTrax admin
page without signing in with their Microsoft account.** PR A makes that true for
every staffed surface without breaking anyone. PR B removes the static token,
which is the only step that removes access.

This file is the evidence for PR B. Every place the codebase touches
`ADMIN_CAMERA_TOKEN`, `ADMIN_ETICKETS_TOKEN`, `x-admin-token` or a `/admin/…` URL
is classified below, so the cutover can be reasoned about rather than guessed at.

> **Naming.** The original text called the two steps "PR 1" and "PR 2"; the owner
> now calls them PR A and PR B. Same two steps. Section headings below keep the
> old numbering where the prose is unchanged.

---

## The tool split, as shipped — 18 SSO / 3 token

Source of truth: `apps/web/src/lib/constants/admin-tools.ts`, drift-pinned to the
real route directories by `admin-tools.test.ts`.

**SSO-gated (18)** — clean URL `/admin/<slug>`, no credential in the URL; a
Microsoft session holding `fasttrax-admin.access` is the credential:

`api-docs`, `checkin`, `christmas-in-july`, `daily-events`, `daily-events-v2`,
`deals`, `deposit-failures`, `discount-codes`, `e-tickets`, `group-approvals`,
`group-functions`, `healthnet`, `kbf`, `reservations`, `sales`, `signage`,
`videos`, `web-sales`.

**Token-only (3)** — `/admin/{ADMIN_CAMERA_TOKEN}/<slug>`, PERMANENTLY, and each
for a stated reason rather than "not yet":

| Slug | Why it keeps the token |
|---|---|
| `camera-assign` (+ nested `/[track]`) | Worked TRACKSIDE on shared kiosks, one per track, standing up between heats. A per-person sign-in there is a password typed on a shared device in front of guests. |
| `pit` | The pit board — a wall screen that is switched on and left running. |
| `briefing` | The briefing-room wall tablet. Nobody signs a wall screen in every eight hours; an expired session is a blank board every morning. |

Owner decisions: 2026-08-28 (camera-assign back to the token; e-tickets and
videos to SSO; pit and briefing permanent) and 2026-08-30 ("move the rest" — the
fourteen office tools).

The test of membership is the FURNITURE, not the data: a desk tool signs in, a
kiosk or a wall screen does not.

## The redirect lane — a bookmarked token URL becomes a sign-in

`apps/web/middleware.ts`, inside the unified admin gate, after the legacy 308 and
after the valid-token check.

**What it does.** `/admin/{ADMIN_CAMERA_TOKEN}/<slug>[/…]` where the token is
VALID and `<slug>` is in `SSO_ADMIN_TOOLS` → **307** to `/admin/<slug>[/…]`,
query string and deeper segments preserved. The unauthenticated SSO branch then
sends them to `/sso/signin?callbackUrl=/admin/<slug>`, so an old bookmark turns
into one sign-in and then updates itself.

**Why it matters.** Without it, moving a tool to SSO changed nothing for the
people who already had the tokened link — the sign-in was optional for exactly
that audience — and the permanent secret stayed on display in the URL bar of a
board that gets screenshotted. Audit item #8 is about the token in the RSC
payload; this is about the token in the address bar.

**307, not 308.** Browsers heuristically cache 308s, and a cached
`{token} → clean` mapping outlives the `ADMIN_CAMERA_TOKEN` rotation that was
supposed to retire that token. `apps/admin/proxy.ts` already carried that lesson.

**What it does NOT cover** — each exclusion is a live surface, each has a test in
`middleware.sso-gate.test.ts`:

| Not redirected | Why |
|---|---|
| `camera-assign`, `pit`, `briefing` (and `camera-assign/[track]`) | They render at their token URL exactly as today. A 307 is a blank board or a kiosk sent to Microsoft between heats. |
| `/admin/embed/*` | The portal's HMAC iframes. They have no Microsoft session; a sign-in page inside an iframe is a broken embed. Two of the five embed tools (`daily-events`, `daily-events-v2`) are now SSO slugs, so this exclusion is load-bearing. |
| `/api/admin/*` | A board's XHR that follows a 307 to an HTML page reports "Unexpected token &lt;" instead of an auth failure. API credential handling is unchanged. |
| an INVALID token | Still the opaque 404. Redirecting an unknown token would answer "does this slug exist?" for anyone with a wrong guess. |
| everything when `ADMIN_TOKEN_REDIRECT_DISABLED="true"` | The kill switch. Ships ON, per the flags-are-kill-switches rule. |

**Composition with the legacy `ADMIN_ETICKETS_TOKEN` 308:** legacy → canonical →
clean. The legacy shim is untouched and fires first (a legacy token is not the
canonical one, so the lane never sees it); the lane is hop two and is the
uncached 307. Chosen over rewriting the legacy shim to jump straight to the clean
URL because it leaves the shim's pinned behaviour exactly as it was, and PR B
deletes the shim anyway.

**One deliberate behaviour change:** `?embedded=1` on a tokened SSO-tool URL now
redirects like any other. That query param is a legacy frame-ancestors escape
hatch on the tokened path; the portal has used the `/admin/embed/*` HMAC tree for
every one of its iframes, and nothing in either repo still builds an
`?embedded=1` URL (grep, 2026-08-30 — only the middleware, two old docs, and the
gate test mention it). Exempting it would have made a magic query param a way to
keep a retired token URL alive. The HMAC tree is untouched.

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

*Update 2026-08-30:* `api-docs` also had no server-side token CHECK — it was a
`"use client"` page gated by the middleware alone, which is the case cited three
paragraphs up. Moving it to SSO split it into `ApiDocsClient.tsx` (the browser
half) plus `_tools/api-docs/AdminToolPage.tsx` and two route shells, and BOTH
shells now check a credential: the SSO route asks `requireSsoAdmin()`, the
`[token]` route compares `ADMIN_CAMERA_TOKEN` like every sibling board. That is
a hardening, not a port — it can only fire on a path the middleware already
admitted.

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

The device-adjacent surfaces are the **briefing wall tablet**
(`/admin/{token}/briefing`), the **pit board** (`/admin/{token}/pit`) and the
**trackside camera kiosks** (`/admin/{token}/camera-assign[/{track}]`) — tokened
admin URLs on screens nobody signs into daily. Those three are exactly the ones
that keep the token permanently, and the redirect lane skips all of them. See
unresolved #2.

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

**2. ~~The briefing wall tablet needs a credential that survives PR 2.~~
RESOLVED 2026-08-28 by owner decision — and the proposed fix was rejected.**
The original proposal was to point the tablet at the shell and hope an Auth.js
cookie outlived a reboot. It won't, and it shouldn't have to. `pit` and
`briefing` are now `DEVICE_TOKEN_TOOLS`: unattended displays that keep the token
URL **permanently**. Consequences PR B must not forget:

- PR B **must not** delete `app/admin/[token]/pit` or
  `app/admin/[token]/briefing`, and must not redirect them to an SSO route. The
  redirect lane deliberately skips both.
- PR B **must not** rotate `ADMIN_CAMERA_TOKEN` into uselessness for these two
  without a device plan first: a device-scoped credential the screens can hold
  (a long-TTL signed token in the display's bookmark), rotatable on its own
  schedule and killable without touching staff access. `camera-assign` needs the
  same treatment for the trackside kiosks, for a different reason — a human does
  work it, so it is not a device tool, but it is not a desk either.

**2b. So the rotation in PR B is NOT unconditional.** Three surfaces still
authenticate with the value being rotated. Rotating without giving them
something first takes down two wall boards and every trackside camera kiosk.

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

*Review addendum (2026-08-28, owner-side review): PR 2 as listed does NOT fully
close this. After step 2 a scraped token is useless for pages, and the rotation
kills every pre-cutover copy — but the ROTATED token is still serialised into
every board's RSC payload through the shell, and step 3 still accepts the static
token on `/api/admin/*` via `x-admin-token` for the nine crons. So any SSO
holder can scrape the current token from view-source and call mutation APIs
directly, outside the shell, for as long as they keep it — including after
their role is removed. Two fixes, pick one for PR 2: (a) give the crons their
own machine credential (`verifyCron` already exists; the `?token=` bypass can
become `CRON_SECRET`-only) and stop accepting the static token on `/api/admin/*`
altogether — then a scraped token opens nothing; or (b) the shell forwards to a
token-less segment (`/admin/board/<slug>`, proxy-key gated) so the secret never
reaches the RSC payload. (a) is the smaller diff and is recommended for PR 2;
(b) can follow.*

---

## PR B checklist (for when the go is given)

REVISED 2026-08-30. PR A got shorter and PR B got shorter with it. Steps 2–4 of
the original list are **done or moot**: the gate lives in `apps/web`, there is no
shell to authenticate by header, and the redirect lane already stops staff using
a tokened page URL for an SSO tool. What is left is deletion and rotation.

1. **Delete the `[token]` page routes for the 18 SSO tools.**
   `app/admin/[token]/<slug>/` for every slug in `SSO_ADMIN_TOOLS`, including
   `daily-events/[projectId]`. Keep `camera-assign` (+ `[track]`), `pit` and
   `briefing`. `admin-tools.test.ts` walks both trees, so it will hold the line
   in either direction. The redirect lane can then go too: with no v1 route to
   serve, `/admin/{token}/sales` is an ordinary 404. Delete the lane, its kill
   switch, and `ssoCleanPathForTokenPath` in the same commit — a redirect with
   nothing to redirect from is dead code that reads like policy.
   *Note the client components live under `[token]/<slug>/*Client.tsx` and are
   imported by `_tools/<slug>/AdminToolPage.tsx`. Move them to
   `_tools/<slug>/` (or `src/components/features/<slug>/`) BEFORE deleting the
   directory, or the build breaks in a way the drift test cannot see.*
2. **Retire `apps/admin` and the `tools-website-ft-admin` Vercel project.**
   The proxy shell has no job left: `admin.fasttraxent.com` points at this
   deployment and `middleware.ts` + `~/features/sso/tools` do what
   `apps/admin/src/routes.ts` did, in-process. Delete the workspace, drop its
   Vercel project, and remove `ADMIN_PROXY_KEY` from both sides — including the
   proxy-key branch in the unified gate, which is a page credential nothing
   holds any more. Re-point the domain first, verify, then delete.
3. **Move the crons off the static token.** The nine in §4 accept
   `?token=<ADMIN_CAMERA_TOKEN>` as a manual-run bypass beside `verifyCron`.
   Make that `CRON_SECRET`-only and stop accepting the static token on
   `/api/admin/*` altogether — this is option (a) of the audit addendum to #8,
   and it is what makes a scraped token open nothing. The three non-`/api/admin/*`
   routes in §4 (`square/bowling-refund`, `notifications/cancellation`,
   `bowling/v2/webhook-log`) need the same treatment or their own key.
4. **Give the three token-only surfaces a device credential.** — *unresolved #2*
   `pit`, `briefing` and `camera-assign` are the only things left that need
   `ADMIN_CAMERA_TOKEN` to be a page credential. Until they hold something else,
   step 5 cannot happen. A long-TTL signed token in each display's bookmark,
   rotatable on its own schedule, is the shape.
5. **Rotate `ADMIN_CAMERA_TOKEN`.** Only after 3 and 4. Set
   `ADMIN_API_SIGNING_SECRET` (new, random 32 bytes) FIRST so the signing key is
   independent of the rotated value and open boards do not all need a reload.
   — *unresolved #5*
6. **Delete the leftovers:** `app/api/admin-diag`, `lib/admin-auth.ts`, the
   commented-out `ADMIN_ALLOWED_IPS` block in `middleware.ts`,
   `ADMIN_ETICKETS_TOKEN` + its 308 shim and the three server-side aliases that
   read it (`e-tickets`, `sales`, `deposit-failures`). — *unresolved #1, #3, #4*
7. **Verify after rotation:** the nine crons in §4 on their next run (Vercel
   logs); the portal's five `/admin/embed/*` iframes and its `x-api-key`
   services; a VIP voucher QR and a TV player URL still resolve to
   `headpinz.com`; and the two wall boards plus every trackside camera kiosk
   still come up from a cold start.
