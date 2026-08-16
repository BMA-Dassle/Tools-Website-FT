# Junior adjacency — enforce it inside BMI, for every channel

**Status:** plan. Mechanism proven live 2026-08-16; nothing built yet.
**Owner ask:** "every time we see a booked junior race, put a product limit on it
and each of the races next to it" — covering POS, kiosk and web.
**Same day must be live; future dates can be rolling.**

## Why this exists

`blue/mega-no-back-to-back-junior` in
[race-restriction-rules.ts](../apps/web/src/features/booking/service/race-restriction-rules.ts)
is `enabled: true` and blocks server-side — but only on **our** surfaces. The
register, the phone and BMI's own dayplanner never run it. Measured over 30 days
(7/18–8/16) with `apps/web/scripts/junior-heat-neighbor-audit.mts`:

| | |
|---|---|
| Race heats booked | 2,686 |
| Junior heats | 526 (507 Blue, 19 Mega) |
| Junior heats with a heat within ±13 min | 518 (98%) |
| **Back-to-back junior pairs that happened anyway** | **125 (~4.3/day)** |

Every adjacency is exactly ±12 min — the cadence. This is a real, daily leak,
and it is invisible to our code because it does not come through our code.

## The one design decision that matters

**The fence lives in BMI, so it protects all three channels the moment it is
set.** POS, kiosk and web all sell against BMI products; a product limit locked
on a heat is enforced by BMI itself.

So this is **not** three integrations. It is **one writer** that keeps BMI's
fences in sync with BMI's own bookings — reading `/bmi/sessions`, which is
downstream of all three channels.

Concretely: **do not** hook `patchHeatSetups` for web/kiosk and add a poller for
POS. That would be a dual-write to the same BMI entity, which
[lessons.md](lessons.md) forbids (ONE writer per BMI entity), and it buys
nothing — web and kiosk already enforce the rule in their pickers and their
booking service, so instant fencing there is redundant. The fence exists to
catch the register. A sweep alone is both simpler and complete.

The existing `race-restriction-rules.ts` rules **stay exactly as they are**.
They give the guest an instant, explanatory block in the picker. The BMI fence
is the backstop underneath them, not a replacement.

## Proven mechanism (live, 2026-08-16)

```
PATCH /v2/bmi/session/LAB52GY480CJF
  {track:"Blue", heatStart:"2026-08-16T15:36:00", productLimitId:53253885}
→ 200 {sessionId:58598953, name:"24 - Adult Only", styleId:null,
       updated:["name","productLimit"]}
```

- Limit `53253885` = **"Adult Only"** — re-scoped by ops that day to admit adult
  Starter, Intermediate **and** Pro, so it means exactly "no juniors". With the
  old scope it would have refused 48 adult Pro bookings in 30 days; with the new
  one it refuses **211, all junior, zero adult collateral**.
- `level`/`junior` were `required` until ops shipped a Pandora change the same
  day; `required` is now `["track","heatStart"]`. Sending the limit alone applies
  **no style** (`styleId:null`) — the slot is fenced without being configured as
  a race.
- The heat surfaces as `"<heatNumber> - Adult Only"`. Since **no endpoint reads a
  heat's product limit back**, that name is our only readable marker.

## Finding the slots — no availability API needed

Heat numbering is a pure function of the grid: **`heat n = open + (n−1) × 12`**,
with `open` from `fasttraxWeekHours(date)`. Verified against all 13 booked Blue
heats on 8/16 (heat 15 = 13:48, heat 24 = 15:36).

Empty heats are simply **missing** from `/bmi/sessions`. So a gap in the heat
numbers *is* the list of fenceable slots — one cheap GET per day gives both the
junior heats and the empty neighbours.

Tracks: **Blue and Mega only.** Red has no junior products
(`race-products.ts`), so it can never need a fence.

## Algorithm (one pass, one date)

1. `GET /bmi/sessions` for the date → booked heats; parse `# - Track [GF] [Junior] Level`.
2. Derive the day's grid from the hours registry; gaps = empty slots.
3. `desired` = for every booked **junior** heat, its ±1 slot neighbours **that
   are empty**.
4. `fenced` = empty heats already named `<n> - Adult Only`.
5. **Add** = `desired − fenced` → PATCH each with `productLimitId`.
6. **Remove** = `fenced − desired` → the junior booking that justified the fence
   is gone. **Log only — do not execute.** See the open question below.

Idempotent by construction: step 4 means a second run in the same minute writes
nothing.

## Cadence

| Sweep | Schedule | Scope |
|---|---|---|
| `/api/cron/junior-fence-sweep` | `* * * * *` | **today only** — "live" |
| `/api/cron/junior-fence-rolling` | `*/10 * * * *` | one future date per run, rotating over the next 14 days |

Rotating the rolling sweep keeps each invocation to a single `/bmi/sessions`
call; 14 days get covered every ~140 min. Both share one service function
differing only in which date(s) they pass.

Follow the house cron shape ([race-state-watch](../apps/web/app/api/cron/race-state-watch/route.ts)):
`verifyCron`, `export const dynamic = "force-dynamic"`, `maxDuration`,
`?dryRun=1`, and **log only when something changed** — a minute of "nothing to
do" all evening would bury everything else.

## Guardrails (each one is from something already observed)

- **Re-check emptiness immediately before every PATCH.** On 8/16, 13:48 was
  booked during the 24 min we waited on a deploy — the exact slot being fenced.
  The probe's guard caught it and aborted. The sweep will lose races too; it must
  lose them safely.
- **Never PATCH a heat that has anything booked in it.** Locking a limit onto a
  live party's heat could block their own add-ons at the register.
- **Cap writes per run** (~20). A bug must not be able to carpet the dayplanner.
- **Kill switch, default ON** per the flags rule: `!== "false"`, never an opt-in
  gate.
- **Mirror every write to `bmi:api:log`**, exactly as
  [session-setup.ts](../apps/web/src/features/booking/service/session-setup.ts)
  does, since there is no other way to audit what we fenced.
- Reuse `gapMinutes: 13` / cadence from the rule config — do not hardcode 12 in
  two places.

## What the real boards taught (found while building, 2026-08-16)

Two assumptions died against the fixtures, both caught before any server code:

1. **BMI's heat numbering origin is not the day's open, and it varies by day.**
   On 8/16 the offset was 0 (heat 24 = slot 24); on 8/3 it was **+10** for every
   row (heat 13 sat at 13:24, slot 3, on a 13:00 open). Deriving a slot from a
   heat number would have silently mis-targeted ten slots. Time is the only
   identity — matching the existing lore that `heatNumber` is display, never
   identity. The plan reports `numberOffsets`; more than one value in a day
   means the numbering drifted and the log deserves a look.
2. **One physical block can carry several session rows.** 8/3 has
   `47 - Blue Junior Starter`, `… (2)` and `… (3)` all at 20:12. The planner
   collapses per slot, preferring a junior row (if any row on a slot is junior,
   the slot is junior) so adjacency can't be missed, and reports
   `duplicateSlots`.

## Open — must be settled before the rolling sweep ships

1. **Does a PATCH reach a slot on a date BMI has not materialised yet?** Every
   successful test has been on the current day. Future dates return zero
   sessions. If they 404, the rolling sweep cannot fence in advance, and an
   advance POS booking stays unprotected until its day comes up — by which point
   both juniors may already be booked. One command answers it:
   `npx tsx apps/web/scripts/_bmi-product-limit-probe.mts --slot Blue:2026-09-09T18:00:00 --limit-only --write`
   **Design so this degrades gracefully:** treat a 404 as "day not materialised,
   retry later", not an error. Then the same-day sweep works regardless and the
   rolling one self-heals the moment future writes become possible.
2. **How is a limit removed?** Nothing documents it, and no endpoint reads one
   back. Until this is known, step 6 logs and does not execute — meaning a
   cancelled junior booking leaves its fences standing. Ops must be able to clear
   one by hand in the dayplanner in the meantime.
3. **Does a fence survive a booking?** When a party books a fenced heat,
   `session-setup.ts` re-PATCHes `level`+`junior` while omitting
   `productLimitId`, which per the contract leaves the limit in place — so the
   limit persists but the `- Adult Only` name marker is overwritten. Inferred
   from the contract, not tested. If true, a booked-then-cancelled heat can carry
   an invisible limit.

## Build order

- [ ] Answer open question 1 (one probe command, ~1 min)
- [x] `src/features/racing/junior-fence.ts` — pure: given booked heats + date,
      return `{ add[], remove[] }`. No network. tsc + eslint clean.
- [x] Unit tests off two REAL captured boards — 19 passing.
      `__fixtures__/blue-heats-2026-08-16.json` (live, offset 0, carries the
      hand-placed fence) and `blue-heats-2026-08-03.json` (worst adjacency day
      in the audit, offset +10, three rows on one block).
- [ ] `junior-fence.server.ts` — fetch, re-check, PATCH, cap, log
- [ ] Two cron routes + `vercel.json` entries (60 → 61 crons)
- [ ] Ship with the kill switch ON, watch `bmi:api:log` for a day
- [ ] Re-run `junior-heat-neighbor-audit.mts` after a week — the 125 pairs/30d
      should fall toward zero. That is the acceptance test.

## Scripts already written (uncommitted, `apps/web/scripts/`)

- `junior-heat-neighbor-audit.mts` — read-only; the measurement above and the
  acceptance test
- `_bmi-product-limit-probe.mts` — `--slot`, `--limit-only`, `--write`; the
  emptiness guard here is the one the sweep needs
