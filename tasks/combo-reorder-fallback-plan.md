# Combo Reorder Fallback (race → race → bowl) — Plan

**Status:** BUILT 2026-06-23 — flag-gated `NEXT_PUBLIC_COMBO_REORDER_FALLBACK` (default OFF,
ships dark). · **Owner ask:** 2026-06-23 (Eric)
**Feature area:** Ultimate VIP combo (`apps/web/src/features/combos/*`)

**Landed:** engine `minWaitMinutes` (combo-itinerary), registry `fallbackComponents`/`fallbackNote`

- `legKey` + flag (combo-specials), `candidatesForOrdering` reindex (combo-booking), grid+modal
  prefer-normal-then-fallback with a "Races first" badge (ComboSteps), order-aware reservation memo
  (comboReservationNote + unified-reserve `comboReorder` stamp + confirmation page), order-aware
  staff email with a manager scheduling notice (combo-notify), order-aware reservations admin card
  (ReservationsClient). Tests in combo-itinerary.test.ts + combo-specials.test.ts (62 pass).

## 1. Problem

The Ultimate VIP combo runs a fixed itinerary: **Starter race → 90-min VIP lane (must
start within 60 min of the race) → Intermediate race.** The start grid offers 2/4/6/8/10 PM,
greying any hour where that full chain can't be assembled.

On days the VIP lanes are partly occupied, this greys legitimate slots. Verified live for
**6/23 (Mega Tuesday)** — Have-A-Ball owns the VIP lanes 4:00–8:30 PM, so QAMF returns VIP
90-min lanes only at **1:00–3:30 PM** and **9:00–10:30 PM**:

| Start | Normal (race→bowl→race)                       | Why                                                                       |
| ----- | --------------------------------------------- | ------------------------------------------------------------------------- |
| 2 PM  | ✅ Starter 2:00 → bowl 2:30–4:00 → Inter 4:36 | uses the afternoon VIP window                                             |
| 4 PM  | ❌                                            | VIP blocked 4–8:30; no lane within 60 min                                 |
| 6 PM  | ❌                                            | same                                                                      |
| 8 PM  | ❌                                            | Starter 8:48 → bowl 9:30–11:00 would need a race after 11 PM (none exist) |
| 10 PM | ❌                                            | bowling would run past midnight close                                     |

Only 2 PM survives normal ordering — even though the **9:00–10:30 PM** lanes are wide open.

## 2. The fix

When the normal ordering can't assemble a chain for a start-hour, try an **alternate ordering**
— **Starter race → Intermediate race → VIP lane** — and offer the slot if (and only if) it fits.
Normal ordering is always preferred; the reorder is a flagged fallback, never the default.

This puts the two races back-to-back up front and the lane last, so a slot whose only free lane
is _well after_ the races (the post-league 9 PM+ window) can still complete.

### Constraints (owner-specified, all registry-tunable)

The reorder is gated by three gaps so it only produces good schedules:

1. **Min race→race gap (`minWaitMinutes`, new):** ≥ **20 min** between Starter end and
   Intermediate start — "at least one more session between the races" so racers aren't crammed
   back-to-back (a real heat session runs in the gap).
2. **Max race→race gap (`maxWaitMinutes`):** ≤ **45 min** — prevents the engine from stranding
   the party between races when heats are sparse (e.g. Mega has no Intermediate heats 6–8 PM, so
   a 6 PM Starter has no Intermediate within 45 min → 6 PM correctly stays greyed instead of
   producing a 2-hour gap).
3. **Max race→bowl gap (`maxWaitMinutes` on the lane leg):** ≤ **45 min** between Intermediate
   end and lane start — caps the wait before bowling. (30 min is too tight: lanes sit on a
   :00/:30 grid, so the first bookable lane after a ~9:25 race is 10:00 ≈ 41 min later.)

**Worked example (6/23, 8 PM, caps above):**
`Starter 8:48 → [9:12 session] → Intermediate 9:24 → VIP bowl 10:00–11:30 PM` ✅
(bowling ends before the midnight close). Tonight this recovers **8 PM** and nothing else —
exactly the intended scope.

## 3. Registry changes — `combo-specials.ts`

Add to `ComboLeg`:

```ts
/** Minimum idle gap BEFORE this leg (from prev leg's end), minutes. Pairs with
 *  maxWaitMinutes to bound a gap on both sides. Used by the reorder fallback to
 *  force "at least one session" between back-to-back races. */
minWaitMinutes?: number;
```

Add to `ComboSpecial`:

```ts
/** Alternate leg ordering tried ONLY when the primary `components` ordering yields
 *  no feasible chain for a start-hour. Same anchor leg (leg 0) as `components` so
 *  the customer still picks the same start time. Absent = no fallback. */
fallbackComponents?: ComboLeg[];
/** Short note shown on a slot that resolved via the fallback ordering. */
fallbackNote?: string;
```

Ultimate VIP (`race-bowl`) gets:

```ts
fallbackComponents: [
  { kind: "race", tier: "starter" },
  { kind: "race", tier: "intermediate", minWaitMinutes: 20, maxWaitMinutes: 45 },
  { kind: "bowling", durationMinutes: 90, vip: true, maxWaitMinutes: 45 },
],
fallbackNote: "Both races run first, then your VIP lane — your lane time opens later tonight.",
```

`components` (the normal ordering) is unchanged. Leg 0 is `starter` in both, so the start grid's
semantics are identical.

## 4. Engine changes — `combo-itinerary.ts`

`buildChainFrom` / `buildChains` gain an optional `minWaitMinutes?: Array<number | null | undefined>`
(index-aligned, entry 0 ignored, mirrors `maxWaitMinutes`). The candidate predicate becomes:

```ts
const floorMs = prevEnd + Math.max(transitionMs, (minWait ?? 0) * 60_000);
const latestStart = maxWait != null ? prevEnd + maxWait * 60_000 : Infinity;
// pick earliest candidate with startMs >= floorMs && startMs <= latestStart && (!filter || filter(c))
```

**Greedy-earliest stays optimal:** a `minWait` only raises the lower bound; the earliest candidate
≥ floor still ends no later than any other valid pick, so it can never push a later leg past its
window (same argument the existing `maxWait` proof uses). No change to the public chain shape.

## 5. Candidate assembly — `combo-booking.ts` + `ComboSteps.tsx`

No new vendor calls. `fetchComboLegCandidates` already returns one candidate array per leg of
`components` (`[starter, bowling, intermediate]`). The fallback ordering uses the **same three
arrays, reindexed** to `[starter, intermediate, bowling]`. Build a small helper that maps a
components list to its candidate arrays from the already-fetched set (keyed by leg identity:
race-tier / bowling), so both orderings are assembled from one fetch.

## 6. Grid + UI — `ComboSteps.tsx`

- Compute `chainsNormal = buildChains(normalLegs, transition, normalMaxWaits)` and, when
  `combo.fallbackComponents` exists, `chainsFallback = buildChains(fallbackLegs, transition,
fallbackMaxWaits, fallbackMinWaits)`. Both anchor on the same Starter candidates.
- In `gridCells`, per start-hour/track: `pick = normalChainForAnchor ?? fallbackChainForAnchor`.
  Tag the cell with `ordering: "normal" | "fallback"`.
- A fallback cell is **available** (clickable) but carries a small badge ("Races first") and the
  `fallbackNote` so the guest understands the non-standard order. Greyed only when _neither_
  ordering fits.
- `ScheduleConfirmModal` receives the cell's active ordering (its components + reindexed leg
  candidates) so the itinerary list, the Red/Blue track picker, and `buildChainFrom` all operate
  in the correct order.

## 7. Booking + memo

- `confirmChain` is already order-agnostic for the writes — it iterates the chain, booking race
  heats and configuring the bowling item by `payload.kind`, not by position. The chain's times
  differ; the booking calls don't. **No change needed to `bookHeatsOnAdvance` / `holdComboBowling`.**
- `comboReservationNote(combo, lane)` is order-driven (it maps `combo.components`). Add an optional
  `componentsOverride?: ComboLeg[]` param; the confirmation page passes the **active ordering** so
  the staff memo reads `1) Starter Race -> 2) Intermediate Race (ONLY IF QUALIFIED) -> 3) VIP
Bowling` in fallback order. The "if a racer doesn't qualify" line is unaffected.
- Qualify gating note ("qualify in Starter to unlock Intermediate") still applies — Intermediate
  is immediately after Starter in the fallback, which is fine.

## 8. Pricing

Unchanged. Flat per-person price + the Model-A revenue split are order-independent.

## 9. Tests (`combo-specials.test.ts` / a new `combo-itinerary` test)

- `minWaitMinutes` floors a leg's earliest pick; greedy-earliest still finds a chain when one
  exists and returns null when the min/max window is empty.
- Reorder prefers normal: when both orderings fit an anchor, the cell uses normal.
- 6/23 Mega fixture (afternoon + 9 PM-only lanes, real heat times): normal yields only 2 PM;
  with the fallback, 8 PM resolves to `8:48 → 9:24 → 10:00–11:30`, and 6 PM stays greyed
  (no Intermediate within the 45-min cap).
- Bowling-past-close is still rejected (10 PM stays dead).

## 10. Rollout

- Flag-gate behind the existing combo flag pattern (e.g. `NEXT_PUBLIC_COMBO_REORDER_FALLBACK`,
  default off until ops signs off), so we can ship dark and flip per the v2 cutover safety rule.
- Smoke: one live end-to-end on a Mega Tuesday — book the recovered 8 PM fallback slot, confirm
  the two heats + the 10 PM VIP lane hold, and verify the staff memo shows the reorder.

## 11. Notes / out of scope

- **No over-sell bug.** Today's probe confirms QAMF availability _does_ reflect the Have-A-Ball
  lane block (it returned the 4:00–8:30 PM gap), so the booking site won't sell a lane the league
  occupies. The earlier "is it over-selling?" concern is resolved — availability is per-day accurate.
- 10 PM is unrecoverable on Mega Tuesday (any 90-min lane after a 10 PM race pair runs past the
  midnight close). Not in scope.
- Root-cause alternative to all of this: open the VIP Mon–Thu lanes earlier / move the league off
  the VIP lanes in Conqueror. That restores the _normal_ (nicer, bowling-in-the-middle) ordering
  with no code — but it's an ops/scheduling change, not always possible (e.g. a booked league).

```

```
