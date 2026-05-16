# BMI Bug Report: Check-In Double-Deducts Race Credits

**Severity: Critical** — every online credit-booked race costs the
customer 2 credits instead of 1.

**Date:** 2026-04-24
**Client:** headpinzftmyers (FastTrax Entertainment)
**Reporter:** Eric Osborn

## Summary

When a customer books a race online using a race credit, BMI correctly
deducts **one** credit at booking time via `booking/book` and marks the
bill as Paid. When the same customer physically checks in at the track,
**BMI deducts a second credit** from their account even though the bill
is already in a Paid state.

Tested with two confirm-payload variants (`depositKind: 2 / Credit`
and `depositKind: 0 / Money`) — **both exhibit the bug**. The trigger
is not our settlement tag; it's in BMI's check-in handler.

## Evidence: two independent reproductions

Test person: personId `409523` (Eric Osborn)

### Test A — `payment/confirm` with `depositKind: 2` (Credit)

Reservation **W28792**, orderId `63000000003256749`, Starter Race
Blue weekend.

| Event | Race Comp | Race Membership | Notes |
|---|---|---|---|
| Pre-booking | 11 | 1 | baseline |
| `booking/book` | 11 | 0 | Membership auto-applied (−1 on overview totals). Correct. |
| `payment/confirm` `amount:0 depositKind:2` | 11 | 0 | Bill state = Paid, status 0. Correct. |
| **Physical check-in** | **10** | 0 | **Second credit deducted. BUG.** |

### Test B — `payment/confirm` with `depositKind: 0` (Money)

Reservation **W28881**, orderId `63000000003257765`, Starter Race
Blue weekend.

| Event | Race Comp | Notes |
|---|---|---|
| Pre-booking | 11 | (Race Comp had been restored between tests) |
| `booking/book` | 10 | Comp auto-applied (−1 on overview totals). Correct. |
| `payment/confirm` `amount:0 depositKind:0` | 10 | Bill state = Paid, status 0. Correct. |
| **Physical check-in** | **9** | **Second credit deducted. BUG present with Money depositKind too.** |

Both bills: `status: 0` from `payment/confirm`, reservationNumber
returned normally, visible as Paid in BMI Office **before** check-in.
In both cases BMI's check-in action produced a `−1` debit on a
`Credit - Race *` deposit despite no outstanding balance.

## Reproduction steps (public API)

```
1. POST /public-booking/{clientKey}/booking/book
   body: { productId, quantity:1, resourceId, proposal:{blocks,productLineId}, personId }
   → returns orderId, auto-applies credit to bill

2. GET /public-booking/{clientKey}/order/{orderId}/overview
   → total array shows { amount:-1, depositKind:2 }  (credit applied)

3. POST /public-booking/{clientKey}/payment/confirm
   body: { id:uuid, paymentTime:now, amount:0, orderId, depositKind: (0 OR 2) }
   → returns status:0, reservationNumber

4. Physically check the racer in via BMI Office (staff action)
   → SECOND credit debit posted against the person's deposit journal
```

## Our side: verified clean

- Grepped every file in `app/**/*.{ts,tsx}` matching `check-in|checkin`.
  None call `payment/confirm`, `booking/sell`, or reference `depositKind`.
  Check-in pages are display-only (QR code, check-in time, location).
- Physical check-in is performed by front-desk staff in BMI Office —
  there is no FastTrax-side code involved.
- Therefore: the second credit deduction originates entirely inside
  BMI's check-in handler.

## Impact

Every online race booking paid with a race credit costs the customer
**2 credits** instead of 1. This is silently draining customer credit
balances. Customers have started noticing and reporting it.

## Request

Investigate the BMI Office check-in action / event handler for a code
path that re-invokes the deposit/credit pipeline against a bill that
is already in Paid state.

Expected behavior at check-in: **no-op on the financial ledger** —
the bill was settled at `payment/confirm`.

## Artifacts still live in BMI for inspection

| Reservation | OrderId | Confirm depositKind | Credit at booking | Credit at check-in |
|---|---|---|---|---|
| W28792 | 63000000003256749 | 2 | Race Membership (−1) | Race Comp (−1) ← EXTRA |
| W28881 | 63000000003257765 | 0 | Race Comp (−1) | Race Comp (−1) ← EXTRA |

Both on personId `409523` (Eric Osborn). Pull the deposit journal for
this person on 2026-04-24 — expect four debit entries across these
two bills when the expected count is two.
