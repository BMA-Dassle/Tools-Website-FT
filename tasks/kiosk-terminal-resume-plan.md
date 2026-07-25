# Kiosk Terminal — captured-but-unreserved recovery

## Incident (2026-07-24, HeadPinz FM)
Guest paid $42.60 laser tag on the reader (bill `63000000005972942`, deposit order
`7Dt43acaRQEjgXVfepUi2JVJgkWZY`), but `reserve-all` NEVER ran → no booking, no Neon row,
GIFT_CARD line never activated. Re-entry replayed the SAME (now-COMPLETED) deposit order
(`dep-order-${baseKey}`, baseKey = BMI bill id — the intended double-charge guard) and
re-armed the reader → Square `BAD_REQUEST [checkout.order_id]: order state=COMPLETED`
dead-end. Money captured, zero automated recovery.

Root cause: the reader captured without the kiosk client observing COMPLETED (client
180s deadline auto-cancel raced the physical tap, or browser drop), so
`onCaptured → reserve-all` never fired. No resume path; no server-side backstop.

## Design principle
The deterministic replay (`dep-order-${baseKey}`) is CORRECT and stays (prevents double
capture). The fix: when that one order is already COMPLETED, **resume** the booking from
the already-captured payment (idempotent `reserve-all` with `externalPayment`) — never
re-arm, never mint a new order (that would reopen double-charge). No cron.

## PR1 — Inline resume (ship first; pure app code, flag-gated by kioskTerminalEnabled)
- [ ] `square-terminal.ts`: add `getOrderPaymentInfo(orderId) → { state, paymentId }`
      (GET /v2/orders/{id}; paymentId from `order.tenders[].payment_id`). Source of truth
      for the captured payment even when the anchor wasn't stamped.
- [ ] `unified-reserve.ts` (prepareOnly branch): after the idempotent `createDepositOrder`,
      check the order state. If COMPLETED → resolve paymentId via getOrderPaymentInfo →
      return `{ __prepare:true, alreadyPaid:true, paymentId, seed, depositOrderId,
      depositCents, locationId }`. Do not write a fresh anchor / re-run GZ startTxn.
- [ ] `reserve-prepare/route.ts`: pass `alreadyPaid` + `paymentId` through.
- [ ] `KioskTerminalCheckoutGate.prepare()`: if `alreadyPaid && paymentId`, skip the reader
      and call `onCaptured({ paymentId, depositOrderId, amountCents: depositCents, seed })`
      → CheckoutStep's existing idempotent externalPayment reserve path books it (or →
      paid-unconfirmed if the bill was since cancelled — correct, not a dead-end).
- [ ] Defense in depth — `createTerminalCheckout` / terminal-checkout route +
      `KioskReaderCheckout.start()`: on Square "order COMPLETED" error, return
      `{ alreadyPaid:true }`, fetch paymentId, call `onCaptured` instead of the dead-end
      error. Guarantees the "order must be OPEN" screen can never surface again.

### PR1 verification
- Preview: simulate client drop after capture → re-entry resumes & books (no error screen).
- Idempotency: resume's reserve-all re-derives dep-order-${baseKey}, funds one GC once.
- Cancelled-bill path → paid-unconfirmed (not reader error).
- displayed==charged untouched (no new charge).
- tsc + eslint (incl. react-hooks + jsx-a11y) + a11y-gate + single turbo build.

## PR2 — Full server-side rebuild via Square webhook (walk-away case)
booking-record is only a SUMMARY — not enough to rebuild reserve-all. So:
- [ ] Persist the full reserve input at prepare: stash `{ session, contact }` in Redis
      keyed by seed (e.g. `kiosk:terminal:reserveinput:${seed}`, TTL 48h) alongside the
      existing terminal anchor.
- [ ] `/api/webhooks/square` (`payment.updated` → COMPLETED), Square signature-verified.
      On a completed terminal payment whose order reference_id = a kiosk seed AND no
      confirmed reservation (`bmi:confirmed:${bill}` / Neon miss): load the persisted
      input and call `unifiedReserve({ ...input, externalPayment:{ paymentId,
      depositOrderId, amountCents, seed } })` — verbatim, fully idempotent via baseKey.
- [ ] If the bill is dead (cancelled) → auto-refund the captured payment + staff alert
      (Teams/radio) instead of booking.
- [ ] Owner action: configure the Square webhook subscription + signature key.

### PR2 sequencing note
PR1 fixes the dead-end you saw and auto-recovers the common immediate-retry case with zero
infra. PR2 (public money-moving webhook + signature verification + dashboard config) ships
after PR1 proves out — not bundled into the same commit.
