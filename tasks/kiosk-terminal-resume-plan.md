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

## PR2 — Full server-side rebuild via Square webhook (walk-away case) — BUILT
booking-record is only a SUMMARY — not enough to rebuild reserve-all, so we persist the
real input. The join is the DEPOSIT ORDER id (what the webhook has: `payment.order_id`),
NOT the seed — the order's Square reference_id is the deposit note, not the seed.
- [x] `unified-reserve`: `writeTerminalReserveRecovery(orderId, { seed, session, contact,
      depositCents, locationId })` / `readTerminalReserveRecovery(orderId)` — Redis
      `kiosk:terminal:recovery:${orderId}`, 48h TTL. Written at prepare next to the anchor.
- [x] `/api/webhooks/square` (`payment.updated`/`payment.created`), signature-verified
      (base64 HMAC-SHA256 of notificationUrl+rawBody, `x-square-hmacsha256-signature`).
      On a COMPLETED payment whose `order_id` has a recovery record AND no confirmed
      reservation (`bmi:confirmed:${bill}` miss): NX-lock, then
      `unifiedReserve({ session, contact, externalPayment:{ paymentId, depositOrderId,
      amountCents, source:"terminal" } })` — verbatim, idempotent via baseKey.
- [x] Dead bill (BillExpiredError) or reserve error → durable orphan marker
      `kiosk:terminal:orphan:${orderId}` + radio alert to venue FOH. NEVER auto-refunds
      (forward-recovery rule — deposit stays put; a human refunds/rebooks).
- [ ] OWNER ACTION (required to arm — dormant until then):
      1. Square dashboard → Developers → Webhooks → add subscription to the PROD URL
         `https://<prod-host>/api/webhooks/square`, events `payment.updated` (+ optionally
         `payment.created`).
      2. Set env `SQUARE_WEBHOOK_SIGNATURE_KEY` (from the subscription) and
         `SQUARE_WEBHOOK_NOTIFICATION_URL` (the exact subscribed URL) on the Vercel project.
      Until the key is set the route fail-closes (401) — safe no-op.

### Sequencing
PR1 (branch fix/kiosk-terminal-captured-resume) fixes the dead-end + auto-recovers the
re-entry case with zero infra. PR2 (branch fix/kiosk-terminal-webhook-reconcile, STACKED on
PR1) adds the walk-away backstop. Merge PR1 first, then PR2.
