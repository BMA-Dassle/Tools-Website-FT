# Unified, mobile-first Waiver system

## Context

Waivers are scattered across the app with **no single system**. Today a guest can hit a waiver through
~15 entry points backed by **three different back-ends**:

1. `kiosk.bmileisure.com/{clientKey}` — global Nav/Footer "Waiver" links + event walk-in fallback.
2. `kiosk.sms-timing.com/{clientKey}/subscribe/event?id={projectReference}` — booking-confirmation banners,
   race-day email, group-function emails/SMS, contract "Complete Your Waivers" card.
3. Internal Pandora sign flow — `/event/{slug}`, `/event/{slug}/confirm`, and the in-center `/kiosk/waiver`.

The owner loves the in-center kiosk **"players section"** (a roster of person cards: add player, sign-in returning
racer, guardian/minor handling, sign waiver right there) and wants that same experience as a **mobile-friendly flow**
that everything funnels into — while keeping the direct links already present in emails/SMS (repointed at our own flow).

**Outcome:** one first-party `/waiver` route, driven by the players-section UX, that works both **standalone**
(a guest adds their family and signs — the #1 case is a parent signing for their kids at home) and **reservation-scoped**
(attach signed guests to a specific BMI reservation, like the existing kiosk group-waiver flow). Every touchpoint —
in-app CTAs, email links, group SMS, and site-wide Nav/Footer — is repointed at `/waiver`, phased and flag-gated.

**Shareable, confirmation-free waiver links (owner ask, 2026-07-22).** The reservation-scoped `/waiver` link is a
**standalone, forwardable link the organizer can send to their whole party without exposing the confirmation**. It shows
only lean **event/reservation info** (name/activity, date & time, center, and a "X of Y signed" count) plus the sign
form — **never** pricing, deposit, payment, contract terms, or other guests' PII. The `/waiver` page (and the organizer's
confirmation/contract) offer **Text it / Email it / Copy link / native Share** so anyone can distribute it onward; every
recipient's signature attaches to the same reservation. This applies to **both group events (contracts) and web
reservations (racing/attractions/bowling).**

## Owner decisions (2026-07-22)

- **Unify scope:** ALL surfaces funnel to `/waiver` — in-app CTAs, email links, group-function SMS, and Nav/Footer (both brands).
- **Minors:** Full family — a parent (participating or not) signs their own waiver, then each child's on the child's behalf.
- **Photo:** Match the kiosk — required for adults, optional for minors (mobile front camera).

## Branch & execution (owner, 2026-07-22)

- Work lands on a **new branch `feat/unified-waiver`, created fresh from `origin/main`** — it carries none of the
  in-flight `feat/duckpin-bowl-now-qr` WIP (one branch, one purpose). Built in a git worktree under
  `.claude/worktrees/` (owner picked worktree; the dirty main tree stays untouched).
- First commit on the branch = this plan file (`tasks/unified-waiver-plan.md`), then
  **proceed directly into PR0 and PR1** (attach extraction + guardian-signer chain).
- Follow the repo push/branch hygiene: never `git stash` here; branch off `origin/main`; keep the branch scoped to
  the waiver work only; `npm install` in the worktree (never junction node_modules).

## Grounding (confirmed by reading source, not inferred)

- **The players section is already extractable.** `apps/web/src/features/kiosk/components/KioskPartyManager.tsx` is the
  sanctioned, **prop-driven, session-agnostic** extraction with `mode: "race" | "attraction" | "waiver"` and callbacks
  (`onAddMember`/`onUpdateMember`/`onRemoveMember`/`onSetContact`/`onIncludedChange`). Its **only consumer is
  `KioskRacePackFlow`** — enhancing it is low-blast-radius (unlike the multi-writer-hot monolith `KioskPeopleStep.tsx`).
- **The one true gap:** `KioskPartyManager`'s waiver overlay signs a minor against the minor's **own** id with **no
  `signerPersonId`** (lines ~1053-1103) — legally the minor "self-signs." The full guardian two-waiver chain
  (guardian signs own → then minor's with `sigPersonID`) lives only in the monolith. This is the one behavior to port.
- **The signing component already supports guardians.** `apps/web/components/pandora/WaiverSigning.tsx` takes
  `signerPersonId` (short Pandora id of the guardian) and forwards it as `sigPersonID`; its own comment names
  "future express lane waiver" as an intended consumer. It's styled with neutral/mobile Tailwind (not kiosk `k-*`).
- **No server age change needed for minors.** The adults-only `422` gate lives ONLY in the join-session `submitGuest`
  path. The reservation attach `POST /api/kiosk/waiver/join` and the sign proxy `POST /api/pandora/waiver` have no age
  gate. The new flow bypasses `submitGuest` entirely, so minors work with zero server change.
- **Attach is persist-first and reusable.** `POST /api/kiosk/waiver/join` writes Neon `kiosk_waiver_joins` FIRST
  (`upsertJoin`), then optional BMI `registerProjectPersonServer` behind `KIOSK_WAIVER_BMI_ATTACH` (default ON).
  `GET /api/kiosk/waiver/roster` and `GET /api/kiosk/waiver/reservations` already exist and are center/brand-neutral.
- **Middleware facts (hard-rule area, read directly):** the legacy `/waiver`→`/` 301 is at
  `middleware.ts:413-414`; `isSharedTopLevelRoute` is a local const at `middleware.ts:535-593`; the `x-no-chrome`
  treatment for `/join` at lines 653-655 (HP host) and 664-667 (FT host) is the exact pattern `/waiver` must mirror.
- **Short-links exist:** `apps/web/lib/short-url.ts` (`shortenUrl`) + `app/s/[code]/page.tsx` — reused for email/SMS links.
- **Reusable pieces:** `pandoraOnboardGuest`/`pandoraFetchWaiverTemplate`/`pandoraSignWaiver`/`calculateWaiverExpiry`
  (`apps/web/lib/pandora.ts`), `ReturningRacerLookup` (OTP identity, `wide`/`introText`/`onVerifiedMultiple`),
  `NewGuestForm`, `newPartyMember`/`PartyMember` (`apps/web/src/features/booking`), `logWaiverAcceptance`
  (`apps/web/lib/waiver-acceptance.ts`), `KioskWaiverPhoto` (`apps/web/src/features/kiosk/components/`).

## Approach

Promote `KioskPartyManager` into the **shared `WaiverParty` core** consumed by both the kiosk and the new mobile route.
Do **not** touch the monolith `KioskPeopleStep`. Every enhancement is behind an opt-in prop that preserves the current
`KioskRacePackFlow` behavior byte-for-byte.

### 1. Enhance the shared core — `apps/web/src/features/kiosk/components/KioskPartyManager.tsx`
- **Guardian signer chain** (behind new prop `guardianSigning?: boolean`, default `false`): extend `waiverFor` to carry
  an optional `signerPersonId`; when signing a minor, resolve the guardian's short Pandora id (upsert-resolve via
  `pandoraOnboardGuest` as the monolith does) and pass it to `WaiverSigning`. If the guardian's own waiver is lapsed,
  sign the guardian's first, then chain to the minor's. Port the essential logic from `KioskPeopleStep.tsx` (read-only
  reference). In `mode:"waiver"` a "parent not playing" is simply an adult roster member who signs their own waiver —
  no separate `guardians` array needed (waiver mode has no billing/participation split).
- **Themeable chrome** (new prop `theme: "kiosk" | "mobile"`, default `"kiosk"`): move the hardcoded kiosk arbitrary
  sizes (`text-[40px]`, `py-[28px]`, `k-*` classes) into a co-located `waiver-party.css` scoped by a root theme class,
  so `theme:"mobile"` renders phone-appropriate sizing with the **identical JSX structure**. Kiosk output stays identical.
- **Decouple from `KioskConfigContext`:** accept `hasCamera: boolean` and `photoStep: "required-adults" | "optional" | "off"`
  as props instead of reading `useKioskConfig()`. Kiosk consumers pass `kioskHasCamera(cfg)`; mobile passes `hasCamera:true`,
  `photoStep:"required-adults"`.
- Re-export from the new feature: `apps/web/src/features/waiver/index.ts` → `export { KioskPartyManager as WaiverParty }`.

### 2. New route + orchestrator
- **`apps/web/app/waiver/page.tsx`** (server, `dynamic="force-dynamic"`, `robots:noindex`): read `x-brand` header +
  query params, verify a reservation token if present, render `<WaiverFlow/>`.
- **`apps/web/src/features/waiver/WaiverFlow.tsx`** (client orchestrator, mobile chrome modeled on `JoinPhoneFlow` —
  `max-w-md`, `--accent`, own brand header, no site Nav/Footer, no `IdleWatcher`). Owns a lean local
  **`waiver-party-reducer.ts`** (`party: PartyMember[]` + add/update/remove) — reuses the `PartyMember` type, not the whole
  `BookingSession`. Mounts `WaiverParty` with `theme:"mobile"` + `guardianSigning`. Two modes:
  - **Standalone** `/waiver?c={center}` — brand from host; HeadPinz host with no `c` shows a FM/Naples center chooser.
    Pandora location via existing `brandLocationFor`. Attach = `standaloneAttach`.
  - **Reservation-scoped** `/waiver?c=&loc=&pid=&ref=&src=` — render the **event-info header** (see §2b), skip the picker,
    `GET /roster`, attach = `reservationJoinAttach`. For email/SMS the full URL is wrapped in a `/s/{code}` short-link
    (via `shortenUrl`); in-app links use plain params. When `loc` is ambiguous (FM group-function knows only
    `center_code`), resolve it by probing both `CENTER_TO_BMI_LOCATION_IDS[c]` (reuse the dual-location logic in
    `reservations/route.ts`).

### 2b. Shareable, confirmation-free waiver link + event-info header
- **Event-info header** at the top of the reservation-scoped `/waiver` page: reservation/event name, activity, date &
  time, center display name, and a live "X of Y signed" count. Sourced from a lightweight **waiver-context** fetch —
  reuse `getReservationDetail(locationId, projectId)` (`src/features/daily-events/service.ts`) + the existing
  `GET /api/kiosk/waiver/roster` counts, exposing **only non-sensitive summary fields** via a small
  `GET /api/waiver/context?c=&loc=&pid=` route (name/activity/date/center/counts — deliberately NO pricing, deposit,
  payment, line items, or other guests' PII). This is what makes the link safe to forward.
- **Share affordances** — a "Share the waiver with your group" block on the `/waiver` page AND on the organizer's
  confirmation banner / contract card: **Text it** (`sms:?&body=`), **Email it** (`mailto:?subject=&body=`),
  **Copy link**, and **native Share** (`navigator.share`, with graceful fallback). All share the `/s/{code}` short-link
  so it is short and forwardable; each recipient's signature attaches to the same reservation.
- Applies to **both** group events (contracts) and web reservations — the same reservation-scoped mechanism; only the
  context source differs (contract row vs booking project), both funneling through `buildWaiverUrl` + the context route.

### 3. Attach abstraction — `apps/web/src/features/waiver/attach/`
- `types.ts` — `WaiverAttach { onMemberReady(m): Promise<void> }` called whenever a member reaches `personId && waiverValid`.
- `reservation-join.ts` — `reservationJoinAttach(...)` **lifted verbatim** from `KioskWaiverFlow`'s inline effect →
  `POST /api/kiosk/waiver/join` per member (dedup via `postedRef`). Shared by kiosk + mobile.
- `standalone.ts` — `standaloneAttach(...)` → new `POST /api/waiver/record`.
- **Every** successful sign (both modes) also logs an E-SIGN audit row via `/api/waiver/record` → `logWaiverAcceptance`
  (person_id, name, terms_version, ip, ua, method:"signature") — satisfies the persist-first / audit rule that the
  interactive Pandora sign path lacks today.

### 4. Mobile photo — `apps/web/src/features/waiver/MobileWaiverPhoto.tsx`
Front-camera capture (`getUserMedia({video:{facingMode:"user"}})`, `<input capture="user">` fallback) →
`POST /api/pandora/person-picture` (existing persist-first upload). Required for adults, optional for minors (owner choice).

### 5. Canonical link builder — `apps/web/lib/waiver-url.ts` (NEW, pure/isomorphic)
- `buildWaiverUrl({ center, surface, projectId?, locationId?, projectReference?, absolute?, brandHost? })` → the new
  `/waiver?c=&loc=&pid=&ref=&src=` string, OR (when the surface flag is off / kill-switch set) the exact legacy vendor
  URL. Becomes the **single source of truth** for the `clientKey` map, replacing the four inlined copies
  (`group-event-rules.ts:76`, `event-details/route.ts:120`, `group-function-notify.ts`, and the confirmation-page inlines).
- `waiverFirstPartyEnabled(surface)` — per-surface flag: client surfaces read a build-baked `NEXT_PUBLIC_*` var,
  server surfaces read a runtime var (instant rollback), plus a master `WAIVER_FIRSTPARTY_KILL`.

### 6. Middleware — `apps/web/middleware.ts` (edited in the SAME commit that adds the page — hard rule)
- Remove only `"/waiver": "/"` and `"/waiver/": "/"` from `legacyRedirects` (lines 413-414); keep `/waiver-2`.
- Add to `isSharedTopLevelRoute`: `pathname === "/waiver" || pathname.startsWith("/waiver/")`.
- Add `x-no-chrome` for `/waiver` in both the HP-host shared block (~653) and the FT-host block (~664), mirroring `/join`.
- `/waiver-3` (the existing static legal page) is unaffected — it matches neither condition.

### 7. Additions for a fully functional system (gap analysis)

**Must-have — correctness, compliance, and the actual ROI:**
- **One canonical "requires a waiver" definition.** Today four divergent lists disagree — `WAIVER_SLUGS`
  (`KioskPeopleStep`), `WAIVER_ACTIVITIES` (`lib/bmi-office-actions.ts`), `WAIVER_GATED`
  (`api/group-event/confirm`), `WAIVER_RESOURCE_KEYWORDS` (`daily-events/constants.ts`). Consolidate into one
  `apps/web/src/features/waiver/requires-waiver.ts` (`activityRequiresWaiver(...)` + the keyword/slug sets) and have all
  four call sites import it. Removes the shuffly/duckpin inconsistencies.
- **Signature persist-first to Neon (HARD RULE).** A signature is guest data we send to Pandora, so it must hit Neon at
  capture, not gated on the API. Add a `waiver_signatures` capture (person_id, subject/guardian ids, waiver contentID,
  terms_version, signature blob or hash, ip/ua, ts, `pandora_status: pending|synced|failed`) written **before** the
  Pandora sign, with a retry sweep — mirror the existing `kiosk_person_photos` persist-first queue + sweep. `WaiverSigning`
  (new flow) writes local first, then signs Pandora; a cron reconciles `pending`/`failed`.
- **Express-lane loop closure.** Make the confirmation/check-in banner key on **live waiver validity** (Pandora
  `waiverExpiry > now`), not just `isNewRacer`, so a guest who pre-signs via `/waiver` is no longer nagged and drops
  straight into Express Lane. Verify `app/book/confirmation/{page,v2/page}.tsx` gating.
- **Guardian attestation in the audit.** Extend `waiver_acceptances` (and the new `waiver_signatures`) with
  `signed_by_person_id` + `subject_person_id` + `relationship` so a minor's waiver records who signed on their behalf —
  the legal record for the whole-family feature.
- **Already-signed status UX.** When a guest opens the link and their waiver is valid, show "You're all set through
  {expiry}" (not a re-sign). Reuse the live `pandoraCheckWaiver` the players section already runs.
- **Public-endpoint safety.** The link is forwardable and `/api/waiver/*` + `/api/pandora/waiver` are public — add per-IP
  rate limiting (reuse `rateLimited` from `src/features/kiosk/join/store.ts`) and **expire the reservation token after the
  event date** with a graceful "this event has already happened" screen.

**Should-have — completeness:**
- **Signer receipt + retrieval.** Optional "email/text me a copy" after signing (reuse the notification senders), and a
  status lookup so a guest can re-open the link and see they've signed.
- **Analytics funnel.** Emit `waiver:viewed|started|signed|shared` (tagged with `src`) via the existing Clarity/event
  plumbing, so we can measure open→sign conversion per surface.
- **Organizer "who still needs to sign" view.** Surface the roster's signed/unsigned split to the organizer on the
  confirmation/contract, and wire it into the existing `group-7day-waiver` / 2-day reminder crons.
- **Fallbacks.** Typed-name signature fallback if the canvas is unavailable (the digital-accept path already renders a
  "Digitally Accepted" record); photo file-upload fallback if the camera is blocked.

**Later — collapse to truly one system:** migrate the remaining internal flows (`/event/[slug]` interactive sign and the
`/event/[slug]/confirm` checkbox acceptance) onto `/waiver`, so every waiver in the app is the same flow.

## Per-touchpoint rewiring (all via `buildWaiverUrl`, flipped in flip-order)

| Touchpoint | File | Reservation-scoped? |
| --- | --- | --- |
| FT + HP Nav "Waiver" | `components/Nav.tsx`, `components/headpinz/Nav.tsx` | No (standalone) |
| FT + HP Footer "Waiver" | `components/Footer.tsx`, `components/headpinz/Footer.tsx` | No |
| Event walk-in fallback | `app/event/[slug]/confirm/ConfirmClient.tsx` | No |
| Confirmation banners (v1/v2/attraction/hp-bowling) | `app/book/confirmation/{page,v2/page}.tsx`, `app/book/[attraction]/confirmation`, `app/hp/book/bowlingold/confirmation/page.tsx` | Yes |
| Contract "Complete Your Waivers" card | `app/contract/[shortId]/ContractClient.tsx` + `api/group-function/event-details/route.ts` | Yes |
| Race-day email | `api/notifications/race-day-instructions/route.ts` + cron `race-day-emails` | Yes (short-linked) |
| Group-function emails **+ SMS** | `lib/group-function-notify.ts`, `lib/group-event-rules.ts` + crons | Yes (short-linked) |
| Booking-confirmation email | `api/notifications/booking-confirmation/route.ts` + `emails/booking-confirmation-waiver.html` | Yes (short-linked) |

Booking-confirmation **SMS** stays as-is (no waiver link — it points to the confirmation page, whose banner is now `/waiver`).

The confirmation banner and contract "Complete Your Waivers" card become **"Sign & share the waiver"** — the organizer's
CTA opens the reservation-scoped `/waiver` (with the event-info header) and exposes the Text/Email/Copy/Share block so
they can forward the confirmation-free link to their whole party.

## PR sequence (one purpose each; flag-gated; v2-alongside-v1)

- **PR0 — refactor, no behavior.** Extract `KioskWaiverFlow`'s inline attach effect → `src/features/waiver/attach/reservation-join.ts`; `KioskWaiverFlow` imports it.
- **PR0b — canonical requires-waiver.** Add `src/features/waiver/requires-waiver.ts`; point all four existing lists at it. Pure consolidation + tests; no behavior change.
- **PR1 — guardian chain in the core.** Port `signerPersonId` chain into `KioskPartyManager` behind `guardianSigning` (default off). Unit tests for `peopleReady` + guardian resolution. Dormant (no route yet).
- **PR2 — themeable chrome.** `theme` + `hasCamera`/`photoStep` props; decouple `KioskConfigContext`; kiosk sizes → theme-scoped CSS. Kiosk output identical.
- **PR3 — `/waiver` standalone + persist-first + audit.** Route + `WaiverFlow` + reducer + `standaloneAttach` +
  `POST /api/waiver/record` + `MobileWaiverPhoto` + **middleware edits** (same commit). Includes the **`waiver_signatures`
  persist-first capture + retry sweep cron**, the **guardian/subject audit columns**, the **already-signed status UX**, and
  a **typed-name signature fallback**. Flag `NEXT_PUBLIC_WAIVER_FLOW_ENABLED` default OFF; reachable by typed URL for QA.
- **PR4 — `/waiver` reservation-scoped + shareable link.** Token (+ **event-date expiry**) + short-link, roster,
  `reservationJoinAttach`, the **event-info header** + `GET /api/waiver/context` (non-sensitive summary), the
  **Text/Email/Copy/native-Share** block, and **per-IP rate limiting** on the public endpoints. Works for both contracts
  and web reservations.
- **PR5 — express-lane loop closure.** Re-gate the confirmation/check-in banners on live waiver validity, not just
  `isNewRacer`, so pre-signed guests aren't re-nagged. Small, targeted, independently valuable.
- **PR6 — builder, flag off.** Add `lib/waiver-url.ts`; route all inlined URL sites through it. Output byte-identical (pure dedup).
- **PR7..N — flip surfaces one at a time** (lowest risk first): Footer → Nav → event walk-in → in-app banners + contract card → race-day email → group-function email+SMS → booking-confirmation email. Each = an env allowlist change (client surfaces also need a redeploy); rollback = drop the surface or `WAIVER_FIRSTPARTY_KILL=1`.
- **PR (should-have) — receipt + analytics + organizer view.** Signer email/SMS copy & status lookup; `waiver:*` funnel
  events; organizer signed/unsigned view wired into the 7-day/2-day reminder crons.
- **PR (optional) — unify kiosk.** Migrate `KioskWaiverFlow` to mount the shared `WaiverParty` (`theme:"kiosk"`), collapsing the last duplication.
- **PR (later) — collapse remaining flows.** Migrate `/event/[slug]` sign + `/event/[slug]/confirm` checkbox onto `/waiver`.
- **PR (final) — delete v1.** Remove legacy vendor-URL branches from the builder after ops sign-off; audit `next.config.ts` image remote patterns.

## Verification

- **Per PR (before push):** `npm run -w fasttrax-web typecheck` (or `npx tsc`), eslint incl. `react-hooks` and the
  a11y-gate (`node scripts/a11y-gate.mjs`), and the relevant unit tests (`peopleReady`/guardian resolution, `waiver-url`
  builder, attach dedup). One `npx turbo run build` at the end, asserting the exit code (never trust a piped build).
- **Kiosk regression (PR1/PR2):** confirm `KioskRacePackFlow` and the in-center `/kiosk/waiver` are visually + behaviorally
  unchanged (defaults preserve current output).
- **Standalone mobile smoke (PR3):** on a phone, open `/waiver?c=fort-myers` → add a new adult (photo required → sign) →
  add a child (pick parent guardian → parent signs child's waiver) → verify in Pandora that the adult signed self and the
  minor's waiver carries the guardian as `sigPersonID`, and that a `waiver_acceptances` row was written for each. Repeat on
  the HeadPinz host (center chooser → Naples).
- **Reservation-scoped smoke (PR4):** mint a `/waiver?c=&loc=&pid=` for a real today reservation → sign a guest → confirm a
  `kiosk_waiver_joins` row (persist-first) and the BMI project-person attach, and that the roster reflects it. Verify the
  event-info header shows the right summary and **no** pricing/deposit/PII, and that Text/Email/Copy/Share produce a
  forwardable `/s/{code}` link a second device can open and sign against the same reservation ("X of Y signed" increments).
- **Link cutover (PR6):** for each flipped surface, confirm the emitted URL resolves (short-link → `/waiver`) on BOTH brand
  hosts, that `/waiver` no longer 301s to home on headpinz.com, and that flipping the flag off instantly restores the legacy
  vendor URL. Send one real end-to-end confirmation email/SMS before declaring a surface done.
