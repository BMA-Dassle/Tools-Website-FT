# Combo Add-Guests — live smoke runbook (gate before the prod flag flips)

Feature: post-booking "add more guests" to a combo special (Ultimate VIP
Experience), on the multi-activity confirmation page. Built across 3 commits on
`feat/combo-addon`. **Ships dark** — `NEXT_PUBLIC_COMBO_ADDON_ENABLED` defaults
off; set it to `true` to enable (also requires the combo's `addon.enabled`).

Everything pure was unit-tested (`vitest`, 85 pass) and the whole app is
`tsc`-clean. What CANNOT be proven without live creds (do these before prod):

## Pre-req
- A real, **upcoming** `race-bowl` booking with a known BMI bill id (the
  confirmation page's `orderId`) and a booking record in Redis (`bookingrecord:{billId}`).
- `NEXT_PUBLIC_COMBO_ADDON_ENABLED=true` on the preview deploy. Preview uses
  **real** Square/BMI/QAMF — every purchase is a real reservation + card charge.

## 1. Quote (read-only, safe)
- `POST /api/book/add-on/quote { billId, guestCount: 1 }`.
- Expect: `quote.perPersonCents` = $65 weekday / $75 weekend; `fasttraxCents`+
  `headpinzCents` = total; `capacity.ok = true`, `lanesToAdd = 0` when the lane
  has room. Try a count that crosses 6/lane → `lanesToAdd = 1`. Try a huge count
  → blocked with `maxAddable`.
- **Verify the heat-freeSpots lookup works server-side** (the `/api/bmi` proxy
  via origin) — capacity should reflect the real heat's remaining spots.

## 2. Purchase — same-lane (1 guest) — THE money path
- Add 1 guest, real card you will refund.
- Verify, in Square + BMI + QAMF directly (not logs):
  - **Square:** two day-of orders created (1 FastTrax racing, 1 HeadPinz
    bowling), left OPEN; one gift card minted; the **card charge = sum of the two
    tax-inclusive order totals**. ⚠️ Confirm this equals what the customer expects
    vs the displayed `$65` (tax handling — compare against an original combo
    booking's charge to confirm the displayed/charged relationship is correct).
  - **BMI:** a NEW bill with the guest on the same Starter + Intermediate heats as
    the party, confirmed as a $0 credit; Pandora state → -3.
  - **QAMF:** a new reservation at the same lane time with the guest seated;
    Confirmed; memo says "ADD-ON — seat with original party (lane N)".
  - **Neon:** a `race` row (bmiBillId = new bill, squareDayofOrderId = FT order)
    and an `open` bowling row (qamfReservationId, squareDayofOrderId = HP order),
    both with `comboSpecialId` + gift card.
  - **Booking record:** `racers[]` appended, `comboAddons[]` entry added.
  - **Emails:** staff add-on alert + (confirm guest receipt wiring).
- **Idempotency:** replay the same `idempotencyKey` → no second charge, no
  duplicate heats/reservation.

## 3. Purchase — new-lane (enough guests to cross 6/lane)
- Verify a SECOND QAMF reservation is created at the same slot (its own lane) and
  its HP order settles at that lane's lane-open.

## 4. Settlement at check-in
- Open the lane / run race-dayof-pay and confirm the add-on's FT + HP orders
  settle from the add-on gift card (no shortfall — tax covered).

## Known decisions / follow-ups
- v1 treats every added guest as a NEW racer (license folded into the flat price).
  Returning-racer lookup (personId, skip license) is a later enhancement.
- The add-on always creates its OWN QAMF reservation for added bowlers (clean
  settlement); staff seat them with the party. A future refinement could merge
  onto the existing reservation if settlement is reworked.
- Tax: the charge mirrors `unifiedReserve` (tax-inclusive day-of total). Confirm
  the displayed-vs-charged relationship in step 2 before enabling in prod.
