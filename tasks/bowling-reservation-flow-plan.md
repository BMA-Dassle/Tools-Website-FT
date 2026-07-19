# Bowling Reservation Flow Redesign — booking v2 + kiosk (PLAN)

**Status:** BUILT 2026-07-19 (same day, owner asked for the full build on this branch) — plan
PR0→PR3 landed as sequential commits on `claude/bowling-reservation-flow-0rd3nx`, v3 flow dark
behind `NEXT_PUBLIC_BOWLING_ONE_TIME_FLOW` / `?bowlingV3=1`. Accurate availability shipped as
**branch D** (windowed necessary-condition filter — the one design sound regardless of probe
outcomes); QAMF probes (§7) still run from local dev and can upgrade it to branch A/B/C.
Owner test checklist lives in tasks/todo.md § Bowling reservation flow redesign.
**Owner directives:** one time selection, not two · availability must be accurate per experience/
duration · modernize the bowling offer screen · build off the kiosk "Next Available" pattern ·
past times must never show as available (12:00 PM offered at 12:17 PM) · every PR is verified in
dev and on a Vercel preview before merge/flip.

---

## 1. Problems

1. **Double time selection (web + kiosk).** Guest picks an arrival time once (static, no
   availability behind it), then after the QAMF search picks/confirms a time again on the
   package step.
2. **Availability is not offer-accurate.** If the 1.5-hour web offer is available at a slot, the
   2-hour offer shows that slot too — even when the lane isn't free long enough. Same for VIP vs
   regular tier gating built on the same data.
3. **Offer screen looks dated** vs the newer screens (July race product redesign), and it's reused
   unstyled inside the kiosk where it clashes with the kiosk design language.
4. **Past times show as available** — e.g. the 12 PM option at 12:17 PM.

## 2. What the code does today (grounding — all verified 2026-07-19)

### Web v2 (`STEP_REGISTRY.bowling`, `apps/web/src/features/booking/state/steps.ts:167-185`)

Contact → `BowlingPlayersStep` → [`WorldCupMatchStep`] → `BowlingSlotsStep` ("Date") →
`BowlingTierStep` ("Experience") → `BowlingOfferStep` ("Package") → Shoes → Food. KBF
(`STEP_REGISTRY.kbf`) reuses Slots/Tier/Offer. All steps in
`apps/web/src/components/features/booking/steps/bowling/`.

- **Time pick #1** — `BowlingSlotsStep`: calendar + hour chips from `operatingHours()` — pure
  static center hours (`HP_LOCATIONS`), zero QAMF. Writes `item.date/hour/minute`. No past-hour
  filter on the chips (only the calendar uses `effectiveToday()`).
- `BowlingTierStep`: runs its OWN full-day 30-min QAMF scan just to render per-tier badges.
- **Time pick #2** — `BowlingOfferStep`: fine QAMF probe ±45 min around the chosen hour
  (`/api/bowling/v2/availability`, `windowMinutes=45`); if the hour is empty for the tier →
  full-day "widen" scan + up to 8 alternative time chips ("picking one changes your start
  time"). Even the happy path renders a "Select {time}" button (auto-select was removed —
  React 19 strict-mode crashes). On select: `POST /api/bowling/v2/reserve/hold` → writes
  `bookedAt/webOfferId/optionId/qamfReservationId`.

So QAMF is probed up to 3× across the wizard, and the guest touches "time" in two or three
places.

### Kiosk (`apps/web/src/features/kiosk/state/registry.ts`, bowling branch)

`KioskBowlingPeopleStep` → `KioskBowlingTimeStep` (today-only "Next open lanes" hero + chip
rail — from STATIC `operatingHours()`, no probe; real availability deferred to the next step by
design, per the file header) → `KioskBowlingTierStep` → **web `BowlingOfferStep` reused
unchanged** → `BowlingShoesStep` → `KioskBowlingDetailsStep` → `BowlingFoodStep`. Same
double pick, same probe-late shape.

**The pattern the owner likes, done right, already exists for attractions:**
`apps/web/src/features/kiosk/steps/KioskSlotStep.tsx` — ONE step: real availability probe →
`pickFirstSlot` (`src/features/kiosk/service/first-available.ts`, pure + unit-tested) → hero
"Next available · today" card ("{n} spots open — tap to grab it") → **tap = eager hold** →
full slot grid beneath ("Or pick another time today"). It works because it is **product-first**:
the product and quantity are already known, so one probe yields a truthful hero and the tap can
commit.

### Availability backend

`apps/web/app/api/bowling/v2/availability/route.ts`: for each candidate time, ONE point-in-time
QAMF `searchAvailability` probe (`BookedAtRange.StartAt === EndAt`, `WebOffer: {Services:
["BookForLater"]}` — no Id, no Options, no duration; batched 8, retry-once, all-fail → 502).
Route comment (~321): "QAMF ignores the WebOffer.Id filter and returns ALL enabled offers in
every response." Results are post-filtered to DB-known offers and de-duped.

Offers/experiences are Neon-backed (`lib/bowling-db.ts`): `bowling_experiences` (kind
`kbf|open|hourly`, `is_vip`, `days_of_week`), `bowling_experience_offers` (per-center
`qamf_web_offer_id`/`qamf_option_id`), `bowling_experience_duration_options` (90/120 min ↔
option id ↔ `square_multiplier`), seeded by `apps/web/scripts/seed-bowling-experiences.ts`.
VIP vs regular = distinct web offer ids mapped to QAMF Lane Groups upstream; the app never sees
per-lane data.

## 3. Root causes

**Offer-inaccurate availability (problem 2)** — four compounding layers:

1. `route.ts:341-347` — the probe is offer- and duration-agnostic (point-in-time only).
2. `route.ts:402-430` — the only duration-aware filter is `slotExceedsClose` (center CLOSING
   hour). Lane occupancy over the duration window is never checked.
3. `availability-client.ts:~92` (`parseAvailabilities`) — `availableTimeOptionIds` echoes ALL
   Time option ids QAMF returns (the full 60/90/120 triple, `Minutes` often undefined — the
   adjacent, already-documented Pizza Bowl short-booking bug).
4. `BowlingOfferStep.tsx:459-465` (`validDurationOptions`) — the 2-hour button shows iff the
   slot's `availableTimeOptionIds` contains its option id ⇒ shows whenever the 1.5-hour slot
   exists.

Hold (`reserve/hold/route.ts`) and reserve (`reserve/route.ts`) forward the client-picked
`optionId` with **no duration validation** — a bad pick either 409s late at QAMF ("Couldn't
reserve") or books wrong. The reservation-edit reschedule guard
(`src/features/reservation-edit/qamf-sync.ts:~205-216`) has the same point-in-time flaw.

**Past times showing (problem 4)** — two layers:

- (a) Server: `buildFullDayProbeTimes` (`route.ts:115-142`) has NO now-floor — only *targeted*
  mode clamps to `now + leadMinutes` (`route.ts:275-300`). Every full-day scan on today (tier
  badges, offer-step widen, combos, KBF admin) probes from opening time, and QAMF reports past
  slots as available.
- (b) Web client: `BowlingSlotsStep` hour chips have no past-hour filter — the 12 PM chip is
  clickable at 12:17 PM. The kiosk fixed exactly this client-side on 7/18
  (`KioskBowlingTimeStep` `nextQuarter`, owner: "it showed 2:00 PM at 2:18 PM") but the shared
  route stayed leaky.
- Lead-time policy (owner 7/17, `first-available.ts` header): kiosk walk-ups are ASAP — no
  artificial minimum. So `leadMinutes` must be caller-controlled: kiosk 0, web 15.

**Double time pick (problem 1)** — structural: time is asked before the offer exists, so the
offer step must re-ask/confirm once real availability is known. The fix is ordering, not polish.

## 4. Target design — flow/UX

### Core decision: pick PACKAGE before TIME

New order (web): Contact → Players → **Date** (calendar only) → **Experience** (merged
Tier + Package + duration, one modern screen) → **Time** ("Next Available" hero + accurate
full-day slot grid; tap = eager QAMF hold) → Shoes → Food.
Kiosk: People → **Experience** → **Time** (today-only; date stamped at item creation).

Why offer-first:

- Per-offer/duration-accurate slots require the offer + duration to be known before the grid is
  drawn. Time-first must either union all offers (recreating the bug) or re-validate later (the
  double pick being removed).
- The eager hold needs `webOfferId`/`optionId` at tap time (`/reserve/hold` body).
- `KioskSlotStep` — the liked pattern — is itself product-first.
- "Widening" / "nothing at this hour" ceases to exist: the grid IS the day's genuinely bookable
  starts for the chosen package. Exactly ONE time interaction, and it doubles as the commit.

Date stays before Experience because experiences are day-of-week gated (`days_of_week`) and the
per-card "next lane at X" hints need a date.

### New steps (new ids — classic ids keep resolving to classic steps during coexistence)

| Step | id | File (new) |
| --- | --- | --- |
| BowlingDateStep | `bowling-date` | `src/components/features/booking/steps/bowling/BowlingDateStep.tsx` — BowlingSlotsStep minus hour chips: calendar, `effectiveToday()`, +30d window, cart-date inherit, "also booked this day" list. |
| BowlingExperienceStep | `bowling-experience` | `.../BowlingExperienceStep.tsx` — merged Tier+Package (below). |
| BowlingTimeStep | `bowling-time` | `.../BowlingTimeStep.tsx` — hero + grid + eager hold (below). |

Registry: both flows coexist in `STEP_REGISTRY.bowling`/`kbf` behind `v3Only`/`classicOnly`
visibility wrappers (tiny helpers in `steps.ts`) reading
`bowlingOneTimeFlowEnabled() || session.context.bowlingV3`. Kiosk consumes the same shared v3
steps through `KIOSK_STEP_REGISTRY` (its existing `replaceStep` calls target classic ids, so the
classic kiosk flow is untouched while the flag is off). Kiosk-only differences ride
`session.context.kiosk` (precedent: `RaceProductStep.tsx` `kioskCompactPacks`): date=today,
conflicts hard-disabled, k-glass styling variant. Add the two new ids to `KioskFlow.tsx`
`NATIVE_STEP_IDS`; stamp `item.date = todayYmd()` at kiosk bowling/kbf item creation.

### The Experience screen (kills problem 3 + the Tier step's duplicate scan)

One screen, tier-SECTIONED like the July `RaceProductStep` redesign: "Classic Lanes" section
(coral `#fd5b56`) then "VIP Suites" (gold `#FFD700`, perks line, "Upgrade" eyebrow). Each
package is a shared `ExperienceCard`:

- media header (existing blob videos on web; kiosk photo treatment),
- label/description/price with the existing per-lane vs per-person rule and KBF price branches,
- **duration chips inline** for hourly experiences (1.5h/2h, price = `(override ?? price) ×
  squareMultiplier`), disabled per-duration when that duration has no genuinely bookable slot
  that day ("closes too early") — replaces `availableTimeOptionIds` guessing,
- **availability hint** per card: `useOfferSlots({..., limit: 1})` → "Next lane 6:30 PM" /
  "Sold out {date}" (React Query dedupes; hints never block selection; skeleton while loading).

Selection writes `tier`, `experienceId`, `webOfferId`, `optionId`, `optionType`,
`durationMinutes`, `durationMultiplier`, `durationOptionId` (NEW field). It does NOT write
`bookedAt`/`lineItems`. Changing offer/duration with a live hold resets time fields + releases
the hold. Selection happens in click handlers, never effects (React 19 strict mode). No emoji —
`@tabler/icons-react` only (the classic step's literal ⚠/✓ glyphs are not carried over).

### The Time step (the owner-liked pattern, generalized)

- Data: `useOfferSlots` hook (`src/features/booking/hooks/useOfferSlots.ts`) — the ONE place
  encoding the endpoint contract (§5): center + webOfferId + optionId + date + players →
  ascending, genuinely bookable, never-past slots.
- Hero: shared `NextAvailableCard` — "Next available · today/{date}", big time label, subline
  "Tap to lock it in — we'll hold your lane for 15 minutes" (kiosk keeps its voice). First pick
  via `pickFirstSlot` (reused from `first-available.ts`) with a duration-accurate cart-conflict
  predicate (real `durationMinutes`, not the 60-min guess; advisory ring on web, disabled on
  kiosk).
- Grid: shared `TimeSlotGrid` under "Or pick another time" — full day grouped
  Morning/Afternoon/Evening/Late Night (0-26h notation so 12:30 AM Sat sorts after 11 PM Fri).
- **Tap = eager hold** (hero or pill): `holdBowlingSlot()` (new service helper — releases any
  superseded hold first, fixing today's hold leak) → `setBowlingHold` → `onChange({bookedAt,
  hour, minute, optionId, optionType, lineItems})`. Failure → amber "That time was just taken —
  pick another" + grid refetch; never auto-pick a replacement.
- States: skeleton hero + shimmer pills loading; error card + manual retry (cold-start
  `fetchJsonWithRetry` backoff behind it); empty → "No {package} lanes on {date}" with Back /
  change-date CTAs (kiosk: front-desk copy). Keep `clarityTag("availability","soldout")`.
- Hold timer: unchanged machinery (`useReservationHold` 8-min PATCH keep-alive, expiry modal).
- VIP upsell parity: after a regular hold, one `limit=1` check of the VIP counterpart at the
  same `bookedAt` → existing modal (moved to `bowling/VipUpgradeModal.tsx`), once per visit.

### Shared components (new, presentational, no fetching) — `src/components/features/booking/bowling/`

`NextAvailableCard.tsx` · `TimeSlotGrid.tsx` · `ExperienceCard.tsx` · `VipUpgradeModal.tsx` —
each with `variant: "web" | "kiosk"` (kiosk = the exact `KioskSlotStep` hero/chip anatomy,
k-glass + 150px display type; web = rounded-2xl `border-white/10` glass at web scale).
**Executor note (repo hard rule): inspect the real kiosk DOM / `app/kiosk/kiosk.css` before
writing the kiosk variants — never guess.** `KioskBowlingTimeStep` + `KioskBowlingTierStep` are
superseded and deleted in the final PR. (Optional later cleanup: refit attractions'
`KioskSlotStep` onto the shared components — out of scope here.)

### Service extractions (PR1, zero behavior change)

New `src/features/booking/service/bowling-offer.ts`:

- `buildBowlingLineItems(exp, durationOpt, playerCount, laneCount)` — verbatim move of
  `BowlingOfferStep.buildLineItems` incl. the per-lane rule. Unit-tested.
- `effectiveBowlingOptionId(durationOpt, exp, slot)` — the option precedence with the **Pizza
  Bowl / Fun-4-All short-booking guard comment moved verbatim**.
- `holdBowlingSlot(...)` — release-previous-then-hold.

New `src/features/booking/service/bowling-hours.ts`: `operatingHours`, `bowlingTimeLabel`,
`CENTERS`, `effectiveToday`, `otherActivitiesOnDate`, `bowlingCartConflicts` (moved out of
`BowlingSlotsStep`/`KioskBowlingTimeStep`). `availability-client.ts` gains
`fetchJsonWithRetry<T>` (generalized from `probeAvailability`'s 600/1500/2500 ms backoff).

### State

- `BowlingCommon` gains optional `durationOptionId?: number | null` (persisted so the time step
  and re-holds rebuild `lineItems` without component-local state).
- `hour`/`minute` are kept but become DERIVED from the picked `bookedAt` — every consumer
  (CartView sort/labels, conflict math, classic steps during coexistence) keeps working.
- No reducer changes (`setBowlingHold`/`clearBowlingHold` suffice). No schema bump while the
  flag is off (field is optional); the FLIP PR bumps web `SCHEMA_VERSION` 2→3
  (`usePersistedReducer.ts`) and kiosk `KIOSK_SCHEMA_VERSION` 10→11 (registry order changes).

### Untouched blast radius

World Cup step (own hold path; new steps wrapped `hiddenForWorldCup`) · combos
(`hiddenInCombo` on the new entries; `combo-booking.ts`/`ComboSteps.tsx` unchanged) ·
`RescheduleModal`/`ComboTimeShiftModal`/admin KBF client · v1 `BowlingWizard` +
`BowlingConfirmation` · `/reserve` + `/reserve/hold` payloads · the availability route's
default behavior for legacy consumers.

## 5. Target design — availability correctness

**Core decision: keep `/api/bowling/v2/availability` and the `{Availabilities}` response shape;
fix the SEMANTICS of `WebOffer.Options.Time` so it lists only options that actually fit** —
behind an additive `optionCheck=accurate` query param (default off = today's behavior, so
legacy consumers see zero change). Consumers already *assume* these semantics
(`combo-booking.ts`, `WorldCupMatchStep`, `BowlingOfferStep` all treat `availableTimeOptionIds`
as "QAMF says these fit") — the cheapest correct fix is making the response mean what clients
already believe.

- Request (additive): `optionCheck=accurate` · `durationMinutes` now also drives the occupancy
  window check (not just close-time) · `leadMinutes` caller-controlled (kiosk 0 / web 15).
- Response: unchanged + `meta: { optionAccuracy: "qamf"|"filtered"|"windowed"|"optimistic",
  probeCount, probeErrors }`.
- Client: `parseAvailabilities` **deletes the "longest Minutes" optionId guess** (the Pizza
  Bowl bug source; single-option offers keep their id, multi-option → undefined and DB config
  decides) and gains `optionsVerified: boolean` from `meta`. Rule: `availableTimeOptionIds`
  may only gate duration buttons when `optionsVerified` is true.
- Server builds `Map<webOfferId, Map<optionId, minutes>>` from Neon ONLY — QAMF `Minutes` is
  never read for logic.
- How the accurate filtering is implemented depends on the §7 probe outcomes:

| Probe outcome | Design branch |
| --- | --- |
| A — QAMF point-in-time responses are already feasibility-filtered (P6 step 3) | Trust QAMF's option list; keep `slotExceedsClose` as belt-and-braces. Near-zero cost. |
| B — `WebOffer.Id + Options.Time` filter honored (P6 step 4) | Targeted verification probes for non-shortest options on surviving slots (~10-28 extra ≈ 1-2.5 s). Full-day stays optimistic (badges). |
| C — window search (StartAt≠EndAt) returns a feasibility-aware series (P4/P6 step 5) | Replace N point probes with 1-4 chunked window calls — the big win; every mode accurate cheaply. |
| D — no QAMF duration signal | Windowed necessary-condition filter over a memoized 15-min point-probe map: option kept only if the offer is present at EVERY 15-min step in `[T, T+minutes)` (sound rejection; residual false-positives caught at hold). Verify-by-hold ONLY at tap — **never display-time hold-probing** (hold-spam denies real guests, pollutes Conqueror). |
| E — P3 finds a trustworthy reservations-list endpoint | Compute occupancy ourselves (1 call/day, cached 60 s) — only if it reflects POS/walk-in truth. |

- Caching: per-request probe memo (mandatory); phase-2 optional Redis map keyed
  `avail:{centerId}:{date}:{players}` TTL 45-60 s, invalidated on successful hold/reserve.
  Preserve: batch 8, retry-once, all-fail → 502, `maxDuration = 30`.
- Consumer flips (opt-in param): offer-step successor (`useOfferSlots`), combos, World Cup,
  reschedule (+ pass `durationMinutes`). Tier badges stay optimistic (presence only). KBF
  (Game), v1 wizard, admin: untouched.

## 6. P0 quick fix — past times (ship first, standalone)

- **Server:** give `buildFullDayProbeTimes` the same now-floor targeted mode already has —
  `earliestMin = now + leadMinutes` when `startDate` is today (same post-midnight 24-26h
  handling, snap up to :15). Every full-day consumer (tier badges, widen, combos, KBF admin)
  inherits the fix, and fewer probes = faster.
- **Web classic `BowlingSlotsStep`:** grey/disable past hour chips for today (mirror the kiosk
  `nextQuarter` rule) — interim while classic steps live.
- **New flow:** server-guaranteed current + `pickFirstSlot` takes `nowMs`; kiosk passes
  `leadMinutes=0`, web 15.
- Unit tests: today vs future now-floor, post-midnight window, leadMinutes 0/15, DST offsets.

## 7. Probe plan — the tests to run from local dev (QAMF access)

One script: `apps/web/scripts/qamf-duration-probe.mts`, subcommand-driven
(`baseline|near-close|list-res|window|filter|blocked|hold-codes|latency|cleanup`), flags
`--center` (default Naples 3148) `--date` `--time` `--fixtures`. Conventions: `.env.local` +
per-center `mintToken` (copy `scripts/list-qamf-offers.ts`), offer/option ids read from Neon
(never hardcoded — Naples ids differ from FM), every write is a Temporary hold titled
`ZZZ API PROBE — auto-deletes`, deleted in `finally`, 10-min TTL backstop, never Confirmed.
`--fixtures` writes raw QAMF JSON to
`apps/web/src/features/booking/service/__fixtures__/qamf-availability/` for regression tests.
Run at quiet future weekday times; never against same-day evening slots.

- **P1 — baseline weboffers census** (read-only): `GET /centers/{3148,9172}/weboffers` — the
  authoritative optionId→Minutes map, whether 60-min options exist, option ordering.
- **P2 — near-close pre-check** (read-only): point probes at close−30/close−75 — does QAMF
  already drop the 120 option near close? (weak H3 signal; expected no).
- **P3 — reservations-list discovery** (read-only): `GET /centers/{id}/reservations` (+ query
  spellings, `POST .../reservations/search`, api-versions pinned/1.2/1.3). If 200: cross-check
  against Conqueror on a day with walk-ins/POS bookings — only useful if it reflects ALL
  occupancy.
- **P4 — window semantics** (read-only): `searchAvailability` with `EndAt = T+30m/+2h/+4h` —
  time series? granularity? latency scaling?
- **P5 — filter honoring** (read-only): same T, three variants — control · `WebOffer.Id` ·
  `WebOffer.Id + Options.Time:[{Id}]` — narrowed, ignored, or 400? (Requires extending
  `AvailabilityFilter` in `lib/qamf-bowling.ts` if productized.)
- **P6 — THE decisive blocked-window experiment** (write, self-cleaning): at Naples, VIP offer
  (smallest lane group), quiet future weekday, time T:
  1. Saturate the lane group over `[T+90, T+150)` with 60-min Temporary holds at `T+90` until
     QAMF 409s (record count = group size + exact 409 body).
  2. Control probe at `T+90` → VIP offer must be absent (proves saturation).
  3. Point probe at T (90 fits, 120 doesn't): does `Options.Time` drop the 120 option? →
     **branch A** if yes.
  4. `Id+Options` probe at T with the 120 option: absent/empty → **branch B**.
  5. Window probe `[T, T+150]`: does the series reflect the block? → refines **branch C**.
  6. `createReservation` at T with 120 → expect failure, capture status + error body verbatim
     (H4a vocabulary); with 90 → expect 201 → DELETE → confirm instant release.
  7. Cleanup all holds; re-verify `T+90` is free. Whole run inside the 10-min hold TTL.
  Group-disjointness check: probe a REGULAR offer during the block — still present ⇒ VIP/regular
  lane groups are disjoint; absent ⇒ shared lanes, rerun on the regular offer after hours.
- **P7 — hold lifecycle + error codes** (write, self-cleaning): double-book attempt vs
  duration-infeasible attempt — distinguishable error codes? create→delete round-trip time.
- **P8 — latency/rate envelope** (read-only): 8/16/32 concurrent point probes → p50/p95, any
  429/5xx → batch sizing for §5.

## 8. Defense in depth (ship regardless of probe outcome)

- New pure module `src/features/booking/service/duration-feasibility.ts` (+ colocated tests):
  `slotExceedsClose` (moved from the route), `resolveOptionMinutes` (DB-backed;
  Game/Unlimited → `null` = exempt), `optionBelongsToOffer`, `evaluateWindow` (branch-D check,
  pure over a supplied probe map).
- `src/features/booking/service/duration-guard.ts` — `assertBookable({centerId, webOfferId,
  optionId, optionType, bookedAt, players})`:
  - **Hold route** validates BEFORE `createReservation`: unknown/foreign option → 400
    `{code:"invalid_option"}`; doesn't fit → 409 `{code:"option_unavailable"}`; QAMF lane-fit
    failures mapped → 409 `{code:"slot_taken"}` (today: opaque 502). These codes are the UI's
    graceful-refresh contract.
  - **Reserve route**: fresh + fallback-fresh paths get the full guard; hold-first path gets a
    cheap config-only re-check (client controls `optionId` in the body independently of the
    hold).
  - **Reschedule**: `qamf-sync.ts` `rebookQamfForLaneChange` + the admin reschedule route call
    `assertBookable` (duration window, not just start instant).
  - Policy: fail-OPEN on probe errors (QAMF `createReservation` stays the final authority),
    fail-CLOSED on affirmative "doesn't fit".
- Hoist the duplicated `QAMF_TO_CENTER_CODE` map (availability route + fix-open-duration) into
  one shared const.

## 9. Data / config changes

1. `ALTER TABLE bowling_experience_offers ADD COLUMN IF NOT EXISTS duration_minutes INTEGER`
   (nullable, `ensureBowlingSchema()` pattern) + seed: pizza-bowl 120, fun-4-all 90,
   world-cup 150, KBF/midnight-madness NULL (Game/Unlimited). Without this the server cannot
   window-check fixed-duration packages. Surface as `qamfOfferDurationMinutes`.
2. Map the 60-min QAMF options found in P1 into `bowling_experience_duration_options` ONLY if
   the business wants to sell 1-hour bookings (owner question §12); otherwise document them in
   a seed comment.
3. Codify in comments + tests: **QAMF `Minutes` is never read for logic** — the route's
   remaining `t.Minutes` fallbacks switch to the DB map; unknown option ids are kept but logged
   (config drift signal).
4. Shared offer 154 (fun-4-all ↔ regular-mon-thur): all filtering keyed per-(offer, option) —
   sharing stays safe.

## 10. Test plan

**Unit (vitest, colocated):**

- `duration-feasibility.test.ts`: 90-fits/120-doesn't on a blocked-tail probe-map fixture ·
  exact-fit close boundary (end == close allowed, end > close stripped) · post-midnight 24-26h
  windows (120 min at 23:30 Fri) · DST both offsets · Game/Unlimited passthrough · fail-open on
  probe error / fail-closed on affirmative miss · `optionBelongsToOffer` rejects a foreign
  optionId.
- P0 now-floor tests: today vs future, post-midnight, leadMinutes 0/15.
- `availability-client`: no more longest-Minutes guess; `optionsVerified` plumbed from meta.
- Route-level test (`vi.mock("@/lib/qamf-bowling")` + fixtures): accurate-mode filtering, meta
  flags, 502-on-all-fail preserved, batch count.
- `bowling-offer.test.ts`: `buildBowlingLineItems` fixed-duration override + multiplier paths;
  `effectiveBowlingOptionId` precedence (Pizza Bowl guard).

**Fixtures / regression:** the probe script's `--fixtures` output — especially the P6
blocked-window before/after diff — becomes the permanent regression test proving the exact
production bug (2h shown when only 1.5h fits) is filtered.

**Live smoke checklist (owner, local dev + Vercel preview):**

1. Boundary-fit near close: at close−90, 1.5h offered / 2h absent; book the 1.5h end-to-end;
   Conqueror shows a 90-min block.
2. Blocked-tail: recreate P6's block (`blocked --no-cleanup`, then `cleanup`) → wizard at T
   shows 1.5h not 2h; a stale tab tapping 2h gets the graceful 409 refresh, not a dead-end.
3. VIP vs regular separation: block the VIP group only → regular still shows 2h at T.
4. KBF unaffected: wizard + `KbfAdminClient` slots identical pre/post (Game type).
5. Pizza Bowl fixed 120: at close−60 it disappears entirely (no silent 60-min fallback); at
   close−120 it books a true 120-min block.
6. Reservation-edit grow at a blocked tail → clean guard error, no orphaned QAMF state.
7. Combos: bowling-leg candidates honor the leg duration on a fragmented evening.
8. Cold start: first request after restart retries, not false sold-out.
9. **Past-time check: open web + kiosk at :17 past the hour — no slot ≤ now anywhere** (hour
   chips, hero, grid, tier badges, widen list).
10. New flow UX: exactly one time interaction on both surfaces; hero tap holds instantly; hold
    expiry modal still works; party-size change resets package + releases hold.

## 11. PR train + cutover + verification workflow

Flag `NEXT_PUBLIC_BOWLING_ONE_TIME_FLOW` (`src/features/booking/flags.ts`, house convention) +
`?bowlingV3=1` EntryContext preview param — honors the v2 cutover rule (ship dark alongside,
ops sign-off on preview, flip, delete).

- **PR0 — past-time quick fix** (§6). Standalone, fixes a live customer-facing bug.
- **PR1 — service extractions** (§4, zero behavior change) + `durationOptionId` field.
- **PR1.5 — defense-in-depth guards + schema/seed + probe script** (§8, §9, §7 script;
  behavior change limited to clearer 4xx codes on invalid picks).
- **PR2 — web v3 steps, dark** (Date/Experience/Time + shared components + `useOfferSlots` +
  registry wrappers + accurate-mode availability per selected probe branch).
- **PR3 — kiosk overlay, dark** (registry pass-throughs, `NATIVE_STEP_IDS`, date-at-creation,
  kiosk variants — inspect live kiosk DOM first).
- **PR4 — parity polish, dark** (VIP upsell port, Clarity tags, conflict marking, copy).
- **PR5 — flip** (flag default-on kill switch, web schema 2→3, kiosk 10→11) — only after the
  ops sign-off checklist on a Vercel preview: both centers, weekday + weekend hourly,
  fun-4-all + pizza-bowl, VIP + upsell, KBF incl. Friday cap, 7+ party / 2 lanes, late-night
  24-26h slots, hold expiry, full reserve + payment smoke.
- **PR6 — delete** classic steps (`BowlingSlotsStep`, `BowlingTierStep`, `BowlingOfferStep`,
  `KioskBowlingTimeStep`, `KioskBowlingTierStep`) + wrappers + flag's classic branch. Grep
  `bowlingTimeLabel|operatingHours|CENTERS` importers first.

**Every PR (owner requirement):** verify locally (`npm run dev -w fasttrax-web` walk-through,
then the WORKSPACE build `npx turbo run build --filter=fasttrax-web` — bare `next build` skips
the postbuild a11y gate and is not a verification, per lessons.md 2026-07-03) → push → smoke on
the **Vercel preview URL** (dark PRs with `?bowlingV3=1`) at desktop + mobile widths before
merge. The flip decision is made on a preview deployment, never on prod.

## 12. Risks

- **QAMF rate/latency:** P8 measures first; keep batch 8 + retry-once; Redis 60 s memo; badges
  stay optimistic. Watch `[avail]` logs for 429s post-launch. Vercel 30 s budget: branch D
  worst case ≈ 8 batches × p95 ≈ well inside; branch C reduces it.
- **Staleness vs "slot just filled":** display accuracy is stale the moment another guest
  holds — the hold/reserve 409 codes + grid refresh ARE the recovery contract. Never trade this
  for display-time hold-probing.
- **Naples:** all offer/option ids differ; lane-group sizes differ; run P1/P6 at both centers
  before enabling accurate mode for Naples. Probe script reads ids from Neon.
- **Unlimited (midnight-madness) / Game (KBF):** no duration — exemption must be explicit
  (`resolveOptionMinutes → null`) so future refactors can't 409 them.
- **World Cup:** 150-min fixed option rides the same accurate targeted probe; late-match
  kickoffs near close are exactly the boundary case — in the smoke list.
- **P6 misread:** if VIP/regular lane groups share lanes, the saturation diff is confounded —
  the disjointness check in §7 guards this.
- **Holiday hours:** our close hours come from `HP_LOCATIONS` strings; if Conqueror's schedule
  diverges, `slotExceedsClose` mis-strips — pre-existing risk, now load-bearing for durations.
  Follow-up: holiday-hours table.
- **Hold expiry mid-flow / party-size change / back-nav re-picks:** existing timer machinery
  unchanged; party-size reset patch extended to release the hold (today it orphans it);
  experience/duration change resets time + releases hold; every new hold releases its
  predecessor.

## 13. Open questions for owner (non-blocking)

1. "Offer screen looks dated" — read as BOTH the web offer step (vs the July race redesign) and
   its unstyled reuse inside the kiosk; the shared-component redesign covers both. Confirm.
2. P1 will surface QAMF 60-min options — do we WANT to sell 1-hour bookings? (Only then do they
   get mapped into `bowling_experience_duration_options`.)
3. Combos + World Cup deliberately untouched in this train — confirm.
4. Web lead time: keep 15 min (current default) or shorten? Kiosk goes to 0 per the 7/17 ASAP
   decision.
