# Future fix: normalize `bowling_reservations.center_code`

**Status:** deferred (bridge in place). Logged 2026-06-13.

## Problem

`bowling_reservations.center_code` carries **two incompatible namespaces** depending on
which write path created the row:

| Product           | Write path                                                                                   | Stored `center_code`                          |
| ----------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Bowling (`open`, `kbf`) | `app/api/bowling/v2/reserve/route.ts` (resolves a Square location ID)                  | Square **location ID** — `TXBSQN0FEKQ11`, `PPTR5G2N0QXF7` |
| Racing / attractions (`race`, `attraction`) | `src/features/booking/service/unified-reserve.ts`, `app/api/booking/v2/reserve/route.ts` (store `session.center`) | center **slug** — `fort-myers` / `naples` (defaults to `fort-myers`) |

Root cause: the two reserve paths diverged. `CenterCode` is only `"fort-myers" | "naples"`
(`src/features/booking/types.ts`) — there is **no `fasttrax`** — so FastTrax racing rows land
under the `fort-myers` slug, never a Square location ID.

The unified-reserve bowling branch (`unified-reserve.ts:~764`) also writes the **slug** for
bowling, producing a small bleed of `open`/`fort-myers` + `open`/`naples` rows that belong to
HeadPinz but don't match the Square-ID bowling filter.

### Live data snapshot (2026-06-13)

```
attraction  fort-myers       17   (active)
attraction  naples            6   (active)
kbf         PPTR5G2N0QXF7   194
kbf         TXBSQN0FEKQ11   521
open        PPTR5G2N0QXF7  1686
open        TXBSQN0FEKQ11  3045
open        fort-myers       25   ← slug bleed (should be TXBSQN0FEKQ11)
open        naples            4   ← slug bleed (should be PPTR5G2N0QXF7)
open        LAB52GY480CJF     4   ← stale test (May)
race        fort-myers      223   (active) ← FastTrax racing, under the slug
racing      LAB52GY480CJF     8   ← legacy product_kind (stale, May)
racing      TXBSQN0FEKQ11     1   ← legacy
laser-tag   TXBSQN0FEKQ11     3   ← legacy
```

## Why it bit us

The admin reservations board (`app/admin/[token]/reservations/`) maps every center **slug** →
Square **location ID** and filtered `center_code = <locationID>`. So:

- HeadPinz FM bowling worked (location-ID rows matched).
- The `Race` filter showed 0 everywhere (race rows are the `fort-myers` slug, never a location ID).
- The FastTrax embed (`?center=fasttrax` → `LAB52GY480CJF`) was **always empty** — no row is ever
  written with `LAB52GY480CJF` as `center_code`.

## Bridge currently in place (read-side only — do NOT mistake for the fix)

`app/api/admin/bowling/reservations/route.ts` maps the requested location to **every**
`center_code` its rows live under, via `CENTER_CODE_ALIASES`, and queries `center_code = ANY(...)`
(`listBowlingReservations({ centerCodes })`, added to `lib/bowling-db.ts`):

```
TXBSQN0FEKQ11 → [TXBSQN0FEKQ11]
PPTR5G2N0QXF7 → [PPTR5G2N0QXF7, "naples"]
LAB52GY480CJF → [LAB52GY480CJF, "fort-myers"]   // FastTrax now shows its racing
```

**Known imperfection:** because FastTrax matches the `fort-myers` slug, the ~25 mis-tagged
`open`/`fort-myers` bowling rows (HeadPinz FM) also surface under FastTrax. Per single day that's
~0–1 rows and they're filterable via the kind chips, so it's acceptable until normalization.

## The real fix (when scheduled)

1. **Pick one canonical convention.** Recommend **Square location IDs** (smaller blast radius:
   bowling — the highest-volume product, ~5,400 rows — already uses them; the admin board and
   Square integration already key off them; FastTrax already has a location ID `LAB52GY480CJF`,
   which is the location its race day-of orders are created at — confirmed in
   `race-dayof-pay/route.ts` and `race-confirm-reconcile/route.ts`).
2. **Migrate race/attraction rows** (~240 active): `fort-myers` → `LAB52GY480CJF` for `race`/
   FastTrax `attraction`; `naples` attractions → `PPTR5G2N0QXF7`. Also fix the `open`/slug bleed
   (`fort-myers`→`TXBSQN0FEKQ11`, `naples`→`PPTR5G2N0QXF7`).
3. **Fix the write paths** so race/attraction store the Square location ID, not `session.center`:
   `unified-reserve.ts` (both bowling + race branches), `booking/v2/reserve/route.ts`.
4. **Update the race/attraction crons** that currently key lookup tables off the slug — they will
   break silently otherwise. Audit: `race-dayof-pay` (`OFFICE_CLIENT_KEY`), `race-confirm-reconcile`
   (`PANDORA_LOCATION_IDS`, `depositLocationId`, `bmiClientKey`, the `centerCode === "naples"`
   branch), `race-cancel-watch`, and any group-function code keyed on `center_code`.
5. **Remove the `CENTER_CODE_ALIASES` bridge** + the `centerCodes` array path once data + writes
   are consistent. The admin board goes back to a single `center_code = X` filter.
6. Follow the **v2 cutover safety pattern** (CLAUDE.md): migrate + dual-read, verify in prod, then
   flip writes, then remove the bridge.
