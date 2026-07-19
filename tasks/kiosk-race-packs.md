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

## Implementation plan — REVISED 2026-07-18 (owner: "they would need to go on the
## deposit order like gift cards do") — mirror the PROVEN GZ-in-cart architecture

The Game Zone cards-in-cart rail (shipped + live 7/18) is the template; packs are
a second rider on the same seams. Flag `NEXT_PUBLIC_KIOSK_PACKS_ENABLED`, default OFF.

**Stage 1 — packs ride the deposit order, credits BANKED (first smoke gate)**
1. Session state (pointers only, server re-derives all pricing — GZ pattern):
   `BookingSession.racePackPurchase?: { packs: Array<{ packSlug; memberId }> }`
   + `setRacePackPurchase` reducer action. Additive — web schema untouched.
2. Server resolver `features/race-packs/cart-purchase.ts` →
   `resolveRacePackCartPurchase(purchase, party)`: validates each slug against
   `RACE_PACKS`, each memberId → a party member holding `bmiPersonId`, returns
   `{ packs, totalCents, orderLines }` (one line per pack:
   `SQUARE_RACE_PACK_CATALOG_ID` + `racePackLabel` name override). Throws on
   unknown slug / accountless member (fail-closed).
3. Deposit rail: reuse the EXACT extraLines/extraCents seams
   (`createDepositOrder(extraLines)`, `finalizeDepositFromExternalPayment(extraCents)`)
   in BOTH reserve paths (unified + bowling mirror). gz + packs merge into ONE
   extraLines array / one extraCents sum; payment verify = booking + cards + packs.
   Same gating as cards: kiosk + terminal + flag; fail-closed for non-reader payments.
4. Persist-first: Neon `race_pack_purchases` rows at PREPARE
   (status pending → charged → granted; pointers ride the Redis terminal anchor).
   Finalize (payment verified) grants per pack via the proven `addDeposit`
   (personId = member's bmiPersonId re-read at finalize, depositKindId, raceCount)
   with retry; a failed grant leaves a CHARGED row the reconcile cron retries —
   money never outruns grants, grants never lost (GZ recovery model). Idempotency
   key `anchor+personId+packSlug` (Redis NX, mirrors race-credit-redeem).
5. UI: `KioskRacePackStep` after `race-party` (every member has a personId by
   then) — per-member optional pack pick; CheckoutStep review lines + total
   (after booking subtotal/tax, byte-identical booking math — GZ pattern);
   CartView block w/ remove; cart pill counts the entry; confirmation shows
   "N races banked to {name} — good any visit" per pack.
   LIVE SMOKE (real reader charge + verify credits on the person) → flag on.

**Stage 2 — same-day funding (owner decision #1, second smoke gate)**
6. When an assignee also has TODAY heats in this cart and the pack's dayType
   allows today: cash total = booking − coveredHeatCents + packCents (server
   re-derived; capped at raceCount heats; weekday packs can't cover weekend
   heats). Checkout shows an explicit "Today's race — covered by {name}'s pack
   −$X" line (displayed == charged tripwire extends to the adjustment).
7. Finalize sequencing (NO validator mutation): verify payment → grant FULL
   raceCount → run the existing redeemCredits rail for the covered heats against
   the now-live balance (validates cleanly because the grant landed first) →
   BMI bill lines for covered heats get the standard credit-payment treatment.
   Partial failures: rows track granted/redeemed separately; cron recovers.
   LIVE SMOKE (pack + covered heat in one reader payment; verify BMI bill,
   remaining balance = raceCount − covered) → stage-2 flag on.

**Deferred (explicitly out of v1):** packs with an EMPTY cart (nothing to ride —
web /book/race-pack/v2 already covers standalone; add a kiosk hand-off tile
later); refund/partial-use policy (owner call, sell path unaffected).

## Risks
- `postPaymentAction` is single-grant today → multi-person packs need the array or
  only ONE person is granted. Do not ship the single form for a multi-pack cart.
- `CreditPackItem` touches SessionItem/reducer/cart/checkout — many surfaces (this
  is the "re-add CreditPackItem" work scoped in tasks/future/race-pack-as-credit-purchase.md).
- Refund/partial-use policy unspecified (out of scope for the sell path; tell owner).
- New-racer grant target: re-read `PartyMember.bmiPersonId` at checkout (lazily created mid-flow).
