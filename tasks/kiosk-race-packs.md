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

## Owner decisions needed (recommended defaults in brackets)
1. **Banked vs same-day** — [BANKED: pack grants credits only; it does NOT fund a
   race in the SAME checkout]. Same-day is a sequencing hazard: `addDeposit` runs
   in `postPaymentAction` AFTER the charge, but credit redemption validates the
   live balance at charge time, so a just-bought pack isn't on the ledger yet.
   Matches the standalone flow's "This does not book you a race" disclaimer.
2. **One pack = one person?** — [YES: the credit model is non-transferable, keyed
   to one `bmiPersonId`. "Split 6 across two kids" = two 3-packs, one each.]
3. **Which of the 6 packs to sell on the kiosk** — [all 6, or a curated touch set].

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
