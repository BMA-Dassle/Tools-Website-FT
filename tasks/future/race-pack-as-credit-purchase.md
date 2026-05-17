# Future: Race-pack as credit-pack purchase (PR-B4)

## Why this exists

Race-pack was originally on the PR-B4 roadmap as "Race-pack v2: multi-component heat picker." After review (2026-05-16) we changed the taxonomy: **race-pack is NOT a booking — it is a credit-granting purchase.** PR-B4 needs to reflect that distinction. Deferred during PR-B2 to keep scope tight and revisited as its own design exercise.

## Taxonomy

A race-pack is:
- A Square catalog item the customer buys for one price
- Grants N race credits to the customer's account
- Credits redeem against future race heat bookings at $0 each

The customer experience MAY still be "pick 3 heats while buying the pack" (good UX — single transaction) — but the conceptual model differs:
- **Square line item:** one pack purchase (priced as the pack price). Not 3 race line items.
- **BMI side:** 3 race heat reservations, each at $0, each tagged as covered by a pack credit.
- **The pack is the purchase. The heats are the bookings the credits cover.**

## Square attribute schema (already locked, do not change)

Race-pack Square items carry:
- `Pack Slug` (enum: `ultimate-qualifier`, `rookie-pack`, ...)
- `Credits Granted` (number, e.g. 3)
- `Credit Kind` (enum: `race | ...`)
- **NO `Booking Activity`** and **NO `BMI Item ID`** — race-packs are explicitly not in the booking activity enum.

The pack composition (which heats, gap rules, sequencing, expiration) lives in v2 code at `apps/web/src/features/booking/data/packs.ts`, not in Square. Square only knows the pack slug.

## State-machine changes when PR-B4 ships

- Re-add a `CreditPackItem` variant to `SessionItem`:
  ```ts
  type SessionItem =
    | BookingItem                                             // existing
    | { kind: "credit-pack"; packSlug: string; quantity: number };
  ```
- `service/checkout.ts` dispatches credit-pack items to a `creditPack` service (NOT a vendor reservation — a credit grant via BMI/Pandora).
- The race step components grow a "use a pack credit" payment option that consumes a granted credit.

## Open questions to resolve in PR-B4's planning

1. **Where do credits live?** BMI's native credit balance? Pandora? Both? Need to verify v1's current credit-tracking mechanism before designing this.
2. **Expiration model.** Do pack credits have an expiration date (90 days, 1 year, never)? Where is it enforced?
3. **Refunds / partial use.** If a customer buys a 3-heat pack, uses 2 heats, then asks for a refund of the 3rd — what's the policy? Cash refund vs in-store credit?
4. **Picking heats at purchase time vs deferring redemption.** UX decision: force the customer to pick 3 heats during pack purchase (today's v1 behavior) or let them defer? Picking-at-purchase keeps the wizard simple; deferring matches the "credit grant" model more cleanly.
5. **Pack vs per-heat displayed pricing.** When the customer is mid-race-flow and picking a heat, do they see a "use a pack" option that switches the line item? Or is the pack-vs-per-heat decision made at the top of the race wizard?

## Files to expect when PR-B4 ships

- `apps/web/app/book/race-pack/v2/page.tsx` (new — separate from `/book/race/v2`)
- `apps/web/src/features/booking/data/packs.ts` (pack composition + gap rules)
- `apps/web/src/features/booking/service/credit-pack.ts` (credit grant orchestration)
- Re-adds `CreditPackItem` to `apps/web/src/features/booking/state/types.ts`
- Re-adds `race-pack` step registry entries

## Dependencies

Must land after PR-B2 (race v2) — needs the race booking flow stable so credit-redemption against race heats has something to plug into.
