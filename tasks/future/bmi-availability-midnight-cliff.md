# BMI availability midnight cliff — kiosk/web attractions go dark 12 AM–close

**Status: INVESTIGATED, root cause confirmed live. No fix yet — this doc is the anchor for the future fix.**

## Symptom (observed live 2026-08-01 ~12:16 AM ET, HeadPinz FM kiosk)

At 12:16 AM the kiosk landing showed **"Nothing left to book today — the front desk can
help with walk-ins."** on the Nexus Laser Tag and Nexus Gel Blaster tiles (racing,
duckpin, Shuffly, KBF also locked), while the BMI dayplanner for business day 7/31
showed OPEN bookable arena blocks at 12:30 AM, 12:45 AM, 1:00 AM, and 1:15 AM.
Bowling was fine ("NEXT LANE · 12:30 AM").

## Root cause (vendor-side, probed and confirmed at 12:20 AM ET)

**BMI's public-booking `/availability?date=YYYY-MM-DD` treats the queried date as PAST
at calendar midnight (center-local) — NOT at the ~2 AM business-day close its own
dayplanner uses.**

Probe evidence (`apps/web/scripts/probe-bmi-midnight-cliff.mts`, run 8/1 12:20 AM ET):

| Query | Result |
| --- | --- |
| `date=2026-07-31` (the still-running business day) — laser 8976685 / gel 8976680, page 24909729 | HTTP 200, `{"proposals":[]}` |
| `date=2026-08-01` (next business day) | 54–56 proposals, blocks `2026-08-01T11:00` → `2026-08-02T01:30`, freeSpots=14 |

The `date=8/1` response proves BMI happily proposes post-midnight blocks — as long as
the calendar date of the business day they belong to hasn't passed. Tonight's remaining
12:30 AM+ blocks (business day 7/31) appear in **neither** query after midnight: they
are unreachable through the public API, period.

## Effect chain in our code (no bug on our side — we reflect vendor truth)

1. `apps/web/src/features/kiosk/service/experience-availability.ts` →
   `computeExperienceAvailability` uses `businessDayYmdET()` → correctly `2026-07-31`
   at 12:16 AM (2 AM rollover).
2. `attractionFirstOpenToday` → BMI returns **HTTP 200 with 0 proposals** — the
   fail-open catch does NOT trigger (it only protects against throws), so this is a
   legitimate "nothing left" result.
3. `productFirstOpenSlot` → null → `open: false` → tile locks in
   `KioskCategories.tsx` with the "Nothing left to book today" note.

Affects **every BMI-vendored surface** (laser, gel, shuffly, racing) on kiosk AND the
web booking flow (same adapter, same business-day date), every night from calendar
midnight until close. Bowling/KBF/duckpin are QAMF and unaffected — QAMF returns
post-midnight slots for `startDate=<business day>` fine.

Note this is not just tile cosmetics: even with the tile unlocked, entering the flow
queries the same date and shows no slots. Between midnight and close those late arena
sessions are online-unbookable — walk-in only.

## Remedy options (pick when scheduling the fix)

1. **Vendor:** raise with BMI/SMS-Timing — their dayplanner and public availability API
   disagree about when a business day ends. Ask if the availability endpoint can honor
   business-day dates until day close (or accept a time-window parameter).
2. **Probe `booking/book` after midnight** with a proposal fetched *before* midnight
   (untested — deliberately not probed, it would create a real booking). If book still
   accepts it, a workaround becomes possible: cache the evening's proposal set and
   serve/book remaining future blocks from it after midnight.
3. **Accept + copy:** leave behavior as-is; the tile copy already steers guests to the
   front desk, which is the only channel that can book those blocks anyway. Optionally
   swap the note after midnight to something like "Open late — book at the front desk"
   so it doesn't read as "closed".

## Memory / references

- Memory: `project_bmi_availability_midnight_cliff.md` (auto-memory dir)
- Probe script: `apps/web/scripts/probe-bmi-midnight-cliff.mts` (read-only, rerunnable)
