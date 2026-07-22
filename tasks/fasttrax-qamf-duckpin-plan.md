# FastTrax Duckpin → QAMF Migration Plan (center 11542)

**Goal:** Move FastTrax duckpin (public website **and** kiosk) off the legacy BMI
attraction path onto the QubicaAMF "Bowling Reservations" API — reusing the exact
HeadPinz bowling flow, endpoints, hold/reserve/confirm/checkout machinery — with two
FastTrax-specific deltas:

1. **Only 3 price points: 30 / 60 / 90 min** → QAMF **web offer 5**, Time option ids **33 / 34 / 35**. (Offer 6 = 120/180 is intentionally not offered.)
2. **No shoes anywhere at FastTrax** — remove shoe selection, shoe-size capture, shoe copy, shoe roster sync, and the "SHOES NOT INCLUDED" staff note, for FastTrax only, without touching HeadPinz.

Confirmed live: center **11542**, 8 lanes, offer 5 (options 33=30m/34=60m/35=90m). BMA
credential is multi-center; per-center token mints fine for 11542.

---

## The one architectural decision everything hangs on

FastTrax FM and HeadPinz FM are the **same physical building**. In the booking model
`session.center` is a `CenterCode` (`"fort-myers" | "naples"`) and the QAMF id is derived
by `qamfCenterIdForCode(center)` which is **brand-blind** → `fort-myers` always resolves to
**9172 (HeadPinz FM)**. So today a FastTrax session silently books HeadPinz lanes.

Two ways to fix it:

| Option | How | Verdict |
|---|---|---|
| **A. New `CenterCode "fasttrax"`** | Add a third center code | ❌ **Rejected.** `setCenter` **clears a non-empty cart** on center switch (machine.ts:312-314). A guest with a FastTrax racing item + duckpin would lose their cart. Also ripples through dozens of `naples`/`fort-myers` branches. Breaks the deliberate "one physical complex" model. |
| **B. Item-level `isDuckpin` marker → 11542** | Mark the duckpin *item*; resolve its `qamfCenterId` to 11542 regardless of `session.center="fort-myers"`; stop the reducer clobbering it | ✅ **Recommended.** Mirrors the existing `isWorldCup` pattern. Keeps `session.center="fort-myers"`, so carts can mix FastTrax racing + duckpin + (theoretically) HeadPinz. Surgical. |

**Decision: Option B.** A duckpin `BowlingItem` carries `isDuckpin: true`; a brand/venue-aware
resolver maps it to 11542; the reducer must **not** overwrite a duckpin item's `qamfCenterId`.

The single hardest correctness rule: **every** `item.qamfCenterId ?? 9172` fallback and every
2-entry `{9172,3148}` center map must be updated together — a missed one silently books
FastTrax onto HeadPinz lanes (the Naples-misroute incident class).

---

## What already works vs. what's missing

**Already center-agnostic (no change):** the QAMF REST client (`qamf-bowling.ts` — every method
takes `centerId`), the OAuth token mint (per-center, `qamf-bowling-auth.ts`), the reschedule
engine (`qamf-reschedule.ts` — America/New_York is correct for FastTrax), `deposit.ts`,
duration-feasibility pure helpers, and the DB schema (`shoe_size` is nullable; no schema change
needed — a center with no `addon_shoe` products and non-`fun-4-all`/`pizza-bowl` slugs naturally
yields `shoePairsAllowed = 0`).

**Missing / hardcoded to 2 centers (must gain 11542):** see the wiring matrix below.

**Square location:** FastTrax's own Square location `LAB52GY480CJF` (Lee County 6.5% tax) already
exists as `SQUARE_LOCATIONS.FASTTRAX_FM` in `square-catalog-map.ts`, and the duckpin Square
catalog item `SQ.DUCKPIN = EXW7E74IRPYJAQFA4YIIEW3G` exists. **Recommendation:** use
`LAB52GY480CJF` as the duckpin `center_code` so revenue books to the FastTrax entity — with a
**caveat** (see risk R1: `cancellation/centers.ts` already maps `LAB52GY480CJF → 9172` for
racing, so duckpin must be disambiguated by `product_kind`/`isDuckpin`, not by center_code alone).

---

## Center-wiring matrix (every `{9172,3148}` site that needs 11542 → `LAB52GY480CJF`)

| File | What to add |
|---|---|
| `src/features/booking/types.ts` | Brand/venue-aware resolver `qamfCenterIdFor(center, brand\|isDuckpin)` → 11542 for fort-myers+fasttrax-duckpin; keep `qamfCenterIdForCode` back-compat. Add `FASTTRAX_QAMF_CENTER_ID = 11542` + code constant (or new `lib/qamf-centers.ts` single source of truth). |
| `src/features/booking/state/machine.ts` | addItem (147-152) + setCenter (316-327): do **not** overwrite `qamfCenterId` for a duckpin item. |
| `app/api/bowling/v2/reserve/route.ts` | `CENTER_CODE_TO_ID` (153-156) + `QAMF_CENTER_ID_TO_CODE` (174-177) + inline `LOCATION_TAX` (1415-1418). |
| `app/api/bowling/v2/reserve/hold/route.ts` | `VALID_CENTER_IDS` (27). |
| `app/api/bowling/v2/availability/route.ts` | `QAMF_TO_CENTER_CODE` (56-59) + `QAMF_TO_HP_SLUG` (62-65). |
| `app/api/square/bowling-orders/quote/route.ts` | `LOCATION_TAX` (49-52) → `LAB52GY480CJF`:Lee County. |
| `src/features/booking/service/bowling-hours.ts` | `CENTERS` (103-106) + `QAMF_TO_CENTER_CODE` (111-114) + a FastTrax hours source. |
| `src/features/booking/service/bowling.ts` | Replace the `centerId===9172 ? FM : Naples` binary at **247** and **388**. |
| `src/components/features/booking/steps/checkout/CheckoutStep.tsx` | `~539/544` center + location fallback. |
| `src/features/booking/hooks/useBowlingOffers.ts` | `QAMF_CENTER_CODES` (43-46). |
| `src/components/features/booking/steps/bowling/{BowlingShoesStep,BowlingTierStep,BowlingSlotsStep,BowlingDateStep}.tsx` | local center maps + `?? 9172` fallbacks. |
| `src/features/kiosk/steps/KioskBowlingTierStep.tsx` | `CENTER_CODES`. |
| `app/api/webhooks/qamf-bowling/route.ts` | `CENTER_CODE_TO_QAMF_ID`/`QAMF_ID_TO_CENTER_CODE` (117-125) + `WALKIN_SMS_FROM` (248-251). |
| `src/features/cancellation/centers.ts` | `resolveCenter` — 11542 branch, **disambiguated from racing's LAB52GY480CJF→9172**. |
| `components/admin/bowling/CenterPicker.tsx` | FastTrax option for admin tooling. |
| `app/api/notifications/bowling-confirmation/route.ts` | `CENTER_META` FastTrax entry. |
| `src/features/kiosk/service/experience-availability.ts` | thread brand so the FT bowling tile probes 11542. |

---

## Shoe-removal matrix (FastTrax only; HeadPinz untouched)

Shared predicate: `centerHasShoeRental(id) => id !== FASTTRAX_QAMF_CENTER_ID` (in `lib/qamf-centers.ts`).
The **single most important data control**: seed **no `addon_shoe` product** and no
`fun-4-all`/`pizza-bowl`/`kbf` slug for the FastTrax center → `shoePairsAllowed = 0`, which
auto-hides most shoe UI. The four surfaces that *don't* auto-suppress and must be explicitly gated:

| Surface | File | Change |
|---|---|---|
| **Kiosk hard requirement** (blocks advance) | `src/features/kiosk/steps/KioskBowlingDetailsStep.tsx` | Hide shoe-size block; drop `shoeSize` from `playerComplete()` + `canAdvance` for duckpin. **Highest priority — without it a duckpin guest literally cannot proceed.** |
| **"SHOES NOT INCLUDED" staff note** | `reserve/route.ts` (1994-2013), `unified-reserve.ts` (1713-1735), `bowling-db.ts buildQamfMemo` (2486-2501) | Omit the shoe line for 11542. Note: **QAMF confirm logic is duplicated** in reserve route AND unified-reserve (mixed carts) — both must be edited. |
| **Email shoe block** | `emails/bowling-confirmation.html` (277-292) | Tokenize `^[ShoeRentalSection]$` (empty for FT) or FastTrax template. |
| **Kiosk lane-open copy** | `src/features/kiosk/components/KioskConfirmation.tsx` (479) | Drop "your shoes will be delivered to your lane" for FT. |

Also gate (defensive, HeadPinz-safe): web `BowlingShoesStep.isVisible`, `BowlingConfirmation.tsx`
shoe UI + arrival bullets + running banner, `players/[id]/route.ts` $0 shoe-KDS sync,
`getReservationPlayersWithShoeAllowance` explicit early-0, admin `CheckInModal` shoe picker,
`BowlingPlayersEditor` shoe column. Roster shoe fields (`qamf-sync.ts`, `bowling.ts`,
`unified-reserve.ts` rosters) already no-op on null `shoeSize` — no change, just never populated.

---

## Phased delivery (v2 cutover safety pattern — deploy alongside BMI, flag-gate, verify, redirect, retire)

**Flag:** `NEXT_PUBLIC_FASTTRAX_QAMF_DUCKPIN` (off by default). BMI duckpin stays live until cutover.

### PR 0 — Inputs & decisions (no code) — *blocks PR 2/4*
Get from owner: the three prices (30/60/90) + per-lane-vs-per-person + deposit % (recommend 100% like HeadPinz bowling); bumpers yes/no for duckpin; confirm Square location `LAB52GY480CJF`; FastTrax hours; FastTrax SMS from-number; confirm same QAMF webhook secret covers 11542.

### PR 1 — Center identity plumbing (inert until an item is stamped 11542)
Single source of truth `lib/qamf-centers.ts` (`FASTTRAX_QAMF_CENTER_ID`, code, `centerHasShoeRental`); brand/venue-aware resolver; **all** wiring-matrix maps updated together. **Verify:** existing HeadPinz/Naples reserve + availability tests stay byte-identical; the center-live probe already confirms 11542 reads. Add a targeted probe of the 1.2 (per-player DELETE) and 1.3 (lanes PATCH) mutation endpoints on 11542 before relying on edit/reschedule.

### PR 2 — Duckpin catalog seed (Neon)
`seed-bowling-products.ts`: 3 duckpin price rows under `LAB52GY480CJF`, **no `addon_shoe`**. `seed-bowling-experiences.ts`: one `duckpin` experience (kind `hourly` → per-lane, non-VIP, slug **not** matching pizza-bowl/world-cup), offer row (webOffer 5, `Time`), 3 duration options (opt 33→30m, 34→60m, 35→90m, each with its price override). **Fix the stale `ON CONFLICT (center_code, qamf_web_offer_id)`** → current `UNIQUE(experience_id, center_code)`. **Verify:** `GET /api/bowling/v2/experiences?centerCode=LAB52GY480CJF` returns the 3 durations; `/availability?centerId=11542` returns slots.

### PR 3 — Item model + entry (flag-gated, alongside BMI)
`BowlingItem.isDuckpin`; `newItem` seeds it; reducer no-clobber. Convert/add the duckpin offering in `activities-catalog.ts` to produce a QAMF bowling item at 11542 (behind the flag). Web entry (`/book/[attraction]/v2` → new duckpin bowling entry) + kiosk entry (`KioskFlow` seedForGoto/pickOffering) both stamp `isDuckpin` + `qamfCenterId=11542`.

**Flow decision (owner-confirmed 7/22):** duckpin rides the **same bowling step layout HeadPinz runs in production** — currently the **classic** flow (the one-time/v3 flow is still dark: `bowlingOneTimeFlowEnabled()` requires `NEXT_PUBLIC_BOWLING_ONE_TIME_FLOW==="true"`, off in prod). Do **NOT** force v3. Both "classic" and "one-time" are step layouts *inside the same v2 booking system* (identical reserve/hold/checkout/QAMF); duckpin is flow-agnostic and inherits the one-time flow automatically whenever HeadPinz flips it on. The only duckpin delta is **hiding the Tier step** — a `hiddenForFastTrax(...)`/`isDuckpin` visibility gate on `BowlingTierStep` (classic) — which is a no-op in the one-time flow (it has no tier step). **Verify:** flag-on FastTrax session holds + reserves a real 30/60/90 slot end-to-end at 11542 on the classic flow (live smoke); HeadPinz/Naples unchanged with flag off; re-smoke duckpin with `?bowlingV3=1` to confirm it also works on the one-time layout.

### PR 4 — No-shoes for FastTrax
Apply the shoe-removal matrix. **Verify:** kiosk duckpin advances with names only; no "SHOES NOT INCLUDED" in Conqueror notes; email/lane-open copy shoe-free; `steps-v3-gating.test.ts` asserts FT excludes `bowling-shoes`+`bowling-tier` while HeadPinz includes them; HeadPinz shoe flow regression-tested (qamf-sync.test.ts still passes).

### PR 5 — FastTrax branding on confirmation + notifications
`bowling-confirmation` route: FastTrax `CENTER_META`, brand-aware sender ("FastTrax Entertainment"), `siteUrl`/links → fasttraxent.com, FT SMS from-number. New FT confirmation route/`confirmBase`; short link → `fasttraxent.com/s/`. `BowlingConfirmation.tsx` FastTrax brand path. **Fix `cancellation/notify.ts` `brandFor()`/`rebookUrl()`** to resolve FastTrax from center/product, not just `productKind==='race'` (else a duckpin cancel is mis-branded HeadPinz). New shared top-level route → pair with `SHARED_TOP_LEVEL_ROUTES`/`isSharedTopLevelRoute` (project hard rule) — though a `/book/*` FT-only route likely needs none; confirm.

### PR 6 — Cutover & retire BMI duckpin
After ops smoke: flip flag on; redirect BMI `duck-pin` → QAMF flow; then remove BMI wiring (`attractions-data.ts` 161-196 + PRODUCT_ATTRACTION_MAP 483-484, `activities-catalog.ts` attraction entry). One product, one booking system.

---

## Cross-cutting risks (from the subsystem maps)

- **R1 — center_code collision (money risk):** `cancellation/centers.ts` maps `LAB52GY480CJF → fort-myers → 9172` for racing. A duckpin cancel/refund/reschedule resolving to 9172 could delete a HeadPinz reservation or refund the wrong Square location. **Disambiguate by `product_kind`/`isDuckpin`, not center_code alone.**
- **R2 — silent HeadPinz misroute:** any missed `?? 9172` fallback or unmapped center table books FastTrax onto HeadPinz lanes/revenue. Audit all sites in one PR.
- **R3 — duplicated QAMF confirm:** reserve route AND unified-reserve (mixed carts) both confirm QAMF + build the shoe note — fix both or mixed duckpin+racing carts break/misbrand.
- **R4 — displayed ≠ charged:** CheckoutStep quote location and reserve product/location must change together, or the gift-card deposit under/over-funds the day-of order (Square rejects at lane-open).
- **R5 — auth default:** `getQamfBowlingToken` defaults to 9172; every FastTrax path must pass 11542 explicitly.
- **R6 — webhook readiness:** update webhook center maps + SMS-from **before** QAMF starts sending 11542 events, or they dead-letter.
- **R7 — per-lane vs per-person:** seed `duckpin` as `hourly` (per-lane) deliberately, or pricing multiplies by player count.
- **R8 — persist-after-API (inherited):** guest data is written to Neon *after* QAMF+Square succeed, not persist-first. Pre-existing HeadPinz behavior; flag but not a FastTrax blocker.

## Owner decisions — RESOLVED 2026-07-22
1. **Square location:** ✅ `LAB52GY480CJF` (FastTrax entity, Lee County 6.5%) — revenue books under FastTrax. Disambiguate from racing in `cancellation/centers.ts` by `product_kind`/`isDuckpin` (risk R1).
2. **Bumpers:** ✅ **KEEP** — duckpin has bumpers. Only shoes are removed; the roster keeps the bumpers Yes/No control and `ActivateBumpers` still syncs to QAMF. (Do NOT suppress bumpers.)
3. **Deposit:** ✅ **100% prepay** — all duckpin `bowling_square_products.deposit_pct = 100`, quote called `depositPct:100`, exactly like HeadPinz bowling.
4. **Flow:** ✅ Use the **production-default HeadPinz bowling layout** (classic today); hide the Tier step for duckpin; do not force the still-dark one-time flow. Flow-agnostic.

## Still needed before PR 2 (seed)
- **Prices** for 30 / 60 / 90 min (dollar amounts) and whether priced **per lane** or **per person** (plan assumes per-lane `hourly`, matching the confirmed flat-duration offer). Deposit is 100%.
- **FastTrax hours** source for the past-close guard (reuse FM building hours, or distinct duckpin hours).
- **FastTrax SMS from-number** for walk-in/lane-ready/confirmation SMS.
