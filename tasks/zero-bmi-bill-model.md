# $0 BMI Bill Model (single races) — setup + rollout

**Status (2026-05-31, `feat/booking-b2-race`):** Code reworked to the final model AND the 28 $0 build
products are created in BMI + **wired into `RACE_BUILD_PRODUCTS`**. Type-clean, in working tree, NOT
committed/deployed. ⚠️ This is now **armed** — the next deploy turns the $0 model ON for every single
race. Before deploying: verify page `49504534` dayplanners mirror the priced heat times + share
capacity, and run one end-to-end test booking (see §Verification).

## The model (final)

BMI becomes a pure **reservation/inventory** system for single races; the **entire BMI bill is $0**.
Square is the sole financial source of truth.

- Each single race books against a **$0 "build" product** in BMI → heat adds **$0** to the bill.
- **Two variants per race session:** `race-only` (returning racer) and `race+license` (new racer —
  the license rides inside the product, recorded in BMI at **$0** so the racer still becomes
  "existing" for next time).
- **Square charges everything from the registry:** the race price (`RaceProduct.price`) + the
  license (`LICENSE_PRICE = $4.99`, catalog `SQ.LICENSE`) as its own line.
- BMI bill total = **$0** → confirm as a **credit** (`depositKind 2`).

### Product count (actual)

Once Square owns price, every dimension that was *only* a price difference disappears from the BMI
side — **weekday vs weekend collapse** (one build product spans both via its dayplanner), and
**new vs existing racerType is the ×2** (license vs no-license). **Junior and adult were kept as
separate BMI products** (not collapsed). So the count is **(category × tier × track that exist) × 2**:

- Adult: 3 tiers × 3 tracks = 9
- Junior: starter(Blue), intermediate(Blue, Mega), pro(Blue, Mega) = 5  *(no junior Red; no junior starter Mega)*
- **14 sessions × 2 variants = 28 products**, all on BMI page **49504534**.

**Scope: single races ONLY.** Combos (3-packs), POV, cross-activity add-ons stay legacy
(`raceUsesZeroBmiModel()` already excludes them — combos have `track: null` so no build key).

## BMI build products — ✅ CREATED + WIRED

All 28 exist in BMI (CSV export 2026-05-31) at **$0**, on page **49504534**, named by convention:
- `… - New Web` → **withLicense** variant (new racer; bundles the $0 license)
- `… - New Web NL` → **raceOnly** variant (NL = No License; returning racer / new racer's 2nd+ heat)

Wired into `RACE_BUILD_PRODUCTS` in
[race-products.ts](../apps/web/src/features/booking/service/race-products.ts), keyed
`${category}:${tier}:${track}`. (IDs live in code; no need to duplicate here.)

**Remaining BMI-side config (yours — "the other settings"):**
- **Dayplanner per product must mirror the priced product's heat times** for that category+tier+track
  across all operating days (weekday + weekend for Red/Blue; Tuesday for Mega). Load-bearing: the
  customer picks a heat off the *priced* product's page, but booking reads the *build* product on
  page 49504534. If the times don't line up, the pick won't resolve → booking fails.
- ⚠️ **Capacity parity** — each build product must draw the SAME heat capacity as the real track
  (and walk-ins / Conqueror), not a separate pool, or it'll over-/under-book.

## Code rework — ✅ DONE (2026-05-31, dormant until `RACE_BUILD_PRODUCTS` is filled)

All six changes below are implemented in the working tree and type-clean, and `RACE_BUILD_PRODUCTS`
is now **populated** (keyed `${category}:${tier}:${track}`). The $0 model therefore activates for all
single races on the next **deploy** — gate that deploy on the BMI dayplanner/capacity config +
test booking above.

The popped diff assumed per-row `bmiBuildId` + a separate license. Final model changes:

1. **Build-product table keyed by `tier:track`** (not per-row), in
   [race-products.ts](../apps/web/src/features/booking/service/race-products.ts):
   ```ts
   interface RaceBuildTarget { productId: string; pageId: string; }
   const RACE_BUILD_PRODUCTS: Record<string, { raceOnly: RaceBuildTarget; withLicense: RaceBuildTarget }> = {
     // "starter:Red": { raceOnly: {...}, withLicense: {...} }, … 9 entries
   };
   bmiBookingTarget(product, { withLicense }): RaceBuildTarget | null  // null → legacy fallback
   ```
   Empty table = dormant (`raceUsesZeroBmiModel` returns false), so this is safe to merge now.
2. **`raceUsesZeroBmiModel`** ([race.ts](../apps/web/src/features/booking/service/race.ts)): require a
   `RACE_BUILD_PRODUCTS[tier:track]` entry for every heat's product (replaces the `bmiBuildId` check).
3. **Heat booking** (`bookHeatsOnAdvance`, `holdRaceItem`): pick `withLicense` per heat —
   `true` only for the **first** heat of each **new** racer; `false` otherwise. Thread a
   `Set<personId>` so multi-heat new racers get the license **once**.
4. **Drop `sellLicense`** when the zero model is on (the license is now inside the `+license` build
   product). Legacy path keeps `sellLicense`.
5. **Charge overview = display = Square cart** ([checkout.ts](../apps/web/src/features/booking/service/checkout.ts)):
   `buildZeroModelOverview` builds the `BillOverview` from the registry (race lines + a `FastTrax
   License` line at `LICENSE_PRICE`, + FL tax) instead of the BMI bill. `runCheckout` returns it for
   the pay page, and `reserveBooking` maps `overview.lines` straight to the Square cart — so the
   amount shown == the amount charged. (License name resolves to `SQ.LICENSE` via `NAME_CATALOG_MAP`.)
6. **Confirm $0 credit**: BMI bill is $0 → `bmiConfirmAmountCents: 0` → `bmiAsCredit` (`depositKind 2`).

### Fix 2026-05-31 — pay page showed "credit" / $0 (no payment required)

First test (new account, base license) showed the correct total through the cart, then the **pay
page showed all lines as "Credit" and $0 owed** because `CheckoutStep` derived the amount + the
`isCreditOrder` decision from the **BMI bill overview**, which is now $0. Fixed by §5 above:
`runCheckout` now returns a registry-built charge overview in the zero model (`isCreditOrder: false`,
`cashOwed` = real total), so the pay page collects payment for the true Square amount. `reserveBooking`
maps that same overview to the cart (no more double-source), keeping display == charge.

## Verification / e2e (before live)

- [ ] `npm install` at root, then `npm run typecheck -w fasttrax-web` green (env currently missing deps)
- [ ] New racer, single heat: Square charges **race price + $4.99 license**; BMI bill **$0** credit;
      racer is recorded as licensed/"existing" in BMI; Neon row persists.
- [ ] New racer, **multiple** heats: **exactly one** license on the bill / one Square license line.
- [ ] Returning racer: race-only build product; Square charges race price only; BMI $0 credit.
- [ ] Heat time chosen in the picker **resolves** against the build product at hold + book time (parity).
- [ ] Combo / POV / add-on still take the legacy path (regression guard).
- [ ] v1 race flow (`app/book/race`) unaffected.

## Open risks / decisions

1. **Heat-availability + capacity parity** between build products and the real priced tracks — #1 risk.
2. **License-once** for multi-heat new racers (handled by the per-person Set in §3, but verify in BMI
   that booking the `+license` product is what actually creates the license record).
3. **Square name override** on the shared catalog item — confirm receipts show the race name, not the
   raw catalog name, on a sandbox order.
4. **Displayed price = charge-time price** (CLAUDE.md hard rule): the cart price must equal the
   `RaceProduct.price` + `LICENSE_PRICE` used to build the Square order.
