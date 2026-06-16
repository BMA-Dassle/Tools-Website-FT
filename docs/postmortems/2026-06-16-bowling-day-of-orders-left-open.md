# Post-Mortem: Bowling day-of Square orders left OPEN (not reported as completed sales)

- **Date of incident:** 2026-05-09 → 2026-06-16 (≈5½ weeks, ongoing until remediated)
- **Date detected:** 2026-06-16
- **Date resolved:** 2026-06-16 (historical backlog); root-cause fix still open (see Action Items)
- **Author:** Eric Osborn / Claude
- **Severity:** Medium — reporting/bookkeeping integrity. **No revenue loss; no customer impact.**
- **Status:** Backlog remediated. Recurrence prevention not yet deployed.

---

## Summary

Starting the day the v2 day-of Square order flow launched (2026-05-09), every web-booked
bowling/KBF/race/attraction day-of order was left in Square order state **OPEN** after the
guest paid — even though the order was fully tendered (gift card redeemed, `net_amount_due = $0`).

By 2026-06-16 this had accumulated to **1,498 orders totaling $133,005.63** sitting OPEN but
paid in full. Because Square's item-sales/orders reporting and the downstream QuickBooks sync
key off _completed_ sales, these paid orders were not being reported as closed revenue, which
surfaced during a QuickBooks reconciliation check.

The money was never at risk — payments were captured and settled on the original sale dates, and
**the orders were showing in Square the whole time** (in the OPEN state). They simply were not
**importing into QuickBooks**, because the Square→QuickBooks sync only pulls _completed_ sales.
The defect was purely that the orders were never transitioned `OPEN → COMPLETED`.

Group-function (pre-paid group event) orders were **not** affected — their balance-payment flow
already completes the order.

---

## Impact

- **1,498** web day-of orders left OPEN-but-paid (2026-05-09 through 2026-06-15).
  - open (bowling): 1,240 orders / $127,496.67
  - kbf (kids bowl free): 258 orders / $5,508.96
  - By month: May $76,151.79 (776) · June $56,853.84 (722)
- **The orders were present and visible in Square the entire time** — they were never missing or
  lost. They showed in the Square Orders list (in the OPEN/unfulfilled state) with the correct
  amounts and captured gift-card tenders. The **only** failure was that they never **imported into
  QuickBooks**, because the Square→QuickBooks sync pulls _completed_ sales and these orders were
  stuck in OPEN state. Completing them is what makes them eligible to import.
- **Reporting gap, not revenue loss.** Payment-based Square reports (Transactions/Payments,
  deposits) counted this money on the correct days. Item-level Sales reporting, the Square
  Orders view's completed filter, and the Square→QuickBooks sync (which pull _completed_ sales) did not.
- **No customer impact.** Lanes opened, sessions ran, loyalty accrued (Square allows loyalty
  accrual on paid OPEN orders), receipts were correct.
- **Not affected — FastTrax racing & attractions.** Verified: 374 race/attraction day-of orders
  since 2026-03-01 → 311 COMPLETED, 63 OPEN (all 63 genuinely unpaid/future), **0 paid-but-OPEN**.
  The `race-dayof-pay` cron charges the gift card _and_ sets the order COMPLETED in the same step
  ([`route.ts:242`](../../apps/web/app/api/cron/race-dayof-pay/route.ts#L242)); racing orders have
  no SHIPMENT fulfillment (no KDS), so nothing blocks completion. Same complete-on-payment pattern
  as group functions.
- **Not affected:** group-function day-of orders (20/20 paid events were COMPLETED; 0 stuck),
  combo VIP legs (separate settle flow, excluded from this work).

---

## Timeline (ET)

- **2026-05-09** — v2 day-of order flow goes live. First three paid-but-OPEN orders created
  (res#17 internal test $20.22; res#36 Zach Taylor $234.30; res#57 Ramon Rodriguez $85.20).
  Orders are left OPEN from order #1 — this is not a regression that crept in.
- **2026-05-09 → 2026-06-15** — pattern runs continuously; backlog grows to 1,498 / $133,005.63.
  Sporadic completions occur (no-shows auto-closed by `bowling-no-show-close`; some manual POS
  closes), but the steady state is "paid, left OPEN."
- **2026-06-16** — During a QuickBooks reconciliation, owner notices Sunday 6/14 bowling orders
  redeemed but not reporting. Investigation confirms 63/66 of Sunday's bowling orders OPEN-but-paid,
  then a full scan finds the 1,498-order / $133K backlog dating to 2026-05-09.
- **2026-06-16** — 10-order test batch (sale day 6/09, $591.43) completed successfully to validate
  the close mechanism and let accounting observe how QBO dates the revenue (`closed_at` = today,
  not original sale day — accounting is handling attribution).
- **2026-06-16** — Full idempotent close run: **1,498 orders / $133,005.63 completed, 0 failures.**
  Verification re-scan shows 0 paid-but-OPEN past orders remaining.

---

## Root Cause

The OPEN state is **intentional in the lane-open code**, not a forgotten step.
[`apps/web/lib/bowling-lane-open.ts`](../../apps/web/lib/bowling-lane-open.ts) (~line 387):

> _"We intentionally do NOT complete the order here. Square requires all fulfillments to be
> COMPLETED before the order can transition to COMPLETED. Completing the SHIPMENT fulfillment
> removes it from KDS within milliseconds — before staff can see shoe sizes and items. Instead
> we leave the order OPEN (fully paid, $0 due)... **Staff complete the order on the POS when the
> session ends**, which also dismisses it from KDS at the right time."_

So the design relies on a **manual operational step**: staff completing the order on the POS at
end of session. Two things combined to cause the incident:

1. **The manual step largely doesn't happen.** Staff leave orders open; there is no enforcement
   or reminder. ~1,500 orders over 5½ weeks went unclosed.
2. **No automated safety net for checked-in paid orders.** The only auto-close cron,
   `bowling-no-show-close`, completes _no-show_ orders. There is no equivalent end-of-night sweep
   that completes _checked-in, paid_ orders once the session is over and the KDS no longer needs
   the fulfillment.

Why group functions were fine: the GF balance-payment path tenders the gift card to the day-of
order **and** sets the order COMPLETED in the same flow — it never depends on a manual POS close.

---

## Resolution

Built an idempotent closer ([`apps/web/scripts/close-all-open-paid-past.mts`](../../apps/web/scripts/close-all-open-paid-past.mts))
mirroring the proven `completeOrderNoFulfillment` helper in `bowling-no-show-close`:

1. Select past-session, non-combo web day-of orders.
2. Re-fetch each order live; skip anything not `OPEN` / not `$0-due` / `total ≤ 0` (idempotent).
3. Complete any open fulfillment (KDS no longer needs it for a past session).
4. `PUT` order `state = COMPLETED`.

Result: 1,498 completed / $133,005.63 / 0 failures. Re-scan confirms backlog cleared.

**Note on accounting period:** completion sets `closed_at` to the run date (2026-06-16), not the
original sale date. Whether QBO books revenue on the original payment date or `closed_at` was the
purpose of the 10-order test; accounting is handling date attribution on their side.

---

## What went well

- Detection via routine reconciliation caught it before quarter/year close.
- The money was always safe — captured on the right days.
- A proven, no-fulfillment completion helper already existed (`bowling-no-show-close`), so the
  fix mirrored battle-tested code rather than inventing a new path.
- The closer is idempotent and was dry-run-validated (1,498 would-close, 0 failures) before any write.

## What went wrong

- A design that depends on a manual operational step had no monitoring and no automated fallback.
- The reporting gap went unnoticed for 5½ weeks because payment-based reports _looked_ correct.
- No alert on "paid orders left OPEN > N hours."

---

## Action Items

| #   | Action                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Owner      | Status                    |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------- |
| 1   | **Close the order when the session ends (event-driven), with a cron backstop.** Primary: on the QAMF `reservation.updated → Completed` transition (lanes closed = session over), `completeReservationOrder` ([`lib/bowling-order-complete.ts`](../../apps/web/lib/bowling-order-complete.ts)) closes the fulfillment + order in a SEPARATE call from lane-open (the order is final after lane-open). Hooked into the QAMF webhook (fire-and-forget) and the `bowling-events-consumer` polling fallback. Backstop: `reservation-status-close` cron (every 30 min) runs `completeCheckedInOrders` for any checked-in, paid, non-combo bowling/KBF order 3h+ past session start that the event path missed. All three share the `dayof_order_completed_at` idempotency guard. No-shows remain on `bowling-no-show-close`. | Eng        | **DONE (pending deploy)** |
| 2   | Close **today's (6/16)** orders — handled automatically by Action #1 (event-driven on session end, or the cron backstop).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Eng        | **DONE (auto)**           |
| 3   | Confirm with accounting how the Square→QuickBooks sync dates revenue (original payment date vs `closed_at`) so future closes land in the right period.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Accounting | OPEN                      |
| 4   | Add monitoring/alert: "web day-of orders OPEN with $0 due older than X hours."                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Eng        | OPEN                      |
| 5   | Capture this in `tasks/lessons.md` (design that relies on a manual step needs an automated safety net + monitoring).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Eng        | OPEN                      |

---

## Lessons

- **A design that offloads a step to manual operations is not "done" without an automated safety
  net and monitoring.** The KDS trade-off (leave OPEN during the session) was sound; the missing
  piece was closing the order _after_ the session, which was left to humans and silently didn't happen.
- **Payment-based reports can mask order-state problems.** Revenue looked right in the money reports
  while the orders that produce item-level/QBO reporting were never closed. Reconcile _order state_,
  not just payments.
- **Compare against the working sibling.** Group functions already solved this (complete-on-payment);
  the bowling path diverged. When one flow works and a parallel one doesn't, diff them first.
