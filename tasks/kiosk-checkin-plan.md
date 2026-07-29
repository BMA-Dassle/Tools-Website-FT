# Kiosk Check-In Experience — Design (2026-07-20, verified + decisions locked)

> Owner ask: guests with an existing reservation check in at the kiosk — see their
> confirmation as a "what's next" itinerary (multi-attraction), add new + existing players
> (kiosk people flow), sign missing waivers, assign purchased races/products to them, attach
> them to the reservation in BOTH BMI and QAMF, open bowling lanes, check in the whole party
> at once, and mark the BMI reservation so staff know it's ready and good to go.
>
> Grounding: 8-subsystem code research + 4-lens adversarial verification (2026-07-20).
> Execution breakdown lives in the plan file `ticklish-snacking-twilight.md`.

## Owner decisions (locked 2026-07-20)

1. **BMI mark = built-in -5 "Arrived"** — no new custom state, no BMI Office setup. Built-in
   negative states go Pandora-first in `setProjectState` (the proven -3 path).
2. **Browse list ships in v1 with OTP** — PII-lean rows, ±3h window, all reservation kinds;
   tapping texts a code to the booking contact (masked, rate-limited).
3. **Party grew → NEW BOOKING** — the kiosk offers "Someone not on this booking? Start a new
   booking" → normal sales flow. Never modify the existing reservation. VIP experiences →
   front desk.
4. **No money at the kiosk during check-in** — `dueAtCenterCents > 0` shows a display-only
   "due at the front desk" banner; nothing is charged.

## 0. The core insight

Online bookings usually capture only **one identified person** (the booker). The rest of the
party is paid for but anonymous — `raceHeatsMetadata` writes `bmiPersonId: null` per heat,
web names-only racers never get a personId, bowling lanes carry "Bowler N" placeholders,
attraction participants go uncollected. **Check-in is roster completion, not a new sale.**
The kiosk identifies the humans, collects waivers, binds them to purchased slots, syncs both
vendors, and flips the reservation to Arrived.

| Need                                      | Existing primitive                                                                                |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Standalone kiosk flow shell               | `/kiosk/waiver` → `KioskWaiverFlow`                                                               |
| Add people + waivers                      | `KioskAttractionPeopleStep.Component` StepDef (never fork)                                        |
| Party signs on phones                     | Mobile join + new `checkin` stepKind                                                              |
| Attach person to existing BMI reservation | `registerProjectPersonServer` (gate `KIOSK_WAIVER_BMI_ATTACH`)                                    |
| Racer on the timing grid                  | Pandora `POST /bmi/schedule` (`kiosk-post-reserve.ts:341-453`)                                    |
| Bill-line personId can stay null          | verified: no post-booking path reads it                                                           |
| Bowling names/shoes                       | players PATCH route + `syncQamfPlayers` (compose both)                                            |
| Open the lane                             | `GET/POST /api/bowling/v2/reservations/{id}/checkin`                                              |
| Mark reservation                          | `setProjectState` → **-5 Arrived** (built-in)                                                     |
| "What's next" model                       | v2 confirmation activity enumeration (extract)                                                    |
| Lookup                                    | `/s` deref, Office `search?token=W#`, phone → `getReservationsByContact` + booking-record indexes |

## 1–4, 6–7 — see the execution plan file for full screen, pipeline, and edge-case detail.

## 5. Marking the reservation — built-in -5 "Arrived" (locked)

No new BMI Office state to create. The pipeline calls
`setProjectState({ officeProjectId, stateId: "-5" })` — a built-in negative state, so it goes
Pandora-first (the proven -3 path); no Office custom-state provisioning, no env var.
Add verify-by-reread + Office-PUT escalation (200-and-no-op pathology is documented for
converted racing reservations). Record `bmi_state_status` on the Neon event row. Resadmin /
grid badging, if wanted, reads our own `kiosk_checkin_events` — cheaper than polling BMI.

⚠ Precision audit: `setProjectState`/`appendProjectPrivateNote` plain-`JSON.parse` the Office
project GET on their read-modify-write path. They work live today; before check-in multiplies
these writes, capture a raw Office GET body and verify id encoding, or convert both helpers to
`parseWithRawIds`/`serializeWithRawIds`.

## 7. Party grew → new booking (locked)

Extra people beyond what's purchased are NOT added to the existing reservation. The assign
screen shows "Someone not on this booking? **Start a new booking**" →
`router.push('/kiosk/flow?goto=<kind>')` (the normal kiosk sales flow, its own reservation +
payment). VIP experiences → "see the front desk". No edit-engine / paid-add integration in
this feature at all.

Other v1 exclusions: no money collected at the kiosk (balance shows as display-only "due at
the front desk"); group/daily-events waivers keep using `/kiosk/waiver`.

## 8. Rollout — dark PRs (refined during build)

- **PR1 (shipped)** — read-only lookup + itinerary (+ server-side `bookingrecord:code`/`res`
  reverse indexes at reserve time). Flag OFF; staff smoke by typed URL.
- **PR2 (this branch, feat/kiosk-checkin-2-party)** — PARTY COMPLETION + BMI ATTACH. The
  itinerary screen mounts the people monolith (`KioskAttractionPeopleStep.Component`) over a
  local reducer — add / returning lookup / minor+guardian / waiver signature + the
  mobile-join QR + merge, all writing into `session.party` (the exact KioskWaiverFlow
  pattern). An "Add my group to my reservation" button POSTs the ready members
  (`bmiPersonId` && `waiverValid`) to a proof-gated `join` route that persists to Neon
  (`kiosk_checkin_events`/`_people`) FIRST, then attaches each as a BMI projectPerson via the
  proven `registerProjectPersonServer` behind **KIOSK_WAIVER_BMI_ATTACH** (billId as the
  public-booking `orderId`, matching bmi-sync's late-add). Scope stops at attach (roster +
  waiver %). **Dedicated `checkin` mobile-join stepKind SKIPPED** — the monolith's built-in
  QR rides `attraction` stepKind; a distinct kind would require editing the multi-writer
  monolith to pass it, for only marginally better phone copy (documented follow-up).
  Launch gate shared with group waiver: **A3 attach probe**.
- **PR3 (this branch, feat/kiosk-checkin-3-complete)** — the "check in everyone" FINALIZE.
  One button binds any newly-added party (PR2) then POSTs `/api/kiosk/checkin/complete`:
  Redis single-flight lock per billId → open/reuse the event (idempotent; `alreadyComplete`
  short-circuit) → assign added people to open heat slots (`booking_metadata.heats` rows with
  `bmiPersonId` null, earliest-first; auto-assign — a per-person tap-to-assign picker is
  PR4) → `scheduleCheckinRacers` (new `schedule-racers.ts`, adapted from kiosk-post-reserve:
  SHORT ids, per-racer results + 10s/20s re-POST + incomplete-memo, FastTrax-only, no 8s
  delay) → **-5 "Arrived"** via `setProjectState` (racing → "fasttrax" Pandora location) →
  ONE composed staff memo → mark event complete → stamp `kioskCheckinAt` on the booking
  record. Done screen: what's-next + a bowling lane-open panel (lifts KioskConfirmation's
  poll+POST). **All external writes (schedule/-5/memo/interactive lane-open) gated behind
  `KIOSK_CHECKIN_BMI_ATTACH` (default OFF)** — dark-safe: staff typed-URL testing fires no
  schedule/state/lane/KDS write, only the local event + record stamps.
- **PR4 (hardening, not yet built)** — per-person tap-to-assign heat picker; bowling
  names/shoes roster grid + `syncQamfPlayers` compose (the people monolith is waiver-only);
  write `bmiPersonId` back to `booking_metadata.heats` (spacing-guard truth); `-5`
  verify-by-reread; schedule-status sweep cron over `kiosk_checkin_people`; the
  checked-in-but-lane-never-opened settle path in `bowling-no-show-close`.
- Then A3 attach probe + `-5` state-stamp probe on a converted racing reservation → owner
  live smoke → flip `KIOSK_CHECKIN_BMI_ATTACH=1` then `NEXT_PUBLIC_KIOSK_CHECKIN_ENABLED` →
  watch `kiosk_checkin_people` statuses.

  ⚠ **Owner decision to confirm before enabling (`-5` consequence):** stamping the BMI project
  `-5 "Arrived"` at kiosk check-in makes `race-dayof-pay` treat the guest as arrived and settle
  the day-of order immediately (gift-card-funded — no NEW card charge, but the order
  settles/completes at check-in, potentially 30+ min before the race, bypassing the
  `raceSettleGate` track-truth wait). This is the normal arrival→settle path (the gate only
  defers when arrival is unknown), but it's a real behavioral consequence of the locked `-5`
  choice — confirm early settlement is acceptable, or pick a non-arrival state that only flags
  "ready" without triggering settle.

## 9. Launch gates (in order)

1. **A3 probe** (`kiosk-waiver-attach-probe.mts`, throwaway CONFIRMED reservation) — gates
   all BMI attach writes (shared with group waiver).
2. **Schedule-bind probe** (load-bearing): register a person on an existing confirmed
   reservation whose bill line has personId NULL → schedule POST → `results: inserted` → the
   racer actually shows on the BMI grid; measure register→insertable latency to size the sweep.
3. **-5 state probe**: flip a throwaway project to -5 via the pipeline → reread shows Arrived;
   repeat on a CONVERTED racing reservation (200-and-no-op risk); confirm no unexpected
   BMI-side automation reacts to -5.
4. **QAMF multi-lane rename smoke**: real 2-lane reservation → names/shoes at kiosk →
   Conqueror shows names on BOTH lanes, Title "(Np)" intact → lane-open → KDS ticket carries
   lane + shoe sizes.
5. **Owner live smoke**: web booking (1 identified racer, party of 3, race+bowl) → kiosk:
   phone-OTP find → browse-OTP find → add 2 people (one by phone QR, one at kiosk incl.
   minor+guardian) → assign heats + bowling names → check in all → Office shows -5 + memo,
   grid shows all racers, lane prompt works, no dup persons, no -101 regression, double-tap
   /complete = one event + one memo.

## 10. Open questions (remaining after 2026-07-20 decisions)

1. **Checked-in-but-lane-never-opened**: the `checkin_method` stamp removes a bowling row
   from no-show close — confirm the settle rule (charge like a no-show at 3AM without firing
   food, or leave for staff?). Recommend: settle without fulfillment, coordinated with the
   pending day-of-OPEN-recurrence root fix.
2. Should the -5 flip also ping staff radios for large parties (assist rail exists), or is the
   Office state + memo enough?

_(Answered 2026-07-20: BMI mark = -5 Arrived · browse list = yes, with OTP · party grew =
new booking · no money at kiosk.)_

_(Superseded 2026-07-24 — see §11: BMI mark changed from -5 Arrived → "Confirmation Kiosk"
custom state, which also RESOLVES the §8/§5 -5 early-settle consequence.)_

## 11. PR4 — Express lane + who-is-who race assignment (owner decisions 2026-07-24)

Three owner answers, all confirmed against current code before writing this section.

### A. Express lane = informational modal (client-only, no eligibility logic) — ❌ SUPERSEDED 2026-07-28

**This section shipped and was WRONG. See "A-revised" below. Do not re-implement it.**

Owner: "If they click express lane just have a modal showing what express lane is and that
they don't need to sign in here."

- On the FIND screen / today's-reservation list (`KioskCheckinFlow` FindScreen + browse rows),
  add an **"Express lane?"** affordance. Tapping opens a **modal only** — no reservation
  lookup, no waiver check, no server call:
  > **Express Lane** — Returning racers whose waivers are already signed can skip check-in.
  > **Head straight to Karting Check-In (1st floor)** — no need to sign in here.
- Deliberately NOT gated on real express eligibility. The browse list is PII-lean and does no
  Pandora waiver check ([server.ts:460](../apps/web/src/features/kiosk/checkin/server.ts)), and
  computing `fastLane`-per-row would be leaky + slow. Purely informational, matching the
  existing web `fastLane` express-lane copy ("skip Guest Services, go directly to Karting
  Check-In"). No `express` field added to the itinerary envelope; no server change for Part A.
- Lowest risk in the feature — client-only, reads nothing, mutates nothing.

### A-revised. Express lane = per-reservation eligibility, and express NEVER checks in (2026-07-28)

Owner, on seeing the live list: _"Reservations showing everyone as express lane? Also I've said
several times express lane doesn't need to check in on kiosk and it shouldn't send an OTP. It
should just pop a message saying what to do. Tammy reservation is not but is showing express lane?"_

The "purely informational, deliberately not gated" call above was a mistake on two counts:

1. **It badged every racing row.** The pill rendered on `r.kind === "racing"`, so a guest who
   genuinely had to check in was told to skip it. Measured on live FM data for 2026-07-28:
   **8 of 25** racing reservations (32%) — including the flagged Tammy N. 6:00 PM — were
   mislabelled express (`apps/web/scripts/kiosk-express-badge-check.mts`).
2. **"Informational" isn't enough.** An express party must not be OTP'd or walked through
   check-in at all. Tapping an express row now REPLACES check-in with the message.

Implemented:

- **`express: boolean` on `CheckinBrowseRow` + `CheckinItinerary`.** Two pure predicates in
  [checkin/express.ts](../apps/web/src/features/kiosk/checkin/express.ts), unit-tested:
  - `isExpressBooking` — browse list. Reads the `fastLane` flag checkout already wrote to
    `bookingrecord:{billId}`, so it costs ONE Redis GET per row, issued in the same
    `Promise.all` as the existing ref mint → no added round trip, no per-row Pandora call, no
    waiver status leaked into the unauthenticated list. The "leaky + slow" objection above was
    only ever true of the live-waiver approach.
  - `isExpressRoster` — itinerary. Uses the per-racer Pandora waiver read `buildItinerary`
    already performs, so it also catches a waiver that lapsed since booking.
  - Both enforce the 2026-06-13 whole-party lesson: any racer with no `personId` disqualifies.
  - Both hard-gate on **racing-only**: a combo still needs its bowling lane opened, so it is
    never express.
- **Express row → modal, full stop.** No last-4 gate, no OTP, no itinerary. The badge is now a
  decorative `<span>` (the whole card is the single tap target), which also removed the
  nested-button / `pointer-events` overlay hack.
- **Express itinerary → the same message instead of "Continue ›"**, so the phone-lookup and
  scanned-QR paths (where the code is already spent) end the same way.
- **Destination copy fixed** to "Race Check-In — 1st floor, left of the Red Track" (was "the
  pits"), matching the eTicket, the race-day email and `RacingWhatsNext`. One
  `ExpressLaneBody` component feeds both surfaces so they can't drift.
- **Fully localized EN + ES** per the kiosk i18n hard rule. The old body was left English with a
  `TODO(i18n)` because its inline `<strong>` spans made it rich text the plain-string engine
  can't render; splitting it into three WHOLE sentences + one standalone place name
  (`checkin.express.bodyNothing` / `bodyWhere` / `bodyPlace` / `bodyWhen`) makes every key a
  complete translatable unit with emphasis wrapping a whole key — so the TODO is now discharged
  rather than inherited.
- No find-screen affordance was added: an express guest taps "Find my booking", sees their own
  badged row, and taps it.

### B. State change = "Confirmation Kiosk" custom state (NOT -5 Arrived)

Owner: "Change to confirmation kiosk." This SUPERSEDES §5 and the §8 locked -5 decision.

- `completeCheckin` ([server.ts:1009](../apps/web/src/features/kiosk/checkin/server.ts)) stops
  stamping `stateId:"-5"` and instead uses **`KIOSK_CONFIRMATION_STATE_IDS[stateCenterCode]`**
  ([bmi-office-actions.ts:174](../apps/web/lib/bmi-office-actions.ts) — FM/fasttrax `55397028`,
  Naples `8489113`), the SAME per-location custom state the kiosk post-reserve rail and
  express-lane web bookings already land in.
- **Why this is better, not just different:** the custom state is NOT an arrival state, so it
  does **not** trigger `race-dayof-pay` to settle the day-of order at check-in. That was the
  §8 ⚠ M4 open blocker for enabling `-5`; changing to Confirmation Kiosk **removes it entirely**
  — no early-settle, and staff already work bookings from this exact state.
- Implementation note (already handled by `setProjectState`): a custom id (no leading `-`) is
  `isCustomState`, so it goes **Office-API-first** — Pandora returns 200 but silently no-ops
  custom states (documented W52109 pathology). The verify-by-reread + Office-PUT escalation the
  PR4 hardening list already calls for is what makes this land reliably.
- Launch gate §9.3 changes: "-5 state probe" → **"Confirmation Kiosk state probe"** — flip a
  throwaway FM racing project to `55397028` via the pipeline, reread shows the custom state
  (guard the 200-and-no-op path), confirm no unexpected automation reacts. The `-5`-specific
  early-settle sub-check is dropped (no longer applicable).

### C. Who-is-who assignment = guest action at the kiosk

Owner: "guest action." Replaces the PR3 index-order auto-assign
([server.ts:942-1005](../apps/web/src/features/kiosk/checkin/server.ts)) — which fills
`openSlots[i]` by list order with **no class matching** (a junior can land in an adult slot).

- **Itinerary envelope** gains the purchased race slots: per slot
  `{ slotKey, productId, classLabel ("Starter Junior"), tier, category, track, timeLabel,
occupantName | null, open }` — derived from `booking_metadata.heats` + `getRaceProductById`.
- **New "Who's racing?" screen** (racing only, before "Check everyone in"): one card per
  purchased slot. Guest taps an identified + waiver-valid party member (from `session.party`)
  into each OPEN slot. **Category correctness enforced**: a `junior` slot accepts only a
  junior-age member and vice-versa (age known from the minor/guardian + DOB the people monolith
  already captures) — inline block on mismatch. Already-filled slots show the occupant locked
  (reassign is out of scope unless owner wants it). Surplus people (party > slots) are shown as
  "not racing — Start a new booking" (the §7 locked path), never silently index-dropped.
- **`completeCheckin`** consumes the explicit person→slot map instead of `openSlots[i]`, builds
  `ScheduleRacer[]` from each slot's real product, calls the existing `scheduleCheckinRacers`
  (Pandora `POST /bmi/schedule`), then stamps **Confirmation Kiosk** (Part B) + the memo. Fold
  in the PR4 item **write `bmiPersonId` back to `booking_metadata.heats`** so the assignment is
  durable (spacing-guard truth) and re-entry shows slots filled.
- Persistence: extend `kiosk_checkin_people` with the assigned `slot_key`/`product_id` (persist
  the map to Neon FIRST, house rule, before the Pandora write).

### Proposed staging (Part 4 scope — OWNER TO CONFIRM)

- **PR4a — express-lane modal** (Part A): client-only, zero risk, ship immediately, no probe.
- **PR4b — assignment + Confirmation Kiosk state** (Parts B+C): mutating, still dark behind
  `KIOSK_CHECKIN_BMI_ATTACH`. Gates: A3 attach probe, schedule-bind probe, the new Confirmation
  Kiosk state probe, owner live smoke. The M4 early-settle gate is now GONE (Part B).

## 12. Bug batch (owner smoke, 2026-07-25) — all fixed same day

Four live-testing bugs, root causes confirmed in code before fixing:

1. **QR scan found nothing.** The kiosk QR reader is a SERIAL (COM-port) device
   (`useQrScanner` rail) — it never types keystrokes, so the find screen's
   keyboard-wedge hook heard nothing. Fix: `CheckinScanListener` in
   `KioskCheckinFlow` mounts `useQrScanner` (same saved model/baud/port plumbing
   as the license scanner) on the find/matches/browse stages ONLY — the party
   stage's people monolith needs the exclusive port for its license listener.
   One-line bursts → `lookupByScan`; multi-line bursts (a license) → a friendly
   "scan your confirmation QR" error. Wedge hook kept as fallback.
2. **"Next: who's racing" tappable mid-lookup.** The party-stage buttons only
   gated on `partyNeedsSetup`; a sign-in lookup in flight (empty/complete party)
   left them enabled. Both buttons now also gate on `peopleBusy`.
3. **One person couldn't take two races.** The assign step force-swapped a
   member out of their other race ("already in another race"). Now a member may
   hold SEVERAL slots under the SAME web-booking heat-spacing rules
   (`heatsConflict`: same-track skip-adjacent 13 min, cross-track 30 min walk) —
   client (`raceSlotsConflict` releases only a too-close slot; picker labels
   "moves from their X race" vs "also in another race") AND server
   (`violatesSpacing` in completeCheckin, which also checks heats pre-filled at
   booking time by personId, mirroring findCrossBookingConflict; boundHeats now
   accumulates per person since the upsert replaces).
4. **Browse list hid 11pm+ reservations.** The ±3h window's forward edge cut
   anything more than 3h out. Now the list shows the REST of today (query is
   already today-scoped) with the 3h lookback kept. `BROWSE_WINDOW_MIN` →
   `BROWSE_LOOKBACK_MIN`; §12 supersedes the "±3h window" wording in the §
   "Owner decisions" list (lookback half unchanged).

Two more from the same evening's live traffic (Strachan family, guardian
56392934 + kids; fixed 2026-07-25 late, not yet live-verified):

5. **Every kiosk-signed waiver expired the NEXT MORNING (9am ET).** The Pandora
   waiver template's `duration: 1` means 1 YEAR (BMI semantics — desk-signed
   records carry ~1-year expiries), but `calculateWaiverExpiry` added DAYS →
   `invalidationDate = tomorrow`. Every waiver signed via `WaiverSigning`
   (kiosk, check-in, group events, phone join) died overnight — which also
   defeated the §"pull in existing valid waivers" feature. Fix: duration
   treated as years (clamped 1–10) in `lib/pandora.ts`; `?? 365` fallbacks in
   the waiver route + waiver-digital normalized to `?? 1`.
6. **Second minor's waiver "never applied" — Pandora person create is NOT an
   upsert.** One kid ended up with EIGHT person records (three holding waivers
   from three sign attempts); the guardian's `related[]` pointed at no-waiver
   duplicates minted by `linkMinorToGuardian`'s "re-upsert". Sign landed on one
   record while readiness reads (`bmiPersonId` vs `pandoraPersonId`) hit
   another → sign-then-revert loop. Fixes: `linkMinorToGuardian` removed;
   `submitSetup` (people step + party manager) never re-creates a person that
   already has a short id; qualification refresh reads waiver status on the
   short id waivers are signed against. Full detail: lessons.md § "Pandora
   create is NOT an upsert".
