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

| Need | Existing primitive |
|---|---|
| Standalone kiosk flow shell | `/kiosk/waiver` → `KioskWaiverFlow` |
| Add people + waivers | `KioskAttractionPeopleStep.Component` StepDef (never fork) |
| Party signs on phones | Mobile join + new `checkin` stepKind |
| Attach person to existing BMI reservation | `registerProjectPersonServer` (gate `KIOSK_WAIVER_BMI_ATTACH`) |
| Racer on the timing grid | Pandora `POST /bmi/schedule` (`kiosk-post-reserve.ts:341-453`) |
| Bill-line personId can stay null | verified: no post-booking path reads it |
| Bowling names/shoes | players PATCH route + `syncQamfPlayers` (compose both) |
| Open the lane | `GET/POST /api/bowling/v2/reservations/{id}/checkin` |
| Mark reservation | `setProjectState` → **-5 Arrived** (built-in) |
| "What's next" model | v2 confirmation activity enumeration (extract) |
| Lookup | `/s` deref, Office `search?token=W#`, phone → `getReservationsByContact` + booking-record indexes |

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
