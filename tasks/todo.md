# Open Tasks

## Resadmin VIP race-truth (board stops clock-guessing race Done) — MERGED TO MAIN 2026-07-08

Problem: VIP combo cards mark a race step "✓ Done" purely off the clock
(`stepProgress` in `src/features/reservations-admin/combo-board.ts` — `now >= start+duration`),
so a delayed heat shows Done while the party is still waiting; retirement (30 min past last
step) can drop a delayed combo from Active Only before the race runs. Bowling already has
QAMF lane truth (`legStatus`); races have no truth signal today.

**Pandora SHIPPED `actualStart` / `actualEnd` — verified live 7/8 ~7PM ET** (explicit
`null` until they happen, never omitted) on the session objects of
`GET /v2/bmi/sessions/{locationID}` — deliberately timestamps NOT a state enum (vt3
`status`-drift lesson, see lib/video-match.ts:31). Derivation: `actualEnd` set → Finished ·
`actualStart` only → On track · neither + session is the track's `races/current` entry →
Called · neither + scheduledStart past → Delayed (amber) · neither + future → Upcoming.
Cancelled needs no state: heat vanishes from the bill's re-read `liveHeats`.
Live-test notes: delays are real (Blue heat 35 started 22 min late — the exact bug);
**actualEnd can fail to stamp** (heat 35 stayed open while 36-40 finished) so on-track must
be sanity-capped: finished if a later same-track heat has actualStart, or ~20-min cap.
Past dates return empty — same-day only. Our sessions proxy passes the fields through
as-is; pre-race-tickets keeps the Redis cache ≤2 min stale during ops hours.

Built on branch `fix/resadmin-vip-race-truth` (651bf4d8, pushed — PR: https://github.com/BMA-Dassle/Tools-Website-FT/pull/new/fix/resadmin-vip-race-truth). States shipped as finished/on_track/called/not_called; derivation is the pure module `src/features/reservations-admin/race-live-state.ts` (18 new unit tests; 55 green in the feature dir; tsc clean apart from 2 pre-existing scratch-script files).

- [x] **Server** (`app/api/admin/bowling/reservations/route.ts`): where `liveHeats` attaches,
      resolve each heat → Pandora session (sessions proxy `prefer=cache`, warmed 2-min by
      pre-race-tickets; match track + scheduledStart, UTC↔naive-ET convert) and stamp
      `raceState: "ran" | "called" | "not_called"` (absent = no data → clock fallback).
      Sources in order: session `actualStart`/`actualEnd` (once live) → `races/current` +
      Redis last-race-per-track watermark (`pandora:last-race:fasttrax:{blue|red|mega}`,
      checkin-alerts-warmed; heats run in order per track so watermark past heat = ran) →
      nothing. Reuse the 60s in-memory cache pattern (10s board poll must add no load).
- [x] **Board logic** (`combo-board.ts`): `ComboScheduleStep.raceState`; `stepProgress`
      precedence mirrors bowling — `called`/on-track → active "On track now" regardless of
      clock; `ran` → done; `not_called` past scheduled end → active+overdue amber
      "Delayed · not called yet"; no signal → current clock behavior.
- [x] **Retirement**: combo with a `not_called`/`called` race step can't go `inactive`;
      hard cap end of operating day (no-show party: heat still gets called track-wide,
      which retires the card 30 min later anyway).
- [x] **UI** (`VipComboCards.tsx`): pill wordings only. Main list inherits via schedule index.
- [x] **Tests**: extend `combo-board.test.ts` — delayed heat stays active past clock-end;
      watermark/actualEnd flips done early+late; no-signal fallback; retirement guard.
- [ ] **Live smoke** on a real combo night (delayed heat shows amber, flips Done on next call).

Phase 2 (separate, later): party-level truth — participants `checkedIn` + F_PAR_STATE docs
(asked Pandora) or vt3 video-match; needs racer personIds or name matching vs
`booking_metadata.racerNames`.

## Race close-out on track truth (race-dayof-pay settle gate) — MERGED TO MAIN 2026-07-08

Branch `fix/race-dayof-settle-truth` (84cc3d7f, pushed — STACKED on
`fix/resadmin-vip-race-truth`; merge that PR first, then re-base/merge this one).
The cron's no-check-in fallback charged races the instant the clock passed the first heat's
scheduled start ("TEMPORARY" per its own header) — heats run 6-22+ min behind, so guests could
be charged before racing. Owner decisions 7/8: settle when the LAST booked heat actually
finished (Pandora actualStart/actualEnd via `raceSettleGate` in race-live-state.ts);
unresolvable heats clock-settle at start +45 min; past-date stragglers immediately; +6h hard
cap; resolved-but-delayed heats WAIT past the net (truth wins); `reservation-status-close`
+2h flip, attractions, combos, -5 arrival path all unchanged.

- [x] Pure `raceSettleGate()` + 8 unit tests (63 green in feature dir; tsc clean)
- [x] Fetchers extracted to `race-live-state.server.ts` (shared board + cron; verbatim move)
- [x] Cron gates race fallback; `dayof_order_source` = `-fallback-raceend` (verified finished)
      vs `-fallback-timepassed` (any clock path); skip logs show gate waiting reason
- [x] Merged to main 7/8 (ff, with fix/resadmin-vip-race-truth) — deploys with next Vercel build
- [ ] **Live smoke** on a race night: `?dryRun=1&token=…` shows `waiting: … on_track` for a
      delayed heat instead of charging at scheduled start; settles minutes later with source
      `-raceend`; a -5 arrival still charges immediately (source `race-dayof-pay`)

## Ultimate VIP improvements — MERGED TO MAIN 2026-07-06, ALL DEFAULT ON; live smoke pending

Owner decisions (locked 7/6): reserve the combo's Starter anchor heats from regular bookings
(release 60 min before, Starter anchors only) · steer later same-date VIP bookings onto the
existing group's schedule (default + highlight, staff email flags non-matches) · juniors get a
mirror heat right AFTER the adult heat on both race legs, same per-person price. Owner 7/6:
everything defaults ON — each env flag is now a kill switch (`=false` in Vercel + redeploy;
build-baked). Plan file: `~/.claude/plans/cheeky-wandering-lampson.md`.

- [x] **Anchor reserve** — `vip-combo-anchor-reserve` restriction rule (empty slot at
      2/4/6/8/10 PM blocked on every track/tier, occupied-session joins allowed, 60-min
      lift, "VIP Reserved" disabled card) + per-rule `exemptComboBookings` / ctx
      `isComboBooking` so the combo's own `bookHeatsOnAdvance` path bypasses ONLY this rule.
      Kill: `NEXT_PUBLIC_COMBO_VIP_ANCHOR_RESERVE=false` (also inert if the combo is off).
      NOTE: on deploy the 2/4/6/8/10 PM heats grey out for regular racers immediately.
- [x] **Group match** — `combo-group-match.ts` (pure matchers) + `combo-existing.server.ts`
      over `listVipComboReservations` + GET `/api/booking/v2/combo/existing` (fail-open, no
      PII) + grid banner/badges ("Joins/Near the 4 PM group", gold ring) + staff-email match
      note (exact / same-hour-different-race ⚠️ warning + subject suffix / different-hour
      neutral FYI — 2026-07-10: warning narrowed to the same-hour case only). Kill:
      `NEXT_PUBLIC_COMBO_GROUP_MATCH=false` (email note unflagged). Advisory-only: reads
      booking_metadata heat times; office reschedules degrade the hint, never block.
- [x] **Junior mirror** — mixed parties book juniors on the first junior block strictly
      after the adult heat (36-min window, `pickJuniorMirror`); leg end = last race + 30 min
      (`raceLegEndMs`) so the bowling 75-min window measures from the junior heat; confirm
      modal shows "Juniors race at 2:12 PM on Blue"; staff email rows tagged "— Juniors".
      Kill: `NEXT_PUBLIC_COMBO_JUNIOR_MIRROR=false` = byte-identical same-start path. Known
      limits: junior Starter is Blue-only (juniors race Blue whatever the adults pick);
      Mega Tuesday stays junior-blocked (no BMI junior Starter Mega product).
- [x] Merged 1 → 2 → 3; ~36 new unit tests green; tsc clean; branches deleted.
- [ ] **Post-deploy live smoke:** regular picker greys "VIP Reserved" at 2:00 PM (2:12
      bookable), combo still books 2:00, card frees at T-59 · book VIP group A at 4 PM →
      reopen wizard → badge; book B on it → "same Starter heat" email; group C same hour
      but different heat (e.g. 4:12) → ⚠️ SAME HOUR, DIFFERENT RACE email; group D at 8 PM →
      neutral FYI note, no warning · 2 adults + 1 junior e2e on a non-Tuesday (junior heat right
      after adult on BOTH legs on the BMI bill; bowling scheduled off the junior heat).
- [ ] **Unrelated, found during merge:** `lib/guest-survey-db.test.ts` has 5 pre-existing
      failures on main (seed grew 22 → 30 questions — racing survey — without updating this
      older test). Fix or retire the stale test.

## Cancel & refund improvements (all-kinds cancel + store-credit gift cards) — BUILT 2026-07-03

**Branch `feat/cancel-refund-improvements` — not yet merged.** Owner decisions: no reschedule
flows beyond the existing bowling one; every other change = CANCEL with two outcomes — refund
to card, or convert the deposit into a NEW customer gift card (Square-generated GAN — internal
WEBHPFM… GANs are blocked from online payment) that the guest rebooks with (self-settles
weekday/weekend price differences). Combos staff-only; customer self-serve = gift card only;
staff can keep the GAN (notifyGuest=false) for phone rebooks; every cancel emails+texts.

**Built:** money-group cascade (`src/features/cancellation/` — 82 unit tests) over every row
sharing the deposit order (combos + mixed carts cancel together): audit row →
exactly-once per-tender refunds OR gift-card issuance (GAN persisted BEFORE
activation/delivery) → mark legs cancelled → best-effort teardown (day-of orders w/ tendered
refusal, GC drain ADJUST_DECREMENT + deactivate, QAMF delete, BMI project -4 via W-number
search + verify, add-ons, loyalty, promo) → email/SMS. New `reservation_cancel_events` audit
table doubles as idempotency attempt counter. Routes: `POST /api/admin/reservations/cancel`
(dry-run preview, both outcomes, all kinds), `POST /api/booking/v2/self-cancel` (HMAC sig),
legacy cancel routes delegate (fixes the combo single-leg bug for stale tabs). Portal: cancel
on ALL kinds + Cancel Combo on VIP cards + outcome picker modal (auto dry-run body) + GAN
copy button + durable "GC 1234-… ($X)" / "-$X" display on cancelled rows. Customer: v2
confirmation "Can't make it?" section + BowlingConfirmation gift-card-only swap — **shipped
ON, no flags (owner call 7/3)**; the guest card is branded **HeadPinz FastTrax Gift Card**
(order line item, emails, SMS, all UI).

- [x] 82 feature unit tests green; tsc + eslint parity with main; each step committed green
- [x] Dry-run exercises on prod rows (all shapes + a live combo; partial-redemption block
      verified on a real tonight-combo) · owner previewed the modal on Vercel preview
- [ ] **Run `npx tsx scripts/store-credit-probe.mts --live`** (owner: prod Square $1 probe)
      → exit 0 ⇒ set `STORE_CREDIT_STRATEGY=purchase`, else leave comp default.
      Comp path wants a "HeadPinz FastTrax Gift Card" catalog discount + env
      `SQUARE_STORE_CREDIT_DISCOUNT_CATALOG_ID` for honest GL (falls back to survey discount
      with a loud warn).
- [ ] Post-deploy live smoke: race gift-card cancel e2e (GAN redeemable online, sweep
      dry-runs skip the -4, day-of order CANCELED) · admin refund + idempotent re-run ·
      combo both outcomes · tendered-day-of refusal

## Race product step redesign (Option C) + stepper overlap fix — SHIPPED 2026-07-02

Owner picked Option C from mockups: each tier is ONE card; Single vs 3-Race Pack are
side-by-side selectable columns inside it (5 cards → 3 for a returning racer). Copy rewritten:
one-line descriptions, qualification/ages in the tier section header (junior screens drop the
adult age line), "Runs on Red + Blue — pick your track with your heat time" dot line replaces
bare track chips, prices unified white (amber only for "Save $X"), first-visit license note
shows ONLY for new racers. Discount banner 🏁 emoji → IconDiscount2 (@tabler/icons-react).
Selection semantics untouched (each column selects its RaceProduct via handleCardClick).
Also: sticky stepper + timer bar `top-18/top-20` → `top-[120px]` (fixed nav is ~120px tall —
was overlapping the stepper).

- [x] `RaceProductStep.tsx` TierCard replaces ProductCard; `BookingFlow.tsx` sticky offsets
- [x] Verified live via dev server + puppeteer with seeded `sessionStorage.booking_session`
      (v2 envelope, item cursor): returning pro (3 cards, both packs, Save $13), new racer
      (license breakdown + note), junior (Blue-only, meta sans age), weekend (Save $21,
      $19.99/race, no Pro), pack-column click → SELECTED flag + Next enabled, mobile 390px
      stacks clean, stepper clears nav. 268 booking tests + tsc clean.
- [x] Merged to main per owner (was slated for preview-first; owner said push to main)

## Cross-reservation heat spacing + heat-cap removal — 2026-07-02

**Problem (owner):** racers dodge the per-racer spacing rules (same-track 13-min, cross-track
30-min) by booking each heat in a SEPARATE reservation — the conflict check only saw the cart,
and only client-side. **Decisions:** spacing rules only (no daily cap — the per-cart
6-heat `SINGLE_RACE_MAX_PER_RACER` is REMOVED entirely) · hard block · forward-only (no
backfill; personId matching covers returning racers; a re-registered "new" racer duplicates
the BMI person and slips — accepted).

**How:** persist `bmiPersonId` + racer name per heat in `booking_metadata.heats` at reserve
(shared `raceHeatsMetadata` in checkout.ts, used by BOTH reserve paths) → server guards in
`/api/booking/v2/reserve` (step 0b) + `unifiedReserve` (guard 0b) query Neon
(`raceHeatsForPersonsOnDate`, excludes own bill so retries don't self-conflict) and run
`findCrossBookingConflict` (conflict.ts — same heatsConflict rules) BEFORE any Square write →
409 EXISTING_BOOKING_CONFLICT with racer name + times. Picker greys the same slots up front
via GET `/api/booking/v2/booked-heats`. Fail-open on query errors everywhere.

- [x] 268 booking tests pass (7 new) · tsc clean · SQL live-validated against prod Neon
      (0 matches expected pre-rollout; 299 heats scanned; exclude param works)
- [ ] Live verify post-deploy: book a race, then try an adjacent heat for the same racer in a
      fresh session → picker greys it / reserve 409s; confirm new rows carry bmiPersonId

## Race restrictions: reserve 2 Starter slots/hour + unconditional junior back-to-back — IN PROGRESS 2026-07-02

**Owner decisions (2026-07-02):** all three tracks (Red/Blue/Mega) · only ADULT starter counts
toward/consumes the guarantee (junior starter is a consumer like int/pro) · 60-min last-minute
lift on the reserve rule · blocked slots HIDDEN. Plus: junior back-to-back becomes unconditional
("regardless of anything") — no last-minute override, and adjacency counts ANY junior race
(cross-tier via categoryTrackBlocks, not just the candidate's own tier). Hidden like Pro.

**Design:** new constraint `reserveStarterRoomPerClockHour {minRoom:2}` in
race-restriction-rules.ts. Counts remaining "starter room" in the candidate's clock hour =
distinct heat starts that are empty OR occupied by an adult-starter race (occupied heats are
tier-exclusive in BMI availability, so tag blocks by source product). Blocks a non-adult-starter
pick when booking it would leave room < 2. Room-counting (vs. hardcoded cap of heats/hour − 2)
degrades conservatively when BMI drops passed/sold-out heats and handles partial hours.
Two rule entries cover "everything except adult starter": tiers [intermediate,pro] all
categories + tier starter category junior (Blue only — juniors don't run Red/Mega starter).

- [x] `race-products.ts`: `singleRaceProductsOnTrack(track, schedule, racerType)` (all
      tiers+categories, !packType); reimplemented `juniorProductsOnTrack` on top of it
- [x] `race-restriction-rules.ts`: renamed `noAdjacentOccupiedSameTier` → `noAdjacentOccupied`
      with `scope: "tier" | "category"`; junior b2b rules → scope category, override dropped;
      new `reserveStarterRoomPerClockHour` constraint + `trackAllTierBlocks` ctx (tagged
      `adultStarter`); 2 new rules; header doc updated
- [x] Unit tests: 52 pass (12 new reserve-room cases + junior b2b cross-tier/unconditional)
- [x] `RaceHeatPickerStep.tsx`: junior-Mega-only fan-out → all-tier per-track `crossTierProducts`
      fan-out (skipped for adult-starter grids); one query set feeds junior + tagged unions
- [x] `race.ts` `assertHeatBookable`: all-tier union, Promise.all best-effort sibling fetches;
      junior union now covers Blue AND Mega
- [x] `_restriction-smoke.mts`: rewritten to run EVERY single product on a track with the unions
- [x] vitest (261 booking tests) + tsc clean (only pre-existing scratch-script errors)
- [x] LIVE SMOKE (2026-07-02): Blue Thu = exactly right blocks (hour-18 reserve, junior
      cross-tier b2b at 17:48/19:00, Starter never blocked); Mega 7/7 empty→no blocks; Red Fri
      sparse→no blocks. Live data forced one fix: joining an already-occupied session consumes
      no room → never reserve-blocked (was blocking a 16:48 join).
- [x] Verified live: occupied heats ARE tier-exclusive (16:12 occupied-Int absent from Starter
      list); room-counting is drop-off-safe by construction either way.
- ⚠️ DISCOVERED: Blue ran a 12-MIN cadence on 2026-07-02 (17:00/17:12/17:24…), not the 15-min
      the opening-heats-express-only-15min windows + jr-b2b gap-16 comment assume. Reserve rule
      is cadence-independent (counts real slots); the OPENING-WINDOW rule for Blue would cover
      3 heats (13:00/13:12/13:24) on 12-min days, not 2 — confirm intent with owner.
- [ ] Commit on a fresh branch off main (changes currently uncommitted in the working tree;
      current checkout is feat/account-dashboard-login — unrelated)

## Self-service "edit reservation up to check-in" — SPEC, awaiting approval 2026-06-21

> **2026-07-11:** the admin-side superset of this feature is now fully specced, APPROVED, and
> **BUILT** (branch `claude/reservation-editing-plan-vvh9ee`, all flags OFF) — see
> [tasks/future/reservation-editing-plan.md](future/reservation-editing-plan.md) § 16 for the
> flag matrix + the live-smoke gate that must run before enabling (staff edit engine: repricing,
> refunds both directions, QAMF/BMI sync, card-on-file vault + 72h sweep, EditReservationModal,
> self-hosted payment-difference page). This self-service spec becomes a thin guest-facing
> client of that engine; the engine now exists.

**Goal:** let a guest change their booked bowling reservation (food, players, lanes, time)
any time before check-in; if the change increases the total, charge the difference.

**Locked decisions (from owner 2026-06-21):**
- Scope = **everything**: food add-ons, player count, lanes, time.
- Difference charged by **re-entering a card on the edit page** (Square Web Payments; no card-on-file assumption).
- **Add-only — no reductions/refunds.** An edit may never lower the paid total; staff handle reductions manually.

**Grounding (verified):**
- Edit surface = the existing confirmation page reached via `headpinz.com/s/{shortCode}` (short-url → confirmation).
  Reservation lookup already exists: `GET /api/bowling/v2/reservations/by-code`.
- Repricing must reuse the quote path (`/api/square/bowling-orders/quote` + reserve pricing) to honor the
  **displayed-vs-charged hard-fail guard** (project rule) — recompute exactly, never trust client totals.
- Food-line attach to the day-of order already exists (shipped c00286ac) — Phase 1 reuses it.
- **QAMF has NO time/lane reschedule API in our client** (`patchReservation` = Title/Notes/Status only; we only
  *sync* BookedAt FROM Conqueror). Changing time/lanes ⇒ **cancel (`deleteReservation`) + `createReservation`**
  anew → re-check availability, re-link deposit/day-of order, risk slot loss. This is the hard part.

**Editability guard (all phases):** allow only while `status ∈ {confirmed, confirm_pending}`,
`dayof_order_sent_at IS NULL` (not checked in / lane not opened), and event time still in the future.
Optimistic guard against the lane-open cron racing the edit.

**NARROWED v1 (active, owner 2026-06-21): edit the PIZZA TOPPINGS + SODA flavor of a Pizza Bowl only.**
No player/lane/time changes; no adding pizzas/sides. Guests re-pick toppings/drinks before check-in.
- [ ] Edit surface on the confirmation page (`headpinz.com/s/{shortCode}`): load current pizza/soda
      selections per lane, reuse `BowlingFoodStep` UI to re-pick toppings + drink.
- [ ] Edit endpoint: guard (pre-check-in, future, status ok) → recompute rawItems (pizza/soda lines w/ new
      topping/drink notes) → reconcile onto the day-of Square order (update existing food line NOTES by uid,
      or remove+re-add) → update persisted `bowling_reservation_lines`.
- [ ] $0 swaps (same topping count) are free. **Adding paid extra toppings (>1/lane = $1 each):** OPEN
      QUESTION below — include the re-enter-card charge now, or restrict v1 to no-new-cost edits (paid extras
      added at the counter).
- [ ] If the food line isn't on the order yet (older orders pre-fix), add it during the edit.

**Later phases (deferred):** Phase 2 player count (reprice + `setLanePlayers`); Phase 3 lanes/time reschedule
(HARD — no QAMF reschedule API; cancel+rebook only, slot-loss risk). Spike Phase 3 before building.

**Payment-for-difference design:** recompute authoritative total → `diff = new_total − already_paid`;
enforce `diff ≥ 0` (add-only); if `diff > 0` require a fresh Square nonce on the edit page, charge with an
idempotency key bound to (reservationId, new_total), apply to the day-of order; hard-fail + page on-call if
displayed diff ≠ charged diff. Record an edit-audit row (what changed, diff, payment id, timestamp).

**Open questions for owner:**
- Phase 3: acceptable that a time/lane change briefly cancels + rebooks in QAMF (tiny window where the old
  slot is released)? Or restrict time/lane edits to "request" (staff-confirmed) rather than self-service?
- Any cap on how close to start time edits are allowed (e.g. block within 1h of the slot)?

**Verification:** live smoke per phase — book → edit (add paid item) → confirm difference charged once, day-of
order + Neon lines updated, QAMF reflects change, KDS gets the added food. No double-charge on retry.

## Christmas in July — landing page (B2B holiday open house, 2 locations) — IN PROGRESS 2026-06-15

Branch: `feat/xmas-in-july-landing` off `origin/feat/xmas-in-july-event` (NOT yet on main).
URL slug stays `xmas-in-july`; display title is **"Christmas in July"**.

**What it actually is (per flyer — corrected mid-build):** a festive **business-leader open house**,
NOT a public free-race promo. Holiday bites + signature drinks + venue/party-hosting pitch.
Included per guest: 2 drink tickets · holiday buffet (TBD) · complimentary bowling · 1 go-kart race (FM).
**Two events, one page, choose location:** Fort Myers 7/30 (HeadPinz & FastTrax, racing) and
Naples 7/23 (HeadPinz only — NO FastTrax, so RSVP-only). Both 4–7 PM; racing slot 4:30–5:30 PM.
Open RSVP. Decisions: one page w/ location chooser · RSVP + race booking · open access.

### Done
- [x] Assets on Vercel Blob (`events/xmas-in-july/`): bowling hero loop (1080/720 + poster), 7 gallery
      photos (WebP+JPEG, family pic dropped → 6 used). Upload script `scripts/upload-xmas-assets.mjs`.
- [x] Racing video = reused FastTrax homepage hero (`images/hero/hero-video.mp4` + `hero-racing.webp`).
- [x] `group-events.ts`: `GroupEventLanding` (heroVideo, included[], locations[], featureVideo, gallery,
      finePrint, eventTime) + `GroupEventLocation` (key/label/venue/date/address/racing). Populated
      `xmas-in-july` with B2B copy, both locations, what's-included. Dropped hard `minAge:18`.
- [x] Page: location-aware hero (bowling video) → "What's Included" → racing feature video → gallery →
      location chooser → RSVP. Naples branch skips waiver/DOB (RSVP-only); FM keeps race-booking funnel.
      Reduced-motion/Save-Data → poster. Confirmation hides waiver/racing-license for Naples.
- [x] RSVP endpoint stores `location` (both venues share the slug — only differentiator for ops).
- [x] tsc clean · build clean · a11y gate 0 violations · SSR renders all sections + chooser.

### TODO
- [ ] **GF photos** — owner sending 2–3 group-function photos; optimize + upload + slot into gallery.
- [ ] Buffet menu (TBD on flyer) — copy update when known.
- [ ] Live smoke on a deploy: FM path (choose FM → email → name+DOB → waiver → book race heat) +
      Naples path (choose Naples → email → name → RSVP confirmation). Verify RSVPs tagged by location.
- [ ] Commit + push branch (not committed yet) → PR link.
- [ ] Confirm with owner: keep slug `xmas-in-july` or add `christmas-in-july` alias.

## ⚠️ Temporary fallbacks to remove later

- **Race + standalone-attraction day-of auto-charge on start-time-passed** (added 2026-06-09,
  user-requested stopgap). `/api/cron/race-dayof-pay` normally settles the day-of order only when
  it sees the guest Arrived (-5) on the SMS-Timing dayplanner. As a safety net it now ALSO settles
  when the **activity start time has passed** (earliest heat for race, earliest slot for
  attraction — from `booking_metadata`, NOT `booked_at`), even if the Arrived scan failed/never
  fired. Standalone attractions = no bowling sharing the day-of order (bowling carts settle via
  lane-open). Remove once -5 detection is proven reliable. Search `FALLBACK` in
  `apps/web/app/api/cron/race-dayof-pay/route.ts` to delete (revert the scan-error bail too).
  NOTE: legacy attraction rows booked before this have empty `booking_metadata` → no start time →
  they're skipped (settle them manually via `?billId=…&token=…` if needed).

## HP Arena E-Tickets — Laser Tag + Gel Blaster at HeadPinz FM (LIVE — 2026-06-11)

**Status:** fully live, including the "now checking in" flow. Runbook + integration notes:
`docs/hp-arena-etickets-rollout.md`. Owner decisions: FM only (Naples later) · laser tag +
gel blaster · full HeadPinz identity (HP sender `+12393022155`, headpinz.com links).

- [x] PR-1..PR-5 (shared plumbing, HP ticket views, pre-session cron, schedule, scanner +
      `ARENA_QR_ENABLED`) — merged to main 2026-06-11, cron live (owner approved skipping the
      dry-run sequence; sender = existing HP DID).
- [x] PANDORA ASK — delivered same-day: `sessions/current` (called arena sessions) +
      `sessions/next` (next unstarted session by person/participant). Wired:
      `arena-checkin-alerts` cron (1 min — `race:called:{sid}` banner + NOW CHECKING IN
      SMS/email, source `arena-checkin-cron`) and scanner (called-signal green gate w/
      time-window fallback, "come back at X" via sessions/next).
- [ ] OWNER 0b: verify whether ONLINE arena bookings attach participants pre-session (book one
      2h+ out, probe participants). If purchaser-only/none → coverage = POS/phone population;
      follow-up = send e-ticket link at booking-confirmation time.
- [ ] OWNER 0d: sign off ImportantArenaInfo arrival/waiver copy (conservative defaults live).
- [ ] POST-LAUNCH WATCH (first week): admin board arena rows, `cron:log` `arena-pre` +
      `arena-checkin`, `unclassifiedSessions` in cron responses, undelivered rate on the HP DID,
      racing `bySource.eTicket` canary.
- ⚠️ BEFORE NAPLES: `ticket:bySession:{sid}:{pid}` + `alert:arena-pre/arena-checkin:{sid}:{pid}`
      + `race:called:{sid}` keys are NOT location-scoped — fine at FM (FT+HP FM share one BMI
      server / sessionId namespace), but Naples is a separate BMI server → add a location
      segment to these keys first.

## Booking V1→V2 FULL CUTOVER + race-pack port (IN PROGRESS — 2026-06-07)

**Goal (user directive):** V2 is the booking system. Replace ALL booking entry points
with entry into V2, AND port race-packs to V2 (the only activity with no v2 today).

**Grounding:** ~90 v1 entry points inventoried; 4 shared components carry most traffic.
Cutover mechanism = server-side redirects (catch emails/QR/bookmarks) + middleware fix +
update the hot shared links. Honors the repo cutover rule (redirect v1→v2; delete v1 later).
Decisions locked by `tasks/future/race-pack-as-credit-purchase.md` + v1 parity: race-pack
DEFERS redemption (credits spent in the existing v2 race flow), NO expiration (v1 = year-2999),
single Square SKU + name override, grant via `addDeposit(+N)` on Square capture.

### Phase A — Entry-point cutover for race/attraction/bowling/KBF (conflict-free w/ other workflow)
- [ ] Middleware: exclude `/v2` paths from the HeadPinz `/hp` + `/book/bowling*` + `/book/kids-bowl-free*`
      rewrites (FIXES latent bug: `headpinz.com/book/bowling/v2` → `/hp/book/bowling/v2` 404). Point
      HeadPinz `/book` (exact) → `/book/v2` instead of `/hp/book`.
- [ ] `next.config.ts` redirects (307 temporary during cutover — flip to 308 when v1 deleted):
      `/book`→`/book/v2`, `/book/race`→`/book/race/v2`, `/book/{gel-blaster,laser-tag,duck-pin,shuffly}`→`…/v2`,
      `/book/bowling`→`/book/bowling/v2`, `/book/kids-bowl-free`→`/book/kbf/v2`, plus `/hp/book/*` equivalents.
      EXCLUDE `/book/race-packs`, `/book/confirmation*`, `/book/checkout`, anything `/v2`.
- [ ] Update 4 shared components → v2: `components/Nav.tsx`, `components/MobileBookBar.tsx`,
      `components/headpinz/Nav.tsx`, `components/headpinz/MobileBookBar.tsx`.
- [ ] Update high-traffic CTAs (home Hero, pricing, racing, leaderboards, hp/fort-myers, hp/naples) → v2.
- [ ] Update static email-template booking URLs (redirects also catch these).
- [ ] **MERGE GATE:** bowling/KBF v2 must pass the QAMF+Square smoke test before this branch hits prod.

### Phase B — Race-pack v2 port (DONE — STANDALONE, 2026-06-07)
**Approach:** standalone `/book/race-pack/v2` (user: "whichever easiest/most efficient"). Deliberately
NOT the in-cart `CreditPackItem` from the design doc — that threads through `unified-reserve.ts` +
`types.ts`, which the other workflow is mid-refactor on. Standalone matches what v1 actually does
(race-packs is its own flow) and reuses v1's PROVEN, server-atomic Square + `addDeposit` money rail.
Touches ZERO files the other workflow is editing.
- [x] `src/features/booking/data/packs.ts` — 6 SKUs verified 1:1 vs v1 (price, depositKind, raceCount, shared Square SKU).
- [x] `src/components/features/booking/RacePackFlow.tsx` — pick pack → identify racer (returning lookup /
      new) → review + clickwrap → `PaymentForm` (lineItem + `postPaymentAction:addDeposit`).
- [x] Route `app/book/race-pack/v2/page.tsx` (thin server shell + metadata).
- [x] Confirmation reuses v1 `/book/race-packs/confirmation` (already renders the viaDeposit "Credits
      Loaded" + "Credits Pending" states) — left on v1, NOT redirected.
- N/A `CreditPackItem` union / `credit-pack` service / `unified-reserve.ts` wiring / step registry —
      unused by the standalone approach (charge goes through `/api/square/pay`, never unified-reserve).
- N/A Landing tile on `/book/v2` — the v1 `/book` hub never listed packs either (parity-correct).
- ⚠️ Simplification vs v1: per-mode OTP omitted (loading credits is non-extractive — the buyer pays to
      ADD value, so there's no account-takeover surface to gate). Revisit if abuse ever appears.
- FOLLOW-UP (optional): in-cart `CreditPackItem` integration once the other workflow's unified-reserve
      refactor lands, if mixing a pack into a multi-activity session is ever wanted.

### Phase C — Race-pack cutover (DONE — 2026-06-07)
- [x] Redirect `/book/race-packs` → `/book/race-pack/v2` (middleware `bookingV2Target`, exact match so
      `/book/race-packs/confirmation` stays on v1). Pricing "View Packages" CTA covered by the redirect.
- [ ] Retire/delete the v1 `/book/race-packs` page in a later PR after ops sign-off.

### Phase D — HeadPinz center-aware v2 landing (DONE — 2026-06-07)
Convert HPFM/HPN booking to v2 with center-scoped offering order on `/book/v2`.
- [x] `landingOfferingsFor(brand, center)` in `activities-catalog.ts` — Naples scopes to ONLY
      Naples-available offerings (drops FT-only race/duckpin/shuffly); Fort Myers/unknown shows all;
      within scope the VISITOR'S brand propagates first (FastTrax-first on FT, HP-first on HP;
      shuffly's "auto" brand resolves to the entry brand). + 5 unit tests (26/26 catalog tests pass).
- [x] `?location=` → `session.center`: `EntryContext.center` + parsed in `parse-entry-context.ts`
      (was an unused gap — `setCenter` was never dispatched in v2, so center was always null/FM).
      `BookingFlow` seeds `setCenter` on a fresh session → Naples books with the Naples clientKey.
- [x] `/book/v2` page resolves center from `?location` + passes ordered offerings + center to PromoLanding.
- [x] `PromoLanding` tile links carry `?location` so the picked activity seeds the right center.
- Entry: Naples hero CTA (`/hp/book?location=naples`) → Phase-A redirect → `/book/v2?location=naples` → scopes. ✓
- ⚠️ Minor pre-existing gaps (not blocking): HP nav "Book Now" goes bowling-direct (not the grid) and
      one `/naples` laser-tag link lacks `?location` → defaults to FM center. Polish later if wanted.

## Group-Function: re-price after paid-in-full (IMPLEMENTED — 2026-06-06)
- **Plan + impl log:** [group-function-paid-in-full-reprice.md](group-function-paid-in-full-reprice.md)
- **Problem:** A BMI edit on a *paid-in-full* event recomputed balance as `total − deposit_due`, ignoring the balance already collected → re-sign re-charged it → **overcharge**. No path to charge just the delta. Also: paid Square balance links were never reconciled.
- **Scope (Eric):** Only paid-in-full events. Resign required regardless. Increase → charge difference + load gift cards (card on file, or capture a card on re-sign). Decrease → flag staff, no auto-refund. Deposit-phase flows untouched.
- **Status:** PR-1 + PR-2 implemented on branch `feat/gf-balance-link-reconcile`; typecheck/lint/prettier clean. **Not committed; not live-smoke-tested.** Verify §6 before go-live.

## PR-B5: Bowling + KBF into Unified BookingFlow (IN PROGRESS — 2026-06-02)
- **Branch:** `feat/booking-b2-race` · merged with main 2026-06-02
- **What shipped (all build-verified):**
  - D1: Type extensions — BowlingItem/KbfItem with 30+ fields, LoyaltyState on BookingSession, 5 new reducer actions
  - D2: Bowling service — `service/bowling.ts` (hold/confirm/cancel/reserve) wired into `getService()`
  - D3: 7 bowling step components — Players, Slots, Tier, Offer (QAMF hold), Shoes, Attractions (info-only), Food
  - D4: 2 KBF steps — KbfIdentity (lookup→OTP→verify), KbfBowlers (family member selection)
  - D5: Hold timer generalized — ReservationTimer handles BMI + QAMF with 8-min auto-extend
  - D6: Checkout bowling path → `bowlingReserve()` → `/api/bowling/v2/reserve`
  - D6b: Shared HeadPinz Loyalty — LoyaltySection at checkout for ALL HeadPinz bookings (earning + redeeming)
  - D7: Step registry — all bowling/kbf placeholders replaced with real components
  - D8: Deposit unification — bowling reserve uses `createDepositAndCharge()`, same as race/attraction
  - D9: DiscountCodeInput on bowling slots step
  - D10 (2026-06-02): BowlingSlotsStep → HP_LOCATIONS for real center hours
  - D11 (2026-06-02): BowlingOfferStep — duration picker for hourly, line-item enrichment (label/price/catalog/deposit%), per-lane vs per-person multipliers, product overrides
  - D12 (2026-06-02): Checkout quote fetch from `/api/square/bowling-orders/quote` + real line-item display (product names, per-line amounts, booking fee, tax, deposit breakdown)
  - D13 (2026-06-02): BowlingShoesStep stores shoe product metadata for checkout name resolution
  - D14 (2026-06-02): BowlingAttractionsStep → info-only (attractions are separate cart items, same as racing)
  - D15 (2026-06-02): Loyalty params wired to BMI reserve path (loyaltyAccountId, rewardTierId, rewardDiscountCents)
  - D16 (2026-06-02): Mixed-cart guard — **NEVER LANDED / entry is stale** (verified 2026-06-10: `addItem` allows mixed carts — `machine.test.ts:62` asserts it; `buildCombinedLineItems` merges race+bowling+attraction into one Square order). Kept that way DELIBERATELY: combo specials ([combo-specials-plan.md](combo-specials-plan.md)) require race+bowling in one session. Do NOT re-add a guard.
- **Still needs before go-live:**
  - Smoke test with QAMF staging + Square sandbox
  - Full Square Loyalty API reward creation in BMI reserve route (currently applies discount only; bowling route has full implementation)

## v2 Checkout: Server-side atomic BMI payment/confirm
- **Priority:** Medium (v2 checkout milestone)
- **Context:** v1 confirms BMI payment client-side on the confirmation page after Square charges. PR #13 (2026-06-02) added retry + error UI as an immediate fix, but the architecture still has a gap if the browser closes between Square charge and confirmation page load.
- **v2 fix:** Add `confirmBmi` postPaymentAction to `/api/square/pay` so Square charge + BMI confirm happen atomically server-side. Extract shared `lib/bmi-client.ts` for BMI auth + `confirmPayment()`. Wire into v2 checkout service.
- **See:** [restructure-plan.md § v2 checkout: server-side atomic BMI payment/confirm](restructure-plan.md)

## SEO: HeadPinz metadata on shared /book routes
- **Priority:** High
- **Issue:** `headpinz.com/book/*` pages show FastTrax title/description in Google results because `/book` routes use the root layout metadata (FastTrax-branded), not the `/hp` layout
- **Root cause:** Middleware line 69 excludes `/book` from the `/hp` rewrite, so shared booking pages inherit the root `app/layout.tsx` metadata
- **Fix:** Use `generateMetadata` in `/book` pages that reads the `x-brand` header (set by middleware) to return HeadPinz or FastTrax metadata dynamically
- **Files:** `app/layout.tsx`, `app/book/[attraction]/page.tsx`, `app/book/race/page.tsx`, `middleware.ts`
- **Google result example:** `headpinz.com/book/gel-blaster` shows "Indoor Go-Kart Racing & Entertainment | Fort Myers, FL" and "63000 sq ft of high-performance electric go-kart racing..."
