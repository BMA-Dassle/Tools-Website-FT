# Lane Arrangement Engine — PLAN

**Status:** planning → building, 2026-08-24. Branch `worktree-lane-arrangement`.
**Owner scope decisions (2026-08-24):** auto-pin everywhere (not recommend-only) · FastTrax
11542 gets BOTH live pinning and the pre-day rearranger · HeadPinz FM 9172 gets the pre-day
rearranger ONLY (no live pinning yet) · every surface must be switchable on/off **in the
database at any time** · no house rules beyond the lane groups already derivable from history.

**Owner's stated correctness bar:** *"making sure it honors things that are already booked
that are not in our database."* That single sentence is why the grid is built from QAMF
`reservations/search`, never from `bowling_reservations` — see §3.

---

## 1. Problem — measured, not assumed

**We do not choose lanes today.** `NewReservationInput.Lanes` exists in `lib/qamf-bowling.ts`
but no caller populates it, so QAMF auto-assigns at all 11 `createReservation` sites.

HeadPinz FM (9172), 28 lanes / 14 pairs, four Saturdays:

| | Aug 1 | Aug 8 | Aug 15 | Aug 22 |
| --- | --- | --- | --- | --- |
| peak lanes in use | 25/28 | 25/28 | 27/28 | 23/28 |
| prime 5-11pm utilisation | 67.6% | 71.0% | 71.3% | 67.7% |
| single-lane bookings | 79 | 88 | 78 | 89 |
| **…started next to another party** | **55 (70%)** | **63 (72%)** | **51 (65%)** | **53 (60%)** |

**78% of reservations are single-lane** (428 sellable across the four days: 334 one-lane, 70
two-lane, 13 three-lane, 7 four-lane, 4 sixteen-lane). Party sizes cluster 3-4 (133) and 5-6
(124) — one lane each. Average lane duration 88 min.

So the owner's spread rule governs nearly four fifths of the book, and today it is violated
about two thirds of the time **while whole pairs sit empty** (Aug 22 peak: 11 full pairs,
1 half-used pair, 2 pairs untouched).

Naples (3148) inverts on quiet nights — 20 of 22 singles spread on Aug 1, 17 of 22 on Aug 15.
QAMF's auto-assign spreads when the house is empty and stops once density rises. That is
exactly the regime the owner's rule is about.

**Verified physical facts** (not assumed): lanes are odd-even pairs — 98.5% of FM and 98.8%
of Naples two-lane bookings land on a true pair (1-2, 3-4), not straddling. Each web offer is
already confined to a Conqueror lane group: FM VIP offers 155/159 only ever touch lanes 5-12;
Naples VIP 119/125 only 25-32.

## 2. Lead time — why the two surfaces get different weight

FM Saturdays, `BookedAt - CreatedAt`, n=428:

| walk-up <15m | <1h | 1-4h | 4-24h | 1-3d | 3-14d | 14d+ |
| --- | --- | --- | --- | --- | --- | --- |
| 13.8% | 19.2% | 27.6% | 15.7% | 10.0% | 11.0% | 2.8% |

**76% of the book is same-day. Only 23.8% is on the books 24h+ ahead.** The live path carries
the volume; the pre-day rearranger works a smaller set skewed toward the multi-lane parties
that actually need adjacency. Build the live path first, but the owner's pilot split
(FastTrax live, FM future-only) means both ship together.

## 3. The grid is QAMF, never Neon — the owner's correctness bar

`POST /centers/{id}/reservations/search` @ `api-version: 1.4`, filter shape
`{Filter:{Lanes:[{StartTimeRange:{StartAt,EndAt}}]}}`. Verified live on all three centers
2026-08-24. Returns every booking with `Source` (`Web|Kiosk|Conqueror|ExternalApi`),
`Status`, `Type.Description`, `WebOffer.Id`, and per-lane `LaneNumber`/`StartTime`/`EndTime`/
`Minutes`/`Players[]`.

**Neon cannot be the source of truth.** `bowling_reservations` only learns about a Conqueror
booking when its lane OPENS (`bowling-events-consumer` / `bowling-lane-poll` stamp
`booking_source='conqueror'`). Anything that never opened, plus every league / maintenance /
non-bookable block, is invisible to us. On FM Aug 22 that was **56 of 130 reservations**, and
`Type` values included `League` (8 lanes, 09:00-11:30), `Maintenance` and `Non-bookable`.

Grid rules:
- Window must be widened by `MAX_SESSION_MINUTES` (~180) on the leading edge — search returns
  reservations whose lane *starts* in range, so a session already running is otherwise missed.
- Every `Status` except `Canceled` / `NoShow` occupies its lane.
- Every `Type` occupies its lane. Leagues and maintenance are not sellable but they are busy.
- Pair with `GET /centers/{id}/lanes` for the live floor: `Status` `Open|Closed|Error`
  (**Closed = free and ready**, not broken), plus `ClosedAt`, `RemainingGames`,
  `Reservation.Id`. For a lane opened directly in Conqueror `ClosedAt` is an *estimate*.

**Lane groups are invisible to the API.** No endpoint returns them; the only signal is a
409 `LanesNotCompatible`. Derive `offer -> allowed lanes` from 90 days of search history,
allow a DB override, and treat a 409 as "try the next candidate".

## 4. Design — one engine, three callers

```
apps/web/src/features/lane-plan/
  types.ts         LaneGrid · BusyInterval · PlanRequest · LanePlan · LanePolicy
  grid.ts          PURE: isFree, freeRuns, occupancyAt, pairState, place
  grid.server.ts   buildGrid(centerId, window) — QAMF search + listLanes
  lane-groups.ts   offer -> allowed lanes, from history + DB override
  forecast.ts      walk-in pressure per weekday/time-of-day, from history
  score.ts         PURE: the scoring terms
  policy.ts        chooseLanes(grid, request, policy) -> ranked candidates
  config.ts        DB-backed per-center mode
  data/            lane_plan_config, lane_plan_decisions
```

Everything except `grid.server.ts`, `config.ts` and `data/` is pure and unit-tested against
fixtures captured from real days.

### The core idea: pressure is FORECAST, not current

At 2pm Saturday FM sits near 40%; by 8pm it is 96%. Spreading a 2pm single that ends at 4pm
costs nothing — it is over before the rush. Spreading a 6pm single burns a fresh pair straight
through the crunch. So the engine scores against **projected occupancy across the window the
booking will actually occupy**: already-booked reservations from the grid, plus a walk-in
forecast learned per weekday × time-of-day from search history. This is where "learn from
previous reservations, availability and kiosk walk-ins" earns its keep.

### Scoring terms — the owner's rule, stated directly

For a request needing `k` lanes over `[start, end)`, enumerate every placement that is free for
the whole window and inside the offer's lane group, then score:

- **Neighbour buffer** — reward a placement whose adjacent lanes are free for the window.
  Dominant when projected pressure is low. This is "people hate being right next to each other".
- **Pair integrity** — `k=1`: prefer a lane whose pair-mate is free (seeds a clean pair).
  `k=2`: strongly prefer a true odd-even pair over straddling two pairs.
- **Fragmentation penalty** — penalise a placement that chops a contiguous free run into
  pieces too small for a known large-party profile. This is "save the other 8 for bigger
  reservations".
- **Backfill flip** — once projected occupancy for the window crosses `backfillThreshold`,
  the buffer term **inverts**: completing a half-used pair now beats opening a fresh one.
  This is "after you get 8 of those on 16 lanes you start backfilling".
- **Lane health** — never place on `Status: Error`; deprioritise a lane whose current session
  is estimated to run late (`ClosedAt` near our start).

Weights live in `lane_plan_config.policy` JSONB so they are tunable without a deploy.

### Cadence — ONE operation, run at three moments (owner refinement 2026-08-24)

Owner's insight: don't pin anything booked days ahead — let QAMF assign it, and re-solve the
board as the day approaches. The data supports it. A lane chosen 14 days out is optimised
against an essentially empty grid; by the day, 76% of the book has arrived around it. And
QAMF's default already keeps a party's OWN lanes together (98.5% land on a true pair) — what
it fails at is separation BETWEEN parties, which only matters once the house fills.

The refinement: **there is only one operation — "re-solve today's board".** Placing one new
same-day booking is that same operation with one reservation added, not a second system.

| Moment | What runs | Why |
| --- | --- | --- |
| Booking for a FUTURE date | nothing — QAMF assigns | nothing to solve against; it gets swept on its own morning |
| Morning sweep (~08:00 ET) | re-solve the whole known book for today | big multi-lane parties seated properly and spread while the board is quiet |
| Same-day create | re-solve with the newcomer added → pin `Lanes[]` | kiosk / web same-day / front desk — the 76% |
| Rolling re-sweep (hourly) | re-solve, move only unopened + un-checked-in | keeps morning decisions honest as the house fills |

**Threshold: the sweep owns TODAY. A create pins only if the booking is for today.** Simpler
than a "2 days out" rule and equivalent in volume — the 1-3d bucket is only 10% of the book.

**Why a morning-only run is not enough.** At 08:00 only ~40% of that evening's bookings exist
(the 4h+ lead buckets: 15.7 + 10.0 + 11.0 + 2.8). The other ~60% arrives after the sweep —
27.6% at 1-4h lead, 19.2% under an hour, 13.8% pure walk-up. Without same-day placement and
the rolling re-sweep, the 09:00 spread decisions are stale by 20:00.

**A re-sweep is strictly lower risk than pin-at-create**: it never touches the booking path,
only moves unopened reservations, and failing open costs nothing. So a center can run sweeps
with its create path completely untouched — which is how HeadPinz FM should start.

### Callers

1. **Sweep** (`re-solve today`) — morning cron + hourly cron + on-demand admin button.
   Moves via `moveReservationLanes`. FastTrax 11542 and HeadPinz FM 9172.
2. **Pin at create** — hold/reserve routes populate `NewReservationInput.Lanes`, same-day
   bookings only. FastTrax 11542 only, per owner scope.
3. **Live chooser** — staff screen: real lane grid, engine recommendation highlighted,
   one-tap manual override. Read + explicit move only.

**Guest-invisible.** `bowling-lane-ready-notify.ts` deliberately omits the lane number from
the SMS ("guests will walk to it before staff is ready"), so any re-arrangement before
lane-open costs nothing in guest comms. Sweeps may run as often as we like.

**Sweep eligibility.** A reservation may be moved only if: not `Completed`/`Canceled`/`NoShow`,
its lane is not `Open`/`Running`, no `dayof_order_sent_at` (lane-open not processed), and its
start is far enough out to beat the vendor's propagation lag. Everything else is frozen.

## 5. Database — ops-flippable at any time

```sql
CREATE TABLE lane_plan_config (
  center_id    INTEGER PRIMARY KEY,          -- QAMF center id
  create_mode  TEXT NOT NULL DEFAULT 'off',  -- off | shadow | live  (pin at create)
  future_mode  TEXT NOT NULL DEFAULT 'off',  -- off | shadow | live  (pre-day rearranger)
  policy       JSONB NOT NULL DEFAULT '{}',
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE lane_plan_decisions (
  id                  SERIAL PRIMARY KEY,
  center_id           INTEGER NOT NULL,
  qamf_reservation_id TEXT,
  surface             TEXT NOT NULL,   -- create | rearrange
  mode                TEXT NOT NULL,   -- shadow | live
  decided_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  window_start        TIMESTAMPTZ,
  window_end          TIMESTAMPTZ,
  lanes_wanted        INTEGER,
  chosen_lanes        INTEGER[],       -- what the engine picked
  actual_lanes        INTEGER[],       -- what QAMF ended up with
  score               JSONB,           -- per-term breakdown, for tuning
  outcome             TEXT,            -- applied | shadow | rejected_409 | fallback | error
  detail              TEXT
);
```

`lane_plan_decisions` is both the shadow-mode evidence and the tuning corpus.

**On the flags hard rule.** CLAUDE.md forbids opt-in feature gates. This is a DB kill switch,
not an env opt-in: rows ship seeded to the owner's chosen production state (FastTrax
`create_mode='live'`/`future_mode='live'`, FM `future_mode='live'`, Naples `off`), and ops can
flip any of them to `off` instantly. `shadow` is a time-boxed verification phase with the exit
criterion in §6, not an indefinite dark flag — it is the "deploy alongside, let ops sign off"
step the v2 cutover rule already mandates.

## 6. Verification — three layers, in order

The owner's bar is that we honour bookings we cannot see in our own DB. Prove it three ways.

1. **Live grid cross-check** (read-only, run any time). Build the grid for *now*, compare
   against `GET /lanes`. Any lane reported `Open` that the grid thinks is free is a grid gap;
   any lane the grid thinks is busy that is `Closed` with no reservation is a stale interval.
   Ships as a script AND an admin health tile. **Exit criterion for shadow → live: zero gaps
   across a full weekend at the pilot center.**
2. **Backtest** (read-only). Replay N past days from search history; assert no two live
   reservations ever overlap on a lane in our reconstruction, and that each real booking's
   lane was free in the grid built from what was known beforehand. Catches window and
   timezone bugs — the `PATCH /lanes` centre-local wall-clock trap is a known one.
3. **Vendor backstop probe** (WRITE — needs owner OK, quiet future slot, Temporary holds
   titled and deleted in `finally`). Pin a hold to a lane the grid says is **busy**.
   - QAMF 409s ⇒ the vendor is our safety net; fail open confidently.
   - QAMF accepts the double-book ⇒ **no safety net**; the grid must be perfect and the
     pre-write re-read plus Redis lock in §7 become load-bearing.
   **This must be answered before FastTrax goes live.**

Plus unit tests on the pure modules against fixtures from real days, including the ugly cases:
a league blocking 8 lanes, a maintenance block, a session already running at window start.

## 7. Safety rules

- **MOVE ONLY — NEVER DELETE. (Owner hard rule, 2026-08-24.)** Lane changes go through
  `moveReservationLanes` (`PATCH /reservations/{id}/lanes`, api-version 1.3) and nothing else.
  `rescheduleQamfReservation` in `booking/service/qamf-reschedule.ts` falls back to
  delete+create when the in-place PATCH fails — **this feature must never call that path and
  must never call `deleteReservation`.** A failed PATCH means we leave the reservation exactly
  where it is and log it. Rationale: a delete+create loses the reservation id, the Conqueror
  title, any front-desk edits, and can leave a "Canceled" tombstone on the grid; a lane
  *preference* is never worth that risk.
  - Same `StartTime`/`EndTime`, new `LaneNumber` = pure lane swap. Never vary the times.
  - Every lane on the reservation must be sent; QAMF rejects duration changes here.
  - Send **center-local wall clock with the true offset** — the PATCH reads the wall-clock
    portion as center-local and ignores the UTC offset. A Z-rendered instant lands hours off.
  - Verify against a **delayed** re-read; the GET straight after a PATCH echoes what you asked
    for, so a same-moment verify false-passes.
- **Fail open, always.** Search fails · no candidate · 409 `LanesNotCompatible` · lock
  contention · any error ⇒ drop `Lanes` and let QAMF auto-assign. A lane *preference* must
  never cost a booking. Every fallback writes a `lane_plan_decisions` row.
- **Re-read before every write.** Front-desk staff move people in Conqueror without telling
  us; the engine must never trust its own last plan.
- **Redis lock** `laneplan:{centerId}:{lane}:{windowBucket}` held across create, so two
  simultaneous bookings cannot target the same lane.
- **Never touch a Running/Open lane.** Reservations stop being mutable once opening starts.
- `deleteLanePlayer` remains broken center-side (price-key identity 409) — this feature must
  not depend on it.

## 8. PR train

- **PR1** — `lane-plan` pure core (types, grid, score, policy, lane-groups) + fixtures + unit
  tests. No routes, no writes, no behavior change.
- **PR2** — `grid.server.ts`, `lane_plan_config` / `lane_plan_decisions`, the live grid
  cross-check script + backtest. Read-only; shadow logging only.
- **PR3** — the retrospective admin report: "could we have packed more?" per day, per center.
  Answers the owner's original question directly and is the shadow-mode evidence surface.
- **PR4** — pin-at-create wired into the FastTrax hold/reserve paths, seeded `shadow`.
  Vendor backstop probe (§6.3) runs before flipping to `live`.
- **PR5** — pre-day rearranger: day view, diff, apply, nightly cron. FastTrax + FM.
- **PR6** — live chooser staff screen.

## 9. Open

- §6.3 vendor backstop probe needs owner OK (production write, Temporary holds only).
- Walk-in forecast starts as a simple weekday × 15-min-bucket historical mean; revisit only if
  the shadow numbers show it is the limiting factor.
- `CheckInAt` is not a real arrival stamp (428/428 FM reservations read "at or before slot"),
  so no punctuality signal is available for predicting late-running lanes beyond `ClosedAt`.
