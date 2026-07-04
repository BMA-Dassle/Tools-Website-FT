# Combo (Ultimate VIP) Cancellation + Refund — one-click close-out

**Status: IMPLEMENTED 2026-07-03** on branch `feat/cancel-refund-improvements` — and generalized
well past combos. The cancellation cascade (`apps/web/src/features/cancellation/`) executes
exactly the sequence below for EVERY reservation kind (bowling, race, attraction, mixed carts,
VIP combos), driven from `POST /api/admin/reservations/cancel` (dry-run preview + two
outcomes: refund to card, or a store-credit gift card with a Square-generated GAN). The
portal's Cancel button + the VIP card's "Cancel Combo" both use it; the legacy
`/api/admin/bowling/reservations/cancel` route delegates to the same cascade, so even stale
tabs now cancel BOTH legs. Guest self-serve (HeadPinz FastTrax Gift Card only) shipped ON
without flags per owner call 2026-07-03. The manual close-out below remains as the
historical spec + fallback runbook.

_(Original spec, proven 2026-06-30 — Valentino Alvarez, W46405 / short `itL0Um08`.)_

## Why this is needed

VIP combos (`race-bowl`) have **no cancellation path**. Standalone bowling/KBF rows get a "Cancel & Refund" button in the reservations portal (`/api/admin/bowling/reservations/cancel`), but a combo spans two Neon legs + two day-of Square orders + one shared internal gift card + a BMI racing reservation. Cancelling one piece (e.g. the bowling leg, or the BMI side) leaves the rest dangling, which is exactly what staff hit: card refunded, but gift card still loaded, both day-of orders still OPEN, and the combo still on the active board.

## The combo money flow (so the cleanup makes sense)

A VIP combo charges the customer **once** and uses an internal gift card as a pass-through:

1. **Deposit order** (e.g. `N6m9pwHK…`, state COMPLETED) — the customer's single card charge. Total = racing + bowling (e.g. $207.68 = $140.58 + $67.10). Tendered by CARD.
2. That charge **funds one internal gift card** (GAN `WEBHPFM…` — the digits mirror the BMI bill id suffix). The card is ACTIVATEd for the full amount. **Not customer-facing** — it's a deposit-tracking instrument.
3. **Two day-of orders** are created OPEN (racing → FastTrax FM location, bowling → HeadPinz FM location). At the venue, each is tendered **against the gift card** at lane-open / check-in.

The two legs correlate by the **shared gift card** + shared deposit/day-of order ids — **NOT** by `combo_special_id` (that's the combo *type*, `race-bowl`, shared by every combo).

## What a full cancellation must do

Given the customer's card refund is the ONLY money that moves, the rest is internal cleanup. **Never issue a second refund** — refunding the card AND the gift card double-pays (~2×).

1. **Refund the card payment** — full `refunded_money` back to the card (one PENDING refund on the deposit-order payment). This is the only customer-facing money movement.
2. **Drain the internal gift card** to $0 — `POST /v2/gift-cards/activities` type `ADJUST_DECREMENT`, reason `PURCHASE_WAS_REFUNDED`, amount = current balance, `location_id` from the ACTIVATE activity. (Square does NOT auto-deactivate a gift card when its funding payment is refunded — left alone it's phantom redeemable balance.)
3. **Cancel both OPEN day-of orders** — `PUT /v2/orders/{id}` state `CANCELED`. **Guard: refuse if the order has any tender** (means it was actually paid → different path, do not blind-cancel).
4. **Cancel the BMI racing reservation** (the leg with `bmi_bill_id` / `bmi_reservation_number`). NOTE: in the 6/30 case staff had already cancelled BMI manually — wire this into the button so it's not a separate manual step.
5. **Cancel the QAMF bowling reservation** if present (`qamf_reservation_id`) — reuse the existing bowling cancel path.
6. **Mark BOTH Neon legs `status='cancelled'`** (+ `cancelled_at`, `square_refund_id`, `refund_cents`). The portal hides a combo only when **every** leg is `cancelled`/`completed` (`allCancelled` in `ReservationsClient.tsx` ~line 2018) AND "Active Only" is on — so cancelling just one leg does NOT remove it from the board.

## Hard guards (learned from the manual run)

- Re-fetch every Square object live immediately before mutating it.
- Decrement EXACTLY the current gift-card balance; skip if not ACTIVE or already $0.
- Refuse to cancel any order with `tenders.length > 0`.
- Idempotent: safe to re-run (skip already-cancelled orders / already-drained card / already-cancelled legs).
- Operate on the resolved leg set only — never expand by `combo_special_id`.

## Reference: the proven one-off scripts (2026-06-30)

- `apps/web/scripts/_itl0um08-diag.mts` — read-only full trace from a billId: both legs, orders, payments, refunds, gift-card activities.
- `apps/web/scripts/_itl0um08-close.mts` — dry-run-by-default close-out (drain gift card + cancel 2 orders + cancel Neon leg) with the guards above.

These are scratch (`_`-prefixed) one-offs hardcoded to one booking; generalize them into the portal action. Square + Neon both work from a dev machine; QAMF creds are Vercel-only, so the QAMF-cancel leg can't be scripted locally (see lessons).

## Related

- `tasks/lessons.md` — combo split orders, combo open-leg-stuck-OPEN, no-bowling-past-start auto-settle.
- Memory: "Combo Split Orders", "Combo Bowling Leg Incomplete", "VIP Portal Integration".
