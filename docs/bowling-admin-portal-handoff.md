# Bowling Reservation Admin — Portal Developer Handoff

## Overview

The bowling reservation admin page (`/admin/{token}/reservations`) is a single-page dashboard for managing all online bowling bookings across both HeadPinz centers (Fort Myers & Naples). It is the primary tool for front desk staff and managers to monitor, modify, and troubleshoot reservations.

**Live URL:** `https://headpinz.com/admin/{ADMIN_CAMERA_TOKEN}/reservations`

---

## System Architecture

Three external systems are involved in every reservation:

| System              | Role                                                                                                                                                                 |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **QAMF Conqueror**  | Lane management system — holds the reservation, assigns lanes, tracks status (Temporary → Confirmed → Running → Completed)                                           |
| **Square**          | Payment processing — deposit order (charged at booking), day-of order (open order with full line items for KDS), gift card (holds deposit for lane-open application) |
| **Neon (Postgres)** | Our database — source of truth linking QAMF + Square, stores guest info, status, and all IDs                                                                         |

---

## Page Layout & Features

### Filter Bar

| Control                | Behavior                                                 |
| ---------------------- | -------------------------------------------------------- |
| **Date picker**        | YYYY-MM-DD input; defaults to today (Eastern Time)       |
| **Center dropdown**    | "All Centers", "Fort Myers", "Naples"                    |
| **Active Only toggle** | Hides cancelled and completed reservations (default: on) |
| **Today button**       | Jumps date picker to today                               |
| **← / → arrows**       | Navigate one day back/forward                            |
| **Date label**         | Shows formatted date (e.g. "Sat, May 10")                |

### Search

Free-text search filters the table client-side across: guest name, email, phone, QAMF ID, notes, lane number, and Neon ID. Case-insensitive, instant filtering.

### Stats Bar

When data is loaded, shows aggregate stats for the filtered view:

- **Active count** — non-cancelled, non-completed reservations
- **Hidden count** — how many cancelled/completed are being hidden
- **Bowlers** — total player count across visible reservations
- **Deposits** — sum of all deposit amounts
- **Total revenue** — sum of all booking totals

---

## Table Columns

| Column      | Content                         | Details                                                                                                                                                                                                                                                           |
| ----------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Time**    | Booking start time              | Formatted in ET (e.g. "8:15 PM")                                                                                                                                                                                                                                  |
| **Guest**   | Name, phone, center badge       | Center shown as colored badge ("FM" = blue, "NAP" = purple)                                                                                                                                                                                                       |
| **Type**    | Product kind + player count     | "KBF" (purple) or "Open" (blue) badge, followed by bowler count (e.g. "6p")                                                                                                                                                                                       |
| **Status**  | Reservation status badge        | Color-coded: green=Confirmed, yellow=Pending, red=Failed, blue=Arrived, gray=Completed, muted=Cancelled                                                                                                                                                           |
| **Lane**    | Assigned lane number(s)         | Shows lane from QAMF when reservation goes "Running" (e.g. "25" or "17,18"). Bold green text. Dash if no lane yet.                                                                                                                                                |
| **Order**   | Food items summary              | Shows kitchen-relevant items only: Pizza Bowl Pizza, Pizza Bowl Soda Pitcher, Chips & Salsa. Quantity shown if > 1.                                                                                                                                               |
| **Square**  | Day-of order status             | Clickable badge: "Sent" (green) = deposit applied to day-of order at lane open, "Pending" (gray) = order exists but not processed yet, "ERR" (red) = processing failed. Clicking opens order details modal. Shows last 8 chars of payment ID if payment was made. |
| **Alert**   | Pre-arrival notification status | "Sent" badge (green) = SMS/email sent ~30 min before booking time. Timestamp shown on hover. Dash if not yet sent.                                                                                                                                                |
| **Payment** | Deposit / Total breakdown       | Shows deposit (green) and total (gray) amounts. "Free" for $0 bookings. Red text for refund amounts.                                                                                                                                                              |
| **Ref**     | QAMF ID + confirmation link     | QAMF reservation ID (e.g. "X147867") or "#neonId" fallback. "link" opens confirmation page. "cp" button copies short URL to clipboard (toggles to "ok" for 1.5s).                                                                                                 |
| **Actions** | Action buttons                  | Up to 3 buttons per row (see Actions section below)                                                                                                                                                                                                               |

---

## Actions

### Reschedule (cyan "Time" button)

- **Visible when:** Not cancelled/completed AND has a QAMF ID
- **Opens:** Reschedule modal
- **Flow:**
  1. Fetches current booking info and QAMF web offer details via `GET /api/admin/bowling/reservations/reschedule/info`
  2. Shows date picker defaulting to current booking date
  3. Loads available time slots via `GET /api/bowling/v2/availability` (filtered by `webOfferId`)
  4. User picks a new time slot
  5. Submits reschedule via `POST /api/admin/bowling/reservations/reschedule`: deletes old QAMF reservation, creates new one at new time, confirms it, updates Neon
  6. Automatically re-sends confirmation email/SMS
- **Constraints:** Can only reschedule within the same experience/web offer. Price and deposit stay the same.

### Resend Confirmation (blue "Resend" button)

- **Visible when:** Not cancelled AND guest has email or phone
- **Opens:** Resend modal
- **Options:**
  - Channel: "Both", "Email only", "SMS only"
  - Optional override phone number
  - Optional override email address
- **Shows:** Guest context (name, phone, email, product type, time, center)
- **Result:** Toast notification with send results ("Email sent", "SMS sent", or failure)

### Cancel & Refund (red "Cancel" button)

- **Visible when:** Not already cancelled
- **Opens:** Cancel confirmation modal
- **Shows:** Full reservation details (guest, time, date, center, bowlers, deposit amount)
- **Warning:** Explains that QAMF reservation will be cancelled and deposit will be fully refunded
- **Buttons:** "Keep It" (cancel action) / "Cancel & Refund" (proceed)
- **Flow:** Cancels in QAMF (best-effort) → processes Square refund → marks cancelled in Neon
- **Note:** No time restrictions — unlike customer-facing cancel which has a 1-hour cutoff

### Force Confirm (not in UI — API only)

- **Endpoint:** `POST /api/admin/bowling/force-confirm`
- **Use case:** Rescue reservations stuck in `confirm_pending` or `confirm_failed` status
- **Handles:** QAMF reservation still exists (confirm it), already confirmed (sync Neon), or expired (recreate from stored data)

---

## Square Order Details Modal

Triggered by clicking the Square column badge on any reservation.

**Displays:**

- Square order ID
- Order state badge (OPEN, COMPLETED, CANCELLED, etc.)
- Total amount and remaining amount due
- Line items table: item name, quantity, unit price, line total
- Line item notes (e.g. "Lane 12 | Pepperoni") shown italicized below item name

**Use case:** Staff can verify what's on the kitchen display (KDS), check if shoe sizes were submitted, and see the payment status of the day-of order.

---

## Automated Background Processes

These aren't part of the admin page UI but affect what staff see:

### Pre-Arrival Notifications (cron, every 2 min)

- Sends SMS + email ~30 min before booking time
- Prompts guests to enter player names, shoe sizes, and bumper preferences on the confirmation page
- Tracked via `preArrivalSentAt` column; shows as "Sent" in the Alert column

### Lane-Open Processor (event-driven + polling fallback)

When QAMF signals a reservation has gone "Running" (lanes opened):

1. Prepends lane number to kitchen display item notes (e.g. "Lane 12 | Pepperoni")
2. Applies gift card balance (deposit) against the day-of Square order
3. Updates Neon with lane assignment and payment info
4. Status moves to "arrived"

### QAMF Event Consumer (cron, every 2 min)

Polls QAMF webhook events and syncs status changes to Neon:

- `Confirmed` → confirmed
- `Running` → arrived (triggers lane-open processor)
- `Completed` → completed
- `Cancelled` → cancelled

---

## QAMF Memo Format

When a reservation is created or backfilled, the QAMF Notes field is set to:

```
SHOES NOT INCLUDED | headpinz.com/s/abc123
2x 1.5 Hr Fri-Sun $120.00 + 2x Shoe Rental $12.00
Deposit $140.76 paid (incl. tax)
Happy birthday party!
```

**Line 1:** Shoe status + short URL (always first for staff visibility)

- `{N} pairs shoes paid` — if shoe add-on was purchased
- `Shoes included` — if experience includes shoes (Fun 4 All, Pizza Bowl)
- `SHOES NOT INCLUDED` — staff must collect at lane
- Pipe-separated short URL to the confirmation page

**Line 2:** Line items with quantities and prices

**Line 3:** Tax-inclusive deposit amount

**Line 4:** Customer notes (if any)

---

## Data Model (Neon)

### `bowling_reservations` table

| Column                    | Type        | Description                                                               |
| ------------------------- | ----------- | ------------------------------------------------------------------------- |
| id                        | SERIAL      | Primary key (Neon ID)                                                     |
| center_code               | TEXT        | TXBSQN0FEKQ11 or PPTR5G2N0QXF7                                            |
| product_kind              | TEXT        | open, kbf, hourly                                                         |
| qamf_reservation_id       | TEXT        | QAMF Conqueror ID (e.g. X147867)                                          |
| square_deposit_order_id   | TEXT        | Square order for deposit charge                                           |
| square_deposit_payment_id | TEXT        | Square payment ID for deposit                                             |
| square_dayof_order_id     | TEXT        | Square day-of order (full items)                                          |
| square_gift_card_id       | TEXT        | Square eGift card ID                                                      |
| square_gift_card_gan      | TEXT        | Gift card account number                                                  |
| deposit_cents             | INT         | Tax-inclusive deposit charged                                             |
| total_cents               | INT         | Full booking total                                                        |
| status                    | TEXT        | confirmed, confirm_pending, confirm_failed, arrived, completed, cancelled |
| booked_at                 | TIMESTAMPTZ | Session start time (UTC)                                                  |
| player_count              | INT         | Number of bowlers                                                         |
| guest_name                | TEXT        | Guest name                                                                |
| guest_email               | TEXT        | Guest email                                                               |
| guest_phone               | TEXT        | Guest phone                                                               |
| notes                     | TEXT        | Customer-supplied notes                                                   |
| cancelled_at              | TIMESTAMPTZ | When cancelled                                                            |
| square_refund_id          | TEXT        | Square refund payment ID                                                  |
| refund_cents              | INT         | Refund amount                                                             |
| short_code                | TEXT        | Short URL code                                                            |
| pre_arrival_sent_at       | TIMESTAMPTZ | Pre-arrival SMS/email timestamp                                           |
| dayof_order_sent_at       | TIMESTAMPTZ | Lane-open processing timestamp                                            |
| dayof_order_lane          | TEXT        | Lane number(s) from QAMF                                                  |
| dayof_payment_id          | TEXT        | Gift card payment ID                                                      |
| dayof_order_error         | TEXT        | Lane-open processing error                                                |
| inserted_at               | TIMESTAMPTZ | Row creation time                                                         |

### `bowling_reservation_lines` table

| Column            | Type   | Description                           |
| ----------------- | ------ | ------------------------------------- |
| id                | SERIAL | Primary key                           |
| reservation_id    | INT    | FK to bowling_reservations.id         |
| square_product_id | INT    | FK to bowling_square_products.id      |
| label             | TEXT   | Display label (e.g. "1.5 Hr Fri-Sun") |
| quantity          | INT    | Quantity purchased                    |
| unit_price_cents  | INT    | Price per unit in cents               |

---

## API Endpoints — Full Reference

All admin endpoints require `?token={ADMIN_CAMERA_TOKEN}` unless noted.

Full OpenAPI spec: [`docs/bowling-admin-api.yaml`](bowling-admin-api.yaml)

### Quick Index

| Method | Path                                              | Purpose                                        |
| ------ | ------------------------------------------------- | ---------------------------------------------- |
| GET    | `/api/admin/bowling/reservations`                 | List reservations for a date                   |
| POST   | `/api/admin/bowling/reservations/resend`          | Resend confirmation email/SMS                  |
| POST   | `/api/admin/bowling/reservations/cancel`          | Cancel + full refund                           |
| GET    | `/api/admin/bowling/reservations/reschedule/info` | Get reschedule context                         |
| POST   | `/api/admin/bowling/reservations/reschedule`      | Reschedule to new time                         |
| POST   | `/api/admin/bowling/force-confirm`                | Force-confirm stuck reservation                |
| GET    | `/api/admin/bowling/square-order`                 | View Square order line items                   |
| POST   | `/api/admin/bowling/backfill-memo`                | Backfill QAMF memos                            |
| GET    | `/api/admin/bowling/v2/experiences`               | List experiences (`x-admin-token` header)      |
| POST   | `/api/admin/bowling/v2/experiences`               | Upsert experience (`x-admin-token` header)     |
| GET    | `/api/admin/bowling/v2/square-products`           | List Square products (`x-admin-token` header)  |
| POST   | `/api/admin/bowling/v2/square-products`           | Upsert Square product (`x-admin-token` header) |
| GET    | `/api/bowling/v2/availability`                    | Search available time slots (public, no auth)  |

---

### GET `/api/admin/bowling/reservations`

List all bowling reservations for a single calendar day.

**Auth:** `?token={ADMIN_CAMERA_TOKEN}`

**Query params:**

| Param    | Type   | Required | Description              |
| -------- | ------ | -------- | ------------------------ |
| `token`  | string | yes      | Admin token              |
| `date`   | string | yes      | `YYYY-MM-DD`             |
| `center` | string | no       | Center code to filter by |

**Response `200`:**

```json
{
  "reservations": [
    {
      "id": 42,
      "centerCode": "TXBSQN0FEKQ11",
      "productKind": "open",
      "qamfReservationId": "X147867",
      "squareDepositOrderId": "abc123",
      "squareDepositPaymentId": "pay_456",
      "squareDayofOrderId": "order_789",
      "squareGiftCardId": "gc_012",
      "squareGiftCardGan": "7076...",
      "depositCents": 14076,
      "totalCents": 26400,
      "status": "confirmed",
      "bookedAt": "2026-05-10T00:15:00.000Z",
      "playerCount": 6,
      "guestName": "Jane Smith",
      "guestEmail": "jane@example.com",
      "guestPhone": "+12395551234",
      "notes": "Birthday party!",
      "cancelledAt": null,
      "squareRefundId": null,
      "refundCents": 0,
      "shortCode": "abc123",
      "preArrivalSentAt": null,
      "dayofOrderSentAt": null,
      "dayofOrderLane": null,
      "dayofPaymentId": null,
      "dayofOrderError": null,
      "insertedAt": "2026-05-08T14:30:00.000Z",
      "lines": [
        {
          "label": "1.5 Hr Fri-Sun",
          "quantity": 6,
          "unitPriceCents": 2200
        }
      ]
    }
  ]
}
```

**Errors:** `400` bad date, `401` bad token, `500` DB error

**Notes:**

- Date filtering uses column-side ET conversion: `(booked_at AT TIME ZONE 'America/New_York')::date` — so an 8 PM ET booking (stored as next-day UTC) stays on the correct calendar day.
- Auto-backfills `shortCode` on first access if missing (generates short URL and persists to DB).

---

### POST `/api/admin/bowling/reservations/resend`

Resend confirmation email and/or SMS to the guest.

**Auth:** `?token={ADMIN_CAMERA_TOKEN}`

**Request body:**

```json
{
  "neonId": 42,
  "channel": "both",
  "overridePhone": "+12395559999",
  "overrideEmail": "corrected@example.com"
}
```

| Field           | Type    | Required | Description                           |
| --------------- | ------- | -------- | ------------------------------------- |
| `neonId`        | integer | yes      | Reservation ID                        |
| `channel`       | string  | yes      | `"email"`, `"sms"`, or `"both"`       |
| `overridePhone` | string  | no       | Send to this phone instead of guest's |
| `overrideEmail` | string  | no       | Send to this email instead of guest's |

**Response `200`:**

```json
{
  "email": true,
  "sms": true
}
```

**Errors:** `400` missing fields, `401` bad token

**Notes:**

- No cooldown — admin can resend unlimited times (passes `forceResend: true` internally).
- Override values are for this send only — they do NOT update the reservation record.
- Always sets `smsOptIn: true` when admin explicitly sends.

---

### POST `/api/admin/bowling/reservations/cancel`

Cancel a reservation and fully refund the deposit.

**Auth:** `?token={ADMIN_CAMERA_TOKEN}`

**Request body:**

```json
{
  "neonId": 42
}
```

**Response `200`:**

```json
{
  "ok": true,
  "refundCents": 14076
}
```

**Errors:** `404` not found, `409` already cancelled, `502` Square refund failed

**Notes:**

- No 1-hour cutoff — unlike the customer-facing cancel endpoint, admin can cancel at any time.
- Flow: Delete from QAMF (best-effort, non-fatal) → Square refund → mark cancelled in Neon.
- Square refund only fires when both `squareDepositPaymentId` AND `squareGiftCardId` exist on the reservation.
- Uses unique idempotency key: `admin-cancel-{neonId}-{uuid}`.
- If Square refund fails (502), the cancellation is NOT recorded — staff must manually intervene.

---

### GET `/api/admin/bowling/reservations/reschedule/info`

Fetch QAMF web offer context for a reservation before rescheduling.

**Auth:** `?token={ADMIN_CAMERA_TOKEN}`

**Query params:**

| Param    | Type    | Required | Description    |
| -------- | ------- | -------- | -------------- |
| `token`  | string  | yes      | Admin token    |
| `neonId` | integer | yes      | Reservation ID |

**Response `200`:**

```json
{
  "webOfferId": 12345,
  "optionId": 67,
  "optionType": "Time",
  "centerId": 9172,
  "centerCode": "TXBSQN0FEKQ11",
  "playerCount": 6,
  "bookedAt": "2026-05-10T00:15:00.000Z",
  "guestName": "Jane Smith",
  "productKind": "open"
}
```

**Errors:** `400` bad neonId / unknown center, `404` not found or no QAMF ID, `502` QAMF GET failed

**Notes:**

- Reads the live QAMF reservation to extract `WebOffer.Id`.
- Option priority: Time > Unlimited > Game (picks the first match).
- The `centerId` and `webOfferId` from this response are passed to the availability endpoint to load time slots.

---

### POST `/api/admin/bowling/reservations/reschedule`

Move a reservation to a new time within the same experience/web offer.

**Auth:** `?token={ADMIN_CAMERA_TOKEN}`

**Request body:**

```json
{
  "neonId": 42,
  "bookedAt": "2026-05-10T22:00:00-04:00",
  "webOfferId": 12345,
  "optionId": 67,
  "optionType": "Time"
}
```

| Field        | Type    | Required | Description                                              |
| ------------ | ------- | -------- | -------------------------------------------------------- |
| `neonId`     | integer | yes      | Reservation ID                                           |
| `bookedAt`   | string  | yes      | New time as ISO 8601 with offset                         |
| `webOfferId` | integer | yes      | QAMF web offer ID (from reschedule/info)                 |
| `optionId`   | integer | no       | QAMF option ID                                           |
| `optionType` | string  | no       | `"Game"`, `"Time"`, or `"Unlimited"` (default: `"Game"`) |

**Response `200`:**

```json
{
  "success": true,
  "bookedAt": "2026-05-10T22:00:00-04:00",
  "qamfReservationId": "X148001"
}
```

**Errors:** `400` invalid input or cancelled/completed state, `404` not found, `502` QAMF failed

**Notes:**

- Multi-step: delete old QAMF (best-effort) → create new QAMF → confirm new QAMF (MUST succeed) → update Neon → resend confirmation (fire-and-forget).
- Payment (Square deposit/day-of) is NOT touched — price doesn't change.
- Resets `dayof_order_sent_at`, `dayof_order_lane`, `dayof_payment_id`, `dayof_order_error` when status moves back to `confirmed`.
- If QAMF confirmation fails, the orphaned temporary reservation is cleaned up.

---

### POST `/api/admin/bowling/force-confirm`

Rescue a reservation stuck in `confirm_pending` or `confirm_failed` status.

**Auth:** `?token={ADMIN_CAMERA_TOKEN}`

**Request body:**

```json
{
  "neonId": 42
}
```

**Response `200`:**

```json
{
  "ok": true,
  "neonId": 42,
  "qamfReservationId": "X147867",
  "action": "confirmed",
  "message": "QAMF reservation confirmed and Neon updated"
}
```

`action` is one of:

- `"confirmed"` — QAMF reservation existed as Temporary, now confirmed
- `"already_confirmed"` — QAMF reservation was already Confirmed/Arrived/Completed, Neon synced
- `"recreated_and_confirmed"` — QAMF reservation expired, rebuilt from stored line data + confirmed

**Errors:** `400` bad input or invalid state, `404` not found, `422` cannot reconstruct (missing webOfferId), `502` QAMF failed

**Notes:**

- If reservation is already `confirmed`/`arrived`/`completed`, returns early with `already_confirmed`.
- Reconstruction path joins `bowling_reservation_lines` with `bowling_experience_offers` to find the webOfferId.

---

### GET `/api/admin/bowling/square-order`

Fetch Square day-of order details (line items, state, totals).

**Auth:** `?token={ADMIN_CAMERA_TOKEN}`

**Query params:**

| Param     | Type   | Required | Description     |
| --------- | ------ | -------- | --------------- |
| `token`   | string | yes      | Admin token     |
| `orderId` | string | yes      | Square order ID |

**Response `200`:**

```json
{
  "orderId": "order_789",
  "state": "OPEN",
  "totalCents": 26400,
  "remainingCents": 12324,
  "lineItems": [
    {
      "uid": "uid_1",
      "name": "1.5 Hr Fri-Sun Bowling",
      "quantity": 6,
      "note": "Lane 12 | Size 9",
      "priceCents": 2200,
      "totalCents": 13200,
      "catalogId": "ABC123"
    },
    {
      "uid": "uid_2",
      "name": "Pizza Bowl Pizza",
      "quantity": 1,
      "note": "Lane 12 | Pepperoni",
      "priceCents": 1500,
      "totalCents": 1500,
      "catalogId": "2IKZB4O2HQBXWMTSUQ2SEKJY"
    }
  ]
}
```

`state` values: `"OPEN"`, `"COMPLETED"`, `"CANCELLED"`, etc.

**Errors:** `400` missing orderId, `404` not found in Square, `502` Square API 5xx

**Notes:**

- Calls Square API `GET /v2/orders/{orderId}` with `Square-Version: 2024-12-18`.
- Flattens Square's nested money objects to `priceCents` and `totalCents`.
- `note` contains lane-prefixed notes after lane-open processor runs (e.g. "Lane 12 | Pepperoni").

---

### POST `/api/admin/bowling/backfill-memo`

Bulk-update QAMF memo Notes for all upcoming reservations.

**Auth:** `?token={ADMIN_CAMERA_TOKEN}`

**Request body (optional):**

```json
{
  "dryRun": true
}
```

**Response `200`:**

```json
{
  "ok": true,
  "dryRun": false,
  "updated": 55,
  "total": 55,
  "results": [
    {
      "neonId": 42,
      "guestName": "Jane Smith",
      "memo": "SHOES NOT INCLUDED | headpinz.com/s/abc123\n6x 1.5 Hr Fri-Sun $132.00\nDeposit $140.76 paid (incl. tax)\nBirthday party!",
      "patched": true,
      "error": null
    }
  ]
}
```

**Errors:** `400` bad token, `500` DB error; per-row errors in `results[].error`

**Notes:**

- Processes all upcoming (booked_at ≥ now − 1 day), non-cancelled reservations with a QAMF ID.
- Also sets QAMF Title to `{guestName} ({playerCount}p)`.
- Shoe status logic:
  - Experience label matches `/fun\s*4\s*all|pizza\s*bowl/i` → `"Shoes included"`
  - Shoe add-on line item found → `"{N} pairs shoes paid"`
  - Otherwise → `"SHOES NOT INCLUDED"`
- `dryRun: true` returns the memo text in results but does not PATCH QAMF.
- Per-reservation QAMF PATCH failure is non-fatal; others continue.

---

### GET `/api/admin/bowling/v2/experiences`

List all bowling experiences across both centers.

**Auth:** `x-admin-token: {ADMIN_SECRET_TOKEN}` header (different env var from `ADMIN_CAMERA_TOKEN`)

**No query params.**

**Response `200`:**

```json
[
  {
    "id": 1,
    "slug": "open-1hr-weekday",
    "label": "1 Hr Mon-Thu",
    "kind": "open",
    "isVip": false,
    "description": null,
    "sortOrder": 10,
    "isActive": true,
    "daysOfWeek": [1, 2, 3, 4],
    "squareModifierListIds": ["MODIFIER_LIST_ABC"],
    "offers": [
      {
        "centerCode": "TXBSQN0FEKQ11",
        "qamfWebOfferId": 12345,
        "qamfOptionType": "Time",
        "qamfOptionId": 67
      },
      {
        "centerCode": "PPTR5G2N0QXF7",
        "qamfWebOfferId": 12346,
        "qamfOptionType": "Time",
        "qamfOptionId": 68
      }
    ],
    "items": [
      {
        "squareProductId": 5,
        "quantity": 1,
        "labelOverride": null,
        "sortOrder": 0
      }
    ]
  }
]
```

**Errors:** `401` bad header token

---

### POST `/api/admin/bowling/v2/experiences`

Create or update a bowling experience (upserts by `slug`).

**Auth:** `x-admin-token: {ADMIN_SECRET_TOKEN}` header

**Request body:**

```json
{
  "slug": "open-1hr-weekday",
  "label": "1 Hr Mon-Thu",
  "kind": "open",
  "isVip": false,
  "description": "Standard weekday bowling",
  "sortOrder": 10,
  "isActive": true,
  "daysOfWeek": [1, 2, 3, 4],
  "squareModifierListIds": ["MODIFIER_LIST_ABC"],
  "offers": [
    {
      "centerCode": "TXBSQN0FEKQ11",
      "qamfWebOfferId": 12345,
      "qamfOptionType": "Time",
      "qamfOptionId": 67
    }
  ],
  "items": [
    {
      "squareProductId": 5,
      "quantity": 1,
      "labelOverride": null,
      "sortOrder": 0
    }
  ]
}
```

| Field                   | Type      | Required    | Default                                      |
| ----------------------- | --------- | ----------- | -------------------------------------------- |
| `slug`                  | string    | yes         | —                                            |
| `label`                 | string    | yes         | —                                            |
| `kind`                  | string    | yes         | — (`"kbf"`, `"open"`, `"hourly"`)            |
| `isVip`                 | boolean   | no          | `false`                                      |
| `description`           | string    | no          | `null`                                       |
| `sortOrder`             | integer   | no          | `0`                                          |
| `isActive`              | boolean   | no          | `true`                                       |
| `daysOfWeek`            | integer[] | no          | `[0,1,2,3,4,5,6]` (all days)                 |
| `squareModifierListIds` | string[]  | no          | `[]`                                         |
| `offers`                | array     | yes (min 1) | —                                            |
| `items`                 | array     | no          | — (if provided, replaces ALL existing items) |

**Response `200`:**

```json
{
  "experience": {
    /* created/updated experience object */
  },
  "offers": [
    /* upserted per-center offers */
  ]
}
```

**Errors:** `400` bad input or invalid kind, `401`, `500` DB error

---

### GET `/api/admin/bowling/v2/square-products`

List bowling products (base items, add-ons) for a center.

**Auth:** `x-admin-token: {ADMIN_SECRET_TOKEN}` header

**Query params:**

| Param        | Type   | Required | Description                                  |
| ------------ | ------ | -------- | -------------------------------------------- |
| `centerCode` | string | yes      | `TXBSQN0FEKQ11` or `PPTR5G2N0QXF7`           |
| `kind`       | string | no       | Filter by product kind (e.g. `addon_shoe`)   |
| `all`        | string | no       | Set to `"true"` to include inactive products |

**Response `200`:**

```json
{
  "products": [
    {
      "id": 5,
      "centerCode": "TXBSQN0FEKQ11",
      "productKind": "base",
      "label": "1.5 Hr Fri-Sun",
      "squareCatalogObjectId": "CATALOG_OBJ_ABC",
      "priceCents": 2200,
      "depositPct": 100,
      "sortOrder": 10,
      "isActive": true,
      "qamfWebOfferId": 12345,
      "insertedAt": "2026-04-15T10:00:00.000Z"
    }
  ],
  "count": 1
}
```

**Errors:** `400` missing centerCode, `500` DB error

**Notes:** Returns only active products by default. Pass `all=true` to include inactive.

---

### POST `/api/admin/bowling/v2/square-products`

Create or update a bowling product (upserts on `centerCode` + `productKind` + `squareCatalogObjectId`).

**Auth:** `x-admin-token: {ADMIN_SECRET_TOKEN}` header

**Request body:**

```json
{
  "centerCode": "TXBSQN0FEKQ11",
  "productKind": "addon_shoe",
  "label": "Shoe Rental",
  "squareCatalogObjectId": "CATALOG_OBJ_SHOE",
  "priceCents": 600,
  "depositPct": 100,
  "sortOrder": 20,
  "isActive": true,
  "qamfWebOfferId": null
}
```

| Field                   | Type    | Required | Default |
| ----------------------- | ------- | -------- | ------- |
| `centerCode`            | string  | yes      | —       |
| `productKind`           | string  | yes      | —       |
| `label`                 | string  | yes      | —       |
| `squareCatalogObjectId` | string  | yes      | —       |
| `priceCents`            | integer | no       | `0`     |
| `depositPct`            | number  | no       | `100`   |
| `sortOrder`             | integer | no       | `0`     |
| `isActive`              | boolean | no       | `true`  |
| `qamfWebOfferId`        | integer | no       | `null`  |

**Response `200`:**

```json
{
  "product": {
    "id": 12,
    "centerCode": "TXBSQN0FEKQ11",
    "productKind": "addon_shoe",
    "label": "Shoe Rental",
    "squareCatalogObjectId": "CATALOG_OBJ_SHOE",
    "priceCents": 600,
    "depositPct": 100,
    "sortOrder": 20,
    "isActive": true,
    "qamfWebOfferId": null,
    "insertedAt": "2026-05-09T14:00:00.000Z"
  }
}
```

**Errors:** `400` bad input, `401`, `500` DB error

---

### GET `/api/bowling/v2/availability`

Search available bowling time slots from QAMF. **Public endpoint — no auth required.**

Used by the customer booking wizard AND the admin reschedule modal.

**Query params:**

| Param             | Type    | Required | Description                                               |
| ----------------- | ------- | -------- | --------------------------------------------------------- |
| `centerId`        | integer | yes      | QAMF center ID (`9172` = FM, `3148` = Naples)             |
| `players`         | integer | yes      | Number of bowlers (≥ 1)                                   |
| `startDate`       | string  | yes      | `YYYY-MM-DD`                                              |
| `hour`            | integer | no       | 0–25 (24=midnight, 25=1am). Triggers targeted mode.       |
| `minute`          | integer | no       | `0`, `15`, `30`, or `45`. Required if `hour` set.         |
| `kind`            | string  | no       | Filter by experience kind (`"kbf"`, `"open"`, `"hourly"`) |
| `webOfferId`      | integer | no       | Narrow to a specific QAMF web offer (used by reschedule)  |
| `durationMinutes` | integer | no       | Override booking duration                                 |

**Two query modes:**

- **Targeted** (`hour` + `minute` provided): probes ±5 hours around the selected time. Fast — 2–4 QAMF calls.
- **Full-day** (no `hour`/`minute`): probes every 15 minutes from center open to close. Slower but complete.

**Response `200`:**

```json
{
  "Availabilities": [
    {
      "TotalPlayers": 6,
      "BookedAt": "2026-05-10T18:00:00-04:00",
      "WebOffer": {
        "Id": 12345,
        "Options": {
          "Time": [{ "Minutes": 90 }]
        },
        "Services": ["BookForLater"]
      }
    },
    {
      "TotalPlayers": 6,
      "BookedAt": "2026-05-10T18:15:00-04:00",
      "WebOffer": {
        "Id": 12345,
        "Options": {
          "Time": [{ "Minutes": 90 }]
        },
        "Services": ["BookForLater"]
      }
    }
  ]
}
```

**Errors:** `400` missing/invalid params, `502` fatal QAMF error

**Notes:**

- `BookedAt` includes ET offset (`-04:00` EDT, `-05:00` EST).
- Results are deduplicated by `(BookedAt, WebOffer.Id)` and sorted chronologically.
- For today's date, slots earlier than now + 15 minutes are excluded.
- Individual QAMF probe failures are swallowed (logged but not returned) — endpoint returns partial results.
- Probes are batched 8 at a time to avoid QAMF rate limits.
- Only returns experiences valid for the requested day-of-week (filtered via `daysOfWeek` in DB).
- **Admin reschedule usage:** Pass `webOfferId` from the reschedule/info response to lock results to the current experience.

---

## Center Codes

| Display         | Center Code   | QAMF Center ID |
| --------------- | ------------- | -------------- |
| Fort Myers (FM) | TXBSQN0FEKQ11 | 9172           |
| Naples (NAP)    | PPTR5G2N0QXF7 | 3148           |

---

## Page Design Specification

### Page Foundation

| Property          | Value                                  |
| ----------------- | -------------------------------------- |
| Background        | `#0a1628` (deep navy)                  |
| Text color        | `#fff`                                 |
| Font family       | `system-ui, -apple-system, sans-serif` |
| Page padding      | `1rem`                                 |
| Content max-width | `1200px`, centered (`margin: 0 auto`)  |
| Min height        | `100vh`                                |

### Color System

#### Accent Colors

| Token      | Hex       | Usage                                                           |
| ---------- | --------- | --------------------------------------------------------------- |
| Cyan       | `#00E2E5` | Reschedule action, primary accent                               |
| Green      | `#22c55e` | Confirmed status, deposits, "Sent" badges, active toggle, lanes |
| Blue       | `#3b82f6` | Arrived status, Open Bowling type badge                         |
| Blue-light | `#60a5fa` | Resend action, confirmation links                               |
| Red        | `#ef4444` | Cancel action, failed status, refund amounts                    |
| Amber      | `#f59e0b` | Pending status, remaining due amounts                           |
| Purple     | `#a855f7` | KBF type badge                                                  |
| Gray       | `#6b7280` | Completed status                                                |

#### Opacity-Based Whites (text hierarchy)

| Level       | Value                    | Usage                                   |
| ----------- | ------------------------ | --------------------------------------- |
| Primary     | `#fff`                   | Bold values, guest names, stat numbers  |
| Secondary   | `rgba(255,255,255,0.6)`  | Nav button text                         |
| Tertiary    | `rgba(255,255,255,0.5)`  | Stats bar, sub-labels, total amounts    |
| Quaternary  | `rgba(255,255,255,0.4)`  | Table headers, date label, player count |
| Muted       | `rgba(255,255,255,0.35)` | Phone numbers, QAMF IDs                 |
| Faint       | `rgba(255,255,255,0.3)`  | Center code labels, hidden count text   |
| Ghost       | `rgba(255,255,255,0.15)` | Dash placeholders (no lane)             |
| Ultra-ghost | `rgba(255,255,255,0.12)` | Dash for empty cells                    |

#### Surface Colors

| Surface          | Value                              |
| ---------------- | ---------------------------------- |
| Input background | `rgba(255,255,255,0.08)`           |
| Input border     | `1px solid rgba(255,255,255,0.15)` |
| Row divider      | `1px solid rgba(255,255,255,0.05)` |
| Header divider   | `1px solid rgba(255,255,255,0.1)`  |
| Info card bg     | `rgba(255,255,255,0.04)`           |
| Info card border | `1px solid rgba(255,255,255,0.08)` |

### Typography Scale

| Element                | Size       | Weight | Other                                       |
| ---------------------- | ---------- | ------ | ------------------------------------------- |
| Page title             | `1.5rem`   | 800    | `uppercase`, `letter-spacing: 0.05em`       |
| Modal title            | `1rem`     | 700    | `uppercase` on reschedule, normal on cancel |
| Input / nav buttons    | `0.875rem` | normal | —                                           |
| Filter "Today"         | `0.75rem`  | 600    | `uppercase`, `letter-spacing: 0.05em`       |
| Active toggle          | `0.75rem`  | 600    | —                                           |
| Stats bar              | `0.8rem`   | normal | —                                           |
| Table body             | `0.78rem`  | normal | —                                           |
| Table headers          | `0.65rem`  | 600    | `uppercase`, `letter-spacing: 0.05em`       |
| Badge text             | `0.65rem`  | 600    | `uppercase` on type badges                  |
| Action buttons         | `0.6rem`   | 600    | `uppercase`, `letter-spacing: 0.03em`       |
| Sub-info (phone)       | `0.68rem`  | normal | —                                           |
| Food items (Order col) | `0.62rem`  | normal | —                                           |
| Tiny refs (payment ID) | `0.55rem`  | normal | monospace                                   |

### Component Patterns

#### Input Style

```css
background: rgba(255, 255, 255, 0.08);
border: 1px solid rgba(255, 255, 255, 0.15);
border-radius: 8px;
color: #fff;
padding: 0.5rem 0.75rem;
font-size: 0.875rem;
```

Used for: date picker, center dropdown, search input.

#### Nav / Toggle Button

Same as Input Style plus `cursor: pointer` and `color: rgba(255,255,255,0.6)`.

**Active Only toggle (on state):**

```css
background: rgba(34, 197, 94, 0.15);
border-color: rgba(34, 197, 94, 0.3);
color: #22c55e;
```

#### Badge / Pill Pattern

All status and type badges follow this pattern:

```css
display: inline-block;
padding: 0.1rem 0.4rem;
border-radius: 5px;
font-size: 0.65rem;
font-weight: 600;
background: {color} at 12-15% opacity;
color: {color};
border: 1px solid {color} at 25-30% opacity;
```

Constructed dynamically: `backgroundColor: "${hexColor}20"`, `border: "1px solid ${hexColor}40"`.

#### Action Buttons (Ghost Style)

```css
background: none;
border: 1px solid {color at 30% opacity};
border-radius: 5px;
color: {accent color};
cursor: pointer;
font-size: 0.6rem;
font-weight: 600;
padding: 2px 6px;
text-transform: uppercase;
letter-spacing: 0.03em;
```

| Button     | Label    | Color     | Border                 |
| ---------- | -------- | --------- | ---------------------- |
| Reschedule | "Time"   | `#00E2E5` | `rgba(0,226,229,0.3)`  |
| Resend     | "Resend" | `#60a5fa` | `rgba(96,165,250,0.3)` |
| Cancel     | "Cancel" | `#ef4444` | `rgba(239,68,68,0.3)`  |

#### Visibility Rules for Action Buttons

| Button | Condition                                                                        |
| ------ | -------------------------------------------------------------------------------- | --- | ------------ |
| Time   | `status !== 'cancelled' && status !== 'completed' && qamfReservationId !== null` |
| Resend | `status !== 'cancelled' && (guestEmail                                           |     | guestPhone)` |
| Cancel | `status !== 'cancelled'`                                                         |

### Layout Structure

#### Header

- Title "BOWLING RESERVATIONS" — bold uppercase, `1.5rem`, weight 800
- Filter row: `display: flex`, `gap: 0.75rem`, `flex-wrap: wrap`, `align-items: center`
  - Date picker (`<input type="date">`)
  - Center dropdown (`<select>`)
  - Active Only toggle
  - Today button
  - ← arrow button
  - → arrow button
  - Date label (e.g. "Sat, May 10") in `rgba(255,255,255,0.4)` at `0.875rem`

#### Search

- Full width, `max-width: 400px`, `margin-top: 0.75rem`
- Placeholder: "Search name, email, phone, QAMF ID, lane..."
- Filters client-side across: `guestName`, `guestEmail`, `guestPhone`, `qamfReservationId`, `notes`, `dayofOrderLane`, `id`

#### Stats Bar

- `margin-top: 0.75rem`, `display: flex`, `gap: 1.5rem`, `flex-wrap: wrap`
- `font-size: 0.8rem`, `color: rgba(255,255,255,0.5)`
- Items:
  - "{N} active + {N} hidden (cancelled/completed)"
  - "{N} bowlers"
  - "Deposits ${X}"
  - "Total ${X}"
- Stat values in white bold; labels in tertiary white

#### Data Table

- Wrapped in `overflow-x: auto` for horizontal scroll on small screens
- `width: 100%`, `border-collapse: collapse`, body `font-size: 0.78rem`
- 11 columns: Time, Guest, Type, Status, Lane, Order, Square, Alert, Payment, Ref, Actions
- Cell padding: `0.5rem 0.4rem`
- Row border: `1px solid rgba(255,255,255,0.05)`
- Cancelled rows: `opacity: 0.45`
- Table header border: `1px solid rgba(255,255,255,0.1)`

#### Column-Specific Rendering

| Column      | Key Details                                                                                                                              |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **Time**    | `nowrap`, plain text                                                                                                                     |
| **Guest**   | Name at weight 600; center code ("FM"/"NAP") inline, `0.6rem`, `rgba(255,255,255,0.3)`; phone below, `0.68rem`, `rgba(255,255,255,0.35)` |
| **Type**    | Badge pill + `{N}p` at `0.68rem` in `rgba(255,255,255,0.4)`, `margin-left: 5px`                                                          |
| **Status**  | Badge pill using `STATUS_COLORS` map (see color system)                                                                                  |
| **Lane**    | Center-aligned, `0.75rem`. Bold `700` green `#22c55e` when assigned; dash in ghost white when not                                        |
| **Order**   | Food items abbreviated: "PB Pizza", "PB Soda", "C&S". `0.62rem`, `nowrap`, `rgba(255,255,255,0.55)`. Shows "×N" for qty > 1              |
| **Square**  | Clickable. "Sent" green badge, "ERR" red badge, or "Pending" underlined text. Payment ID last 8 chars at `0.55rem` below                 |
| **Alert**   | "Sent" green badge if notification sent; dash if not. Hover shows timestamp                                                              |
| **Payment** | Deposit in green / total in `rgba(255,255,255,0.5)` separated by "/". "Free" for $0. Refunds below in red at `0.6rem`                    |
| **Ref**     | Monospace `0.65rem` muted. "link" in `#60a5fa`. "cp" toggles to green "ok" for 1.5s                                                      |
| **Actions** | `display: flex`, `gap: 4px` of ghost buttons                                                                                             |

### Modal Patterns

All modals share:

- **Overlay:** `position: fixed`, `inset: 0`, `z-index: 50`, `background: rgba(0,0,0,0.75)`, `backdrop-filter: blur(4px)`, flex-centered
- **Click-outside dismisses** via backdrop click handler
- **Close button:** × character, `background: none`, `color: rgba(255,255,255,0.3)`, `font-size: 1.2rem`

#### Cancel Modal

```css
max-width: 400px;
background: #0e1d3a;
border: 1px solid rgba(239, 68, 68, 0.3); /* red accent */
border-radius: 16px;
padding: 1.5rem;
```

- Header: "Cancel Reservation" in `#ef4444`, weight 700
- Info card: `border-radius: 10px`, `bg: rgba(255,255,255,0.04)`, `font-size: 0.8rem`, `line-height: 1.7`
  - Guest name (bold white), time · date · center (tertiary), bowler count · product type, deposit (green bold)
- Warning box: `bg: rgba(239,68,68,0.1)`, `border: rgba(239,68,68,0.2)`, `font-size: 0.75rem`
  - Dynamic text based on whether deposit exists
- Buttons right-aligned, `gap: 8px`:
  - "Keep It" — nav button style at `0.8rem`
  - "Cancel & Refund" — solid `#ef4444`, weight 700, `border-radius: 8px`, `padding: 0.5rem 1.25rem`

#### Reschedule Modal

```css
max-width: 480px;
background: #0e1d3a;
border: 1px solid rgba(0, 226, 229, 0.25); /* cyan accent */
border-radius: 16px;
padding: 1.5rem;
max-height: calc(100dvh - 2rem);
overflow-y: auto;
```

- Header: "CHANGE TIME" in `#00E2E5`, weight 700, uppercase, `letter-spacing: 0.05em`
- Same info card pattern as cancel
- Note box: `bg: rgba(0,226,229,0.06)`, `border: rgba(0,226,229,0.15)`, `font-size: 0.7rem`
  - Text: "Only times within the same experience/web offer are shown. Price and deposit stay the same."
- Date picker: full-width input style
- Time slot grid: `grid-template-columns: repeat(auto-fill, minmax(90px, 1fr))`, `gap: 6px`, `max-height: 200px`, scroll
  - **Selected slot:** `bg: rgba(0,226,229,0.15)`, `border: 1.5px solid #00E2E5`, `color: #00E2E5`
  - **Unselected:** `bg: rgba(255,255,255,0.06)`, `border: 1px solid rgba(255,255,255,0.12)`, `color: rgba(255,255,255,0.8)`
  - **Current time (disabled):** `bg: rgba(255,255,255,0.03)`, `color: rgba(255,255,255,0.25)`, shows "current" at `0.55rem`
- Buttons: "Cancel" (nav style) / "Reschedule" (solid cyan `#00E2E5`, text `#000418`, weight 700)

#### Resend Confirmation Modal

Uses shared `AdminResendModal` component with:

- Channel selector (Both / Email only / SMS only)
- Override phone/email input fields
- Guest context section showing name, phone, email, product type · time · center

#### Square Order Details Modal

```css
max-width: 500px;
background: #1a1a1a; /* note: different from other modals */
border: 1px solid rgba(255, 255, 255, 0.08);
border-radius: 12px; /* 12 not 16 */
padding: 24px;
max-height: 80vh;
overflow: auto;
```

- Title: "Square Order — {Guest Name}" at `0.95rem`, weight 700
- Order ID: monospace, `0.68rem`, `rgba(255,255,255,0.35)`
- State badge: OPEN = blue, COMPLETED = green, other = red (same badge pill pattern)
- Total / Due amounts inline at `0.75rem`
- Line items table: `0.78rem` body, `0.65rem` uppercase headers
  - Item notes in italic, `0.68rem`, `rgba(255,255,255,0.4)`
  - $0 items shown in `rgba(255,255,255,0.25)`
- Close button: `border-radius: 6px`, `0.75rem`, weight 600

### Toast Notification

```css
position: fixed;
top: 16px;
right: 16px;
z-index: 60;
padding: 0.75rem 1.25rem;
border-radius: 10px;
background: rgba(34, 197, 94, 0.9);
color: #fff;
font-weight: 600;
font-size: 0.85rem;
box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
```

Auto-dismisses after 4 seconds.

### Empty / Loading / Error States

| State                     | Style                                                                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Loading**               | Center-aligned, `padding: 3rem`, `color: rgba(255,255,255,0.4)`, text "Loading..."                                                                            |
| **Error**                 | Center-aligned, `padding: 2rem`, `color: #ef4444`, `bg: rgba(239,68,68,0.1)`, `border-radius: 12px`, `border: 1px solid rgba(239,68,68,0.3)`                  |
| **No results**            | Center-aligned, `padding: 3rem`, `color: rgba(255,255,255,0.3)`, contextual message                                                                           |
| **Inline error** (modals) | `padding: 0.5rem 0.75rem`, `border-radius: 8px`, `bg: rgba(239,68,68,0.15)`, `color: #ef4444`, `border: rgba(239,68,68,0.3)`, `font-size: 0.8rem`, weight 600 |

### Key Design Rules

1. **No external CSS framework** — all styles are inline React `CSSProperties` objects. No Tailwind, no Shadcn.
2. **Badge pattern is universal** — status, type, alert, Square status all use the same pill: colored text + 20% bg + 40% border + `border-radius: 5px`.
3. **Two surface colors for modals**: `#0e1d3a` (cancel + reschedule) and `#1a1a1a` (Square order details).
4. **Accent border on modals identifies purpose**: red = destructive (cancel), cyan = neutral action (reschedule), no accent = informational (Square order).
5. **No hover states on table rows** — hover effects reserved for action buttons only.
6. **Cancelled rows dim to 45% opacity** rather than being fully hidden (unless Active Only toggle is on).
7. **All times display in Eastern Time** — formatted via `toLocaleString` with `timeZone: "America/New_York"`.
8. **Responsive**: filter bar wraps via `flex-wrap`, table scrolls horizontally via `overflow-x: auto`, modals respect viewport height.

---

## API Error Handling Summary

| Endpoint                   | Notable Error Codes                                                        |
| -------------------------- | -------------------------------------------------------------------------- |
| `GET /reservations`        | 400 (bad date), 401 (bad token), 500 (DB error)                            |
| `POST /resend`             | 400 (missing neonId/channel), 401                                          |
| `POST /cancel`             | 404 (not found), 409 (already cancelled), 502 (Square refund failed)       |
| `GET /reschedule/info`     | 400 (bad neonId/center), 404 (not found / no QAMF ID), 502 (QAMF failed)   |
| `POST /reschedule`         | 400 (bad input/state), 404 (not found), 502 (QAMF failed)                  |
| `POST /force-confirm`      | 400 (bad input/state), 404, 422 (can't reconstruct), 502 (QAMF failed)     |
| `GET /square-order`        | 400 (missing orderId), 404, 502 (Square 5xx)                               |
| `POST /backfill-memo`      | 400 (bad token), 500 (DB error); per-row errors in results array           |
| `GET /v2/experiences`      | 401 (bad header token)                                                     |
| `POST /v2/experiences`     | 400 (bad input), 401, 500 (DB)                                             |
| `GET /v2/square-products`  | 400 (missing centerCode), 500 (DB)                                         |
| `POST /v2/square-products` | 400 (bad input), 401, 500 (DB)                                             |
| `GET /v2/availability`     | 400 (missing/invalid params), 502 (QAMF fatal); probe errors are swallowed |

---

## Implementation Notes for Portal Developer

### Authentication

Two auth mechanisms — never mixed on the same endpoint:

1. **Query param `?token={ADMIN_CAMERA_TOKEN}`** — used by all reservation management endpoints. The current admin page passes the token from the URL path segment.
2. **Header `x-admin-token: {ADMIN_SECRET_TOKEN}`** — used by catalog management endpoints (experiences, square-products). Different env var.

### Date & Timezone Handling

- All `bookedAt` values are stored as UTC `TIMESTAMPTZ` in Neon.
- The API filters by Eastern Time date boundaries: `(booked_at AT TIME ZONE 'America/New_York')::date`.
- The client formats times using `toLocaleString("en-US", { timeZone: "America/New_York" })`.
- Date picker sends `YYYY-MM-DD` string; the API handles ET conversion server-side.
- This means a booking at 8 PM ET on May 9 (stored as May 10 UTC) correctly appears under May 9.

### Reschedule Flow (Multi-Step)

The reschedule modal chains three API calls:

1. `GET /reschedule/info?neonId={id}` → returns `webOfferId`, `centerId`, `playerCount`
2. `GET /bowling/v2/availability?centerId={}&players={}&startDate={}&webOfferId={}` → returns available time slots filtered to same experience
3. `POST /reschedule` with `{ neonId, bookedAt, webOfferId, optionId?, optionType? }` → executes the move

The availability endpoint is **public** (no auth required). The reschedule submission endpoint requires the admin token.

### Square Order Modal

Triggered by clicking any non-empty Square column cell. The badge state is derived from reservation fields:

- `dayofOrderSentAt` exists + no `dayofOrderError` → green "Sent"
- `dayofOrderSentAt` exists + `dayofOrderError` exists → red "ERR" (error text shown truncated, full on hover)
- `squareDayofOrderId` exists but no `dayofOrderSentAt` → gray "Pending" (underlined)

Clicking fetches `GET /square-order?orderId={squareDayofOrderId}` and displays the result in a modal.

### Idempotency

- Cancel uses a unique idempotency key per call: `admin-cancel-{neonId}-{uuid}`.
- Lane-open processor uses stable keys: `lane-open-{neonId}-notes` and `lane-open-{neonId}-pay`.
- Resend has no dedup — admin can resend unlimited times (passes `forceResend: true`).

### Short URL / Confirmation Links

Each reservation has a `shortCode` for the confirmation page URL: `headpinz.com/s/{shortCode}`. These are backfilled on first access via the list endpoint if missing. The "cp" button copies the full URL to clipboard; the "link" anchor opens it in a new tab.

### Food Item Display (Order Column)

Only three items are shown in the Order column, matched by regex:

- `Pizza Bowl Pizza` → abbreviated "PB Pizza"
- `Pizza Bowl Soda Pitcher` → "PB Soda"
- `Chips & Salsa` → "C&S"

These are the kitchen display (KDS) items. Other line items (bowling time, shoes, bumpers) are not shown in this column — they're visible in the Square Order modal.

### Status Lifecycle

```
confirm_pending → confirmed → arrived → completed
       ↓              ↓          ↓
  confirm_failed   cancelled  cancelled
```

- `confirm_pending`: QAMF reservation created but not yet confirmed (async process)
- `confirm_failed`: Confirmation attempts exhausted (cron retries every 5 min, max attempts)
- `confirmed`: QAMF reservation confirmed, awaiting check-in
- `arrived`: Lanes opened in QAMF (status "Running"), lane-open processor fired
- `completed`: QAMF session finished
- `cancelled`: Admin or customer cancelled; refund processed if deposit existed
