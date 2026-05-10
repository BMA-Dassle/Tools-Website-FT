# Bowling Reservation Admin — Portal Developer Handoff

## Overview

The bowling reservation admin page (`/admin/{token}/reservations`) is a single-page dashboard for managing all online bowling bookings across both HeadPinz centers (Fort Myers & Naples). It is the primary tool for front desk staff and managers to monitor, modify, and troubleshoot reservations.

**Live URL:** `https://headpinz.com/admin/{ADMIN_CAMERA_TOKEN}/reservations`

---

## System Architecture

Three external systems are involved in every reservation:

| System | Role |
|--------|------|
| **QAMF Conqueror** | Lane management system — holds the reservation, assigns lanes, tracks status (Temporary → Confirmed → Running → Completed) |
| **Square** | Payment processing — deposit order (charged at booking), day-of order (open order with full line items for KDS), gift card (holds deposit for lane-open application) |
| **Neon (Postgres)** | Our database — source of truth linking QAMF + Square, stores guest info, status, and all IDs |

---

## Page Layout & Features

### Filter Bar

| Control | Behavior |
|---------|----------|
| **Date picker** | YYYY-MM-DD input; defaults to today (Eastern Time) |
| **Center dropdown** | "All Centers", "Fort Myers", "Naples" |
| **Active Only toggle** | Hides cancelled and completed reservations (default: on) |
| **Today button** | Jumps date picker to today |
| **← / → arrows** | Navigate one day back/forward |
| **Date label** | Shows formatted date (e.g. "Sat, May 10") |

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

| Column | Content | Details |
|--------|---------|---------|
| **Time** | Booking start time | Formatted in ET (e.g. "8:15 PM") |
| **Guest** | Name, phone, center badge | Center shown as colored badge ("FM" = blue, "NAP" = purple) |
| **Type** | Product kind + player count | "KBF" (purple) or "Open" (blue) badge, followed by bowler count (e.g. "6p") |
| **Status** | Reservation status badge | Color-coded: green=Confirmed, yellow=Pending, red=Failed, blue=Arrived, gray=Completed, muted=Cancelled |
| **Lane** | Assigned lane number(s) | Shows lane from QAMF when reservation goes "Running" (e.g. "25" or "17,18"). Bold green text. Dash if no lane yet. |
| **Order** | Food items summary | Shows kitchen-relevant items only: Pizza Bowl Pizza, Pizza Bowl Soda Pitcher, Chips & Salsa. Quantity shown if > 1. |
| **Square** | Day-of order status | Clickable badge: "Sent" (green) = deposit applied to day-of order at lane open, "Pending" (gray) = order exists but not processed yet, "ERR" (red) = processing failed. Clicking opens order details modal. Shows last 8 chars of payment ID if payment was made. |
| **Alert** | Pre-arrival notification status | "Sent" badge (green) = SMS/email sent ~30 min before booking time. Timestamp shown on hover. Dash if not yet sent. |
| **Payment** | Deposit / Total breakdown | Shows deposit (green) and total (gray) amounts. "Free" for $0 bookings. Red text for refund amounts. |
| **Ref** | QAMF ID + confirmation link | QAMF reservation ID (e.g. "X147867") or "#neonId" fallback. "link" opens confirmation page. "cp" button copies short URL to clipboard (toggles to "ok" for 1.5s). |
| **Actions** | Action buttons | Up to 3 buttons per row (see Actions section below) |

---

## Actions

### Reschedule (cyan "Time" button)
- **Visible when:** Not cancelled/completed AND has a QAMF ID
- **Opens:** Reschedule modal
- **Flow:**
  1. Fetches current booking info and QAMF web offer details
  2. Shows date picker defaulting to current booking date
  3. Loads available time slots from QAMF for that date + web offer
  4. User picks a new time slot
  5. Submits reschedule: deletes old QAMF reservation, creates new one at new time, confirms it, updates Neon
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

| Column | Type | Description |
|--------|------|-------------|
| id | SERIAL | Primary key (Neon ID) |
| center_code | TEXT | TXBSQN0FEKQ11 or PPTR5G2N0QXF7 |
| product_kind | TEXT | open, kbf, hourly |
| qamf_reservation_id | TEXT | QAMF Conqueror ID (e.g. X147867) |
| square_deposit_order_id | TEXT | Square order for deposit charge |
| square_deposit_payment_id | TEXT | Square payment ID for deposit |
| square_dayof_order_id | TEXT | Square day-of order (full items) |
| square_gift_card_id | TEXT | Square eGift card ID |
| square_gift_card_gan | TEXT | Gift card account number |
| deposit_cents | INT | Tax-inclusive deposit charged |
| total_cents | INT | Full booking total |
| status | TEXT | confirmed, confirm_pending, confirm_failed, arrived, completed, cancelled |
| booked_at | TIMESTAMPTZ | Session start time (UTC) |
| player_count | INT | Number of bowlers |
| guest_name | TEXT | Guest name |
| guest_email | TEXT | Guest email |
| guest_phone | TEXT | Guest phone |
| notes | TEXT | Customer-supplied notes |
| cancelled_at | TIMESTAMPTZ | When cancelled |
| square_refund_id | TEXT | Square refund payment ID |
| refund_cents | INT | Refund amount |
| short_code | TEXT | Short URL code |
| pre_arrival_sent_at | TIMESTAMPTZ | Pre-arrival SMS/email timestamp |
| dayof_order_sent_at | TIMESTAMPTZ | Lane-open processing timestamp |
| dayof_order_lane | TEXT | Lane number(s) from QAMF |
| dayof_payment_id | TEXT | Gift card payment ID |
| dayof_order_error | TEXT | Lane-open processing error |
| inserted_at | TIMESTAMPTZ | Row creation time |

### `bowling_reservation_lines` table

| Column | Type | Description |
|--------|------|-------------|
| id | SERIAL | Primary key |
| reservation_id | INT | FK to bowling_reservations.id |
| square_product_id | INT | FK to bowling_square_products.id |
| label | TEXT | Display label (e.g. "1.5 Hr Fri-Sun") |
| quantity | INT | Quantity purchased |
| unit_price_cents | INT | Price per unit in cents |

---

## API Endpoints Summary

All admin endpoints require `?token={ADMIN_CAMERA_TOKEN}` unless noted.

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/admin/bowling/reservations` | List reservations for a date |
| POST | `/api/admin/bowling/reservations/resend` | Resend confirmation email/SMS |
| POST | `/api/admin/bowling/reservations/cancel` | Cancel + full refund |
| GET | `/api/admin/bowling/reservations/reschedule/info` | Get reschedule context |
| POST | `/api/admin/bowling/reservations/reschedule` | Reschedule to new time |
| POST | `/api/admin/bowling/force-confirm` | Force-confirm stuck reservation |
| GET | `/api/admin/bowling/square-order` | View Square order line items |
| POST | `/api/admin/bowling/backfill-memo` | Backfill QAMF memos |
| GET | `/api/admin/bowling/v2/experiences` | List experiences (uses `x-admin-token` header) |
| POST | `/api/admin/bowling/v2/experiences` | Upsert experience (uses `x-admin-token` header) |
| GET | `/api/admin/bowling/v2/square-products` | List Square products |
| POST | `/api/admin/bowling/v2/square-products` | Upsert Square product |

Full OpenAPI spec: [`docs/bowling-admin-api.yaml`](bowling-admin-api.yaml)

---

## Center Codes

| Display | Center Code | QAMF Center ID |
|---------|-------------|----------------|
| Fort Myers (FM) | TXBSQN0FEKQ11 | 9172 |
| Naples (NAP) | PPTR5G2N0QXF7 | 3148 |
