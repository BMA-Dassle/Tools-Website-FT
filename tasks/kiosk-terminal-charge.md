# Kiosk direct-Terminal charge (no vault) — implementation spec

**Status:** building on branch `kiosk`, FLAG-GATED (`NEXT_PUBLIC_KIOSK_TERMINAL_ENABLED`, default OFF).
**Owner rule (verbatim):** "Kiosk is NOT going to use saved card." Retire SAVE_CARD for the kiosk; the
paired Square reader charges the card DIRECTLY. Money path → must ship WITH a live reader smoke (H3074).

Derived from a full parallel map of the reserve/charge rail (workflow `wf_3fc90837-f53`, 2026-07-19).

## Design (order-linked prepare / finalize — the reader pays OUR deposit order)

Flow: `rebuild-if-expired → PREPARE (server) → reader tap (client) → RESERVE/finalize (server)`.

- **PREPARE** (`prepareUnifiedDeposit`): run pre-charge guards, build day-of order(s) → `dayofTotalCents`,
  `depositCents = round(dayofTotalCents * depositPct / 100)`, create a **GIFT_CARD-typed** deposit order
  (`dep-order-${baseKey}`), write a **persist-first anchor** `status:'awaiting_terminal'` with
  `square_deposit_order_id` set + `square_deposit_payment_id = NULL`. Return `{seed, depositOrderId, depositCents}`.
- **READER TAP** (client): `createTerminalCheckout({orderId, amountCents: depositCents, idempotencyKey: "term-"+baseKey})`
  → reader pays OUR order (amount fixed by construction) → poll `getTerminalCheckout` to COMPLETED → paymentId.
  The GET poll route **stamps paymentId onto the anchor at capture** (survives a browser death).
- **RESERVE/FINALIZE** (`reserve-all` w/ `externalPayment`): `finalizeDepositFromExternalPayment` re-derives
  the deposit order from `baseKey`, GETs the payment and asserts `COMPLETED + order_id + amount + location`
  (hard-fail → page on-call, NEVER re-charge), activates the GC **order-linked**. Downstream fan-out unchanged
  (`depositResult` shape identical).

### Why no double charge / no orphan
- Terminal branch calls **no** `authorizeMultiTender`/`payOrder` — structurally no token to re-charge.
- `activateGiftCardForDeposit` idempotent (`gc-${baseKey}`/`gc-act-${baseKey}`); `term-${baseKey}` makes the
  reader tap replay-safe; reserve NX lock + `bmi:confirmed` short-circuit serialize retries.
- Prepare writes the anchor **before** the tap; poll stamps paymentId **at** capture; reconcile cron finalizes forward.

## File-by-file (ordered; SHARED must be byte-identical with flag OFF)

1. `src/features/booking/service/deposit.ts` — SHARED. `ExternalTerminalPayment` type; extract
   `createDepositOrder()` (pure refactor of 174-214); `finalizeDepositFromExternalPayment()`;
   `TerminalPaymentUnverifiedError`/`TerminalAmountMismatchError`.
2. `src/features/kiosk/service/square-terminal.ts` — add `idempotencyKey?` to `createTerminalCheckout`
   (default preserves current); add `getSquarePayment()`. SAVE_CARD untouched (delete in a 3rd PR post-smoke).
3. `lib/bowling-db.ts` — SHARED. accept `'awaiting_terminal'`; `stampTerminalPayment` by seed;
   `getReservationByDepositPaymentId` (reconcile/replay guard).
4. `src/features/booking/service/unified-reserve.ts` — SHARED. `externalPayment` on `UnifiedReserveInput`;
   extract `buildDayofOrders()` (pure refactor 581-684); `prepareUnifiedDeposit()`; branch charge block
   (779-823); guard card-vault (1556 → `&& !input.externalPayment`); `stampTerminalPaymentOnAnchor`.
5. `app/api/booking/v2/reserve-all/route.ts` — thread `externalPayment`; **fail-closed** on flag off;
   reject `externalPayment && cardSourceId` (400).
6. `app/api/booking/v2/reserve-prepare/route.ts` — NEW, kiosk-only, fail-closed shell over `prepareUnifiedDeposit`.
7. `app/api/kiosk/terminal-checkout/route.ts` — forward `orderId` + `idempotencyKey`; stamp anchor on COMPLETED.
8. `src/features/booking/service/checkout.ts` — `externalPayment` on `ReserveAllParams` + body.
9. `src/features/booking/service/bowling.ts` — `externalPayment` on `BowlingReserveParams` + body.
10. `app/api/bowling/v2/reserve/route.ts` — `externalPayment` on `ReserveBody`; relax token guard;
    deterministic `depositBaseKey` (reserveBaseKey); branch charge → finalize; fail-closed.
11. `app/api/bowling/v2/reserve-prepare/route.ts` — NEW, kiosk-only (bowling-only carts).
12. `src/components/features/booking/steps/checkout/CheckoutStep.tsx` — SHARED (gated). `handleTokenize`
    +`externalPayment`; thread into reserveAll + bowlingReserve; flag-gated reader branch above the SAVE_CARD one.
13. `src/features/kiosk/components/KioskReaderCheckout.tsx` — NEW. POST checkout → poll → onCaptured({paymentId}).
14. `src/features/kiosk/components/KioskTerminalCheckoutGate.tsx` — NEW. rebuild → prepare → assert
    `depositCents === round(overview.cashOwed*100)` → reader → onCaptured.
15. Reconcile cron — finalize `awaiting_terminal AND payment_id IS NOT NULL`; expire abandoned prepares. Never auto-refund.
16. (3rd PR, post-smoke) delete `KioskReaderPayment.tsx`, `/api/kiosk/save-card`, SAVE_CARD service fns.

## MUST verify on real hardware / Square sandbox BEFORE going live (flag flip)
1. **#1 gate:** Terminal checkout paying an unpaid GIFT_CARD-typed order + order-linked ACTIVATE loads the
   card with a NON-zero balance (the deposit.ts:391-398 "$0 PENDING card" check passes on card-present tender).
2. `GET /v2/payments/{id}` on a Terminal payment returns `order_id`, `amount_money.amount`, `status:"COMPLETED"`, `location_id`.
3. **Combo + one reader:** combo = two day-of orders (two locations) but ONE deposit order — confirm its
   `location_id` is the reader's paired location. Explicit combo terminal smoke.
4. **seed stability:** client must `rebuildRaceBillIfExpired` BEFORE prepare and NOT rebuild again before reserve.
5. `overview.cashOwed*100 === depositCents` for every kiosk product (client-side tripwire kept).
