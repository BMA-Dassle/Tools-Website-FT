# Kiosk race packs — per-person assignment (spec, NOT YET BUILT)

Owner ask (2026-07-18): "We don't have race packs anywhere? Needs added with the
ability to put them on certain people both new and returning." Priority: "just
do them all." Held because it is a **money-path feature** (charges + grants
credits) — per the repo's hard rules (H3074 six-charge incident, "never ship an
untested money path", "seed+smoke before done") it must be built flag-gated +
live-smoked, and needs the owner's product decisions first.

## What already exists (reuse — do NOT reinvent)
- **Catalog:** `src/features/booking/data/packs.ts` — `RACE_PACKS` (6 variants:
  weekday/anytime × 3/5/10-race), each `{slug,name,raceCount,dayType,price,
  depositKindId}`. `getRacePack`, `racePackLabel`. One shared Square SKU
  `SQUARE_RACE_PACK_CATALOG_ID`; per-variant name is a line-item override.
- **Working standalone sell UI** (parity reference): `RacePackFlow.tsx` at
  `app/book/race-pack/v2/page.tsx` — select → racer → review(clickwrap) → pay.
- **Grant rail (proven, reuse):** `/api/square/pay` handles
  `postPaymentAction.kind === "addDeposit"` → `addDeposit(personId, depositKindId,
  raceCount)` after Square settles, logs `bookingType:"racing-pack"`, retry-queues
  on failure. **Today it is a SINGLE grant.**
- **Redeem side (already built):** `race-credit-redeem.ts` — a PartyMember's
  `redeemCredits` draws that person's own balances; non-transferable, keyed to
  their `bmiPersonId`.
- **Kiosk advantage:** the people step already onboards EVERY participant with a
  real `bmiPersonId` (new + returning) before advancing — so a pack can attach to
  any `PartyMember.bmiPersonId` with no extra account creation.

## Owner decisions (CONFIRMED 2026-07-18)
1. **Same-day funding = YES ("fund today too").** A pack bought at the kiosk must
   be able to pay for TODAY's race in the same checkout — NOT just bank credits.
   ⚠️ This is the harder path. `addDeposit` grants AFTER the Square charge, but
   `validateCreditRedemptions` checks the LIVE balance at charge time, so a
   just-bought pack isn't on the ledger when today's heats validate. Options to
   make it correct (pick during build): (a) treat the assigned pack as DIRECT
   payment for that person's heats today (the pack covers up to `raceCount` heats;
   remainder banked) so no chicken-and-egg; or (b) re-sequence charge → grant →
   re-validate → book so the granted credits are live before redemption. Prefer
   (a) — it avoids mutating the shared redemption validator. MUST live-smoke.
2. **One pack → one person = YES.** Non-transferable; a 3-pack = 3 credits to one
   racer. Split = buy two packs.
3. **Sell all 6 packs** (weekday & anytime × 3/5/10).

## Build discipline (owner + repo rules)
- Flag-gated `NEXT_PUBLIC_KIOSK_PACKS_ENABLED` (default OFF) — the pack step is
  hidden and no pack charge/grant code runs until the flag is on.
- Additive `/api/square/pay` change only (accept an ARRAY of addDeposit grants;
  single-grant form unchanged).
- Persist the pack selection to Neon at capture (persist-first).
- LIVE payment smoke (real card, real grant, verify credits + heats) BEFORE the
  flag goes on — no untested money path (H3074).

## Implementation plan (build flag-gated: NEW `NEXT_PUBLIC_KIOSK_PACKS_ENABLED`, default off)
1. `SessionItem`: add `CreditPackItem { kind:"credit-pack"; packSlug; assignedTo: PartyMember.id }`
   (the future taxonomy already reserves this — state/types.ts:15,400-406). Widen the reducer.
2. New kiosk step `KioskRacePackStep` inserted AFTER `race-party` (`insertAfter(steps,"race-party",…)`);
   every PartyMember has a `bmiPersonId` by then. Per member: optional pack pick →
   emit one `CreditPackItem` per assignment. Persist the selection to Neon at capture
   (hard persist-first rule), not gated on the charge. Bump `KIOSK_SCHEMA_VERSION`.
3. Checkout: a `credit-pack` "service" whose `hold` is a no-op (books nothing), so
   `runCheckout`/`getService` stay uniform. Add one Square line per pack
   (`SQUARE_RACE_PACK_CATALOG_ID` + `racePackLabel`, amount `pack.price` + FL tax).
   Keep displayed == charged (static `pack.price`).
4. `/api/square/pay`: extend `postPaymentAction` addDeposit to accept an ARRAY of
   grants (one per `{personId: member.bmiPersonId, depositKindId, amount: raceCount}`),
   keeping the retry-enqueue + `racing-pack` sale log per grant. Idempotency keyed on
   billId+personId+packSlug (mirror race-credit-redeem's Redis NX guard). MUST be
   additive (single-grant form still works) so nothing else regresses.
5. Cart/receipt: render the non-booking credit-pack line.

## Risks
- `postPaymentAction` is single-grant today → multi-person packs need the array or
  only ONE person is granted. Do not ship the single form for a multi-pack cart.
- `CreditPackItem` touches SessionItem/reducer/cart/checkout — many surfaces (this
  is the "re-add CreditPackItem" work scoped in tasks/future/race-pack-as-credit-purchase.md).
- Refund/partial-use policy unspecified (out of scope for the sell path; tell owner).
- New-racer grant target: re-read `PartyMember.bmiPersonId` at checkout (lazily created mid-flow).
