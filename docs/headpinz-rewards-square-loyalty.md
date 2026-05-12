# HeadPinz Rewards / Square Loyalty Integration

## Overview

HeadPinz Rewards is a loyalty program built on Square's Loyalty API. Customers earn "Pinz" (points) on bowling purchases and can redeem them for discounts. The program is surfaced during the bowling booking wizard and tracked in the admin reservations view.

## Square Loyalty Architecture

### Key Objects

| Object | Description | Example ID |
|---|---|---|
| **Loyalty Program** | Singleton — always `"main"` | `main` |
| **Loyalty Account** | Per-customer point balance | `3b142dff-b4f5-4fe4-9c16-f70441ca415f` |
| **Customer** | Square customer profile (linked 1:1 to loyalty account) | `ZAWPP8WRHGB1RZ39D12EXH7N4R` |
| **Reward Tier** | Redeemable discount definition (e.g., "$10 off") | tier ID from program |
| **Reward** | Instance of a redeemed tier, applied to an order | created at booking time |

### Accrual Rules

Current program uses **spend-based** accrual:
- **10 Pinz per $1 spent** (pre-tax amount)
- Example: Fun 4 All $15.99 = 150 Pinz

### Critical: Points Do NOT Accrue Automatically

`customer_id` on a Square order is **necessary but not sufficient**. You MUST explicitly call:

```
POST /v2/loyalty/accounts/{account_id}/accumulate
{
  "accumulate_points": { "order_id": "<square-order-id>" },
  "location_id": "<location-id>",
  "idempotency_key": "<unique-key>"
}
```

Square reads the order's catalog items and computes points from the accrual rules.

**Requirement**: The order must be **paid or completed** before accumulation succeeds. Calling on an OPEN order returns `BAD_REQUEST: Order must be paid or completed to accumulate loyalty points`.

## Booking Flow (Wizard → Reserve → Square)

### Step 1: Phone Lookup + Enrollment

In the booking wizard guest info step:

1. Customer enters phone number
2. Wizard calls `GET /api/square/loyalty/lookup?phone=2397762044`
3. If found: returns `loyaltyAccount` (id, balance, customerId) — customer enters SMS verification
4. If not found: offers "Join HeadPinz Rewards" checkbox
5. New enrollment calls `POST /api/square/loyalty/enroll` → creates Square Customer + Loyalty Account
6. Profile completion (`POST /api/square/loyalty/complete-profile`) awards **500 bonus Pinz**

State set in wizard:
- `loyaltyAccount` — `{ id, balance, lifetimePoints, customerId }`
- `loyaltyCustomer` — `{ id, firstName, lastName, email, phone }`
- `loyaltyIsNewSignup` — boolean

### Step 2: Quote (Review Step)

When the review step mounts, the wizard creates a Square day-of order via `/api/square/bowling-orders/quote`:

```typescript
body: {
  locationId: center.squareCenterCode,
  lineItems: sqLineItems,
  depositPct,
  squareCustomerId: loyaltyCustomer?.id,  // <-- set at creation time
}
```

The `squareCustomerId` is included so the order has `customer_id` from birth. This was a bug fix — previously the quote created orders without it, and a best-effort PUT in bowling-orders silently failed.

### Step 3: Reserve (Payment)

The wizard sends to `POST /api/bowling/v2/reserve`:

```typescript
body: {
  squareCustomerId: loyaltyCustomer?.id,
  loyaltyAction: loyaltyIsNewSignup ? "signup" : "existing",
  loyaltyAccountId: loyaltyAccount?.id,  // always sent when account exists
  // Reward redemption (optional):
  rewardTierId: selectedRewardTier?.id,
  rewardDiscountCents: selectedRewardTier?.discountCents,
}
```

The reserve route:
1. Passes `squareCustomerId` to bowling-orders (which sets it on the day-of order + deposit payment)
2. Stores `squareCustomerId`, `loyaltyAction` in Neon `bowling_reservations`
3. Does NOT accrue points here (order is still OPEN)

### Step 4: Lane Open (Point Accrual)

Points are accrued in `lib/bowling-lane-open.ts` during the lane-open process:

1. Gift card payment applied to day-of order (covers deposit amount)
2. If order is fully paid (net_amount_due = 0), order is explicitly set to COMPLETED
3. Loyalty account looked up via `POST /v2/loyalty/accounts/search` with `customer_ids`
4. `AccumulateLoyaltyPoints` called with the day-of order ID
5. Points accrued based on catalog items in the order

**Why lane-open and not booking time?** Square requires the order to be paid/completed. The day-of order is OPEN at booking time (only the deposit order is closed). At lane-open, the gift card payment closes the order.

**Partial deposit caveat**: If the deposit is less than 100%, the gift card won't cover the full day-of order. The order stays OPEN after lane-open, and points accrue only when the remaining balance is paid at the POS. We currently don't have a hook for POS-side completion.

## Reward Redemption at Booking

When a verified loyalty member has enough Pinz, they can redeem a reward tier:

1. Wizard fetches `GET /api/square/loyalty/program` for reward tiers (ORDER-scoped, fixed discount)
2. Customer selects a tier (e.g., "$10 off — 1000 Pinz")
3. Reserve route creates the reward via Square:
   ```
   POST /v2/loyalty/rewards
   { reward: { loyalty_account_id, reward_tier_id, order_id }, idempotency_key }
   ```
4. Then redeems it:
   ```
   POST /v2/loyalty/rewards/{reward_id}/redeem
   { idempotency_key, location_id }
   ```
5. Deposit is recalculated on the reward-adjusted total
6. If payment fails, reward is deleted (points returned)

## Square Order Lifecycle

### Day-of Order

- Created at quote time (review step) — OPEN, has catalog line items + tax
- `customer_id` set at creation (for loyalty linking)
- Left OPEN until lane-open
- At lane-open: gift card payment applied → if fully paid, set to COMPLETED

### Deposit Order

- Separate closed order for financial accountability
- Single line item: "Bowling Reservation Deposit"
- Payment captured immediately (card charge)
- `customer_id` set on the payment (not the order)

### Gift Card

- Created per reservation with custom GAN: `{CENTER_PREFIX}{QAMF_ID}` (e.g., `HPFMX77012`)
- Center prefixes: HPFM (Fort Myers), HPN (Naples)
- Activated with deposit amount, linked to deposit payment
- Balance applied to day-of order at lane-open
- **Important**: Gift card payments do NOT auto-complete orders — must explicitly close

### Order Completion

Square orders don't auto-transition to COMPLETED from gift card payments. After applying the gift card, if `net_amount_due_money.amount = 0`:

```typescript
PUT /v2/orders/{order_id}
{
  order: {
    version: <current>,
    location_id: <loc>,
    fulfillments: [{ uid, type, state: "COMPLETED" }],
    state: "COMPLETED"
  }
}
```

## Neon Schema (bowling_reservations)

| Column | Type | Description |
|---|---|---|
| `square_customer_id` | TEXT | Square customer ID (loyalty member) |
| `loyalty_action` | TEXT | `"signup"` (new) or `"existing"` (returning member) |
| `square_dayof_order_id` | TEXT | Day-of Square order (catalog items, left open) |
| `square_deposit_order_id` | TEXT | Deposit Square order (closed immediately) |
| `square_gift_card_id` | TEXT | Gift card ID for deposit tracking |
| `square_gift_card_gan` | TEXT | Gift card GAN (e.g., HPFMX77012) |
| `square_loyalty_reward_id` | TEXT | Redeemed reward ID (if applicable) |
| `reward_discount_cents` | INTEGER | Discount amount from reward |

## API Endpoints (Internal)

| Route | Method | Purpose |
|---|---|---|
| `/api/square/loyalty/lookup` | GET | Look up loyalty account by phone |
| `/api/square/loyalty/enroll` | POST | Create customer + loyalty account |
| `/api/square/loyalty/complete-profile` | POST | Update name/email + award 500 bonus Pinz |
| `/api/square/loyalty/program` | GET | Fetch reward tiers for redemption UI |
| `/api/square/bowling-orders/quote` | POST | Create day-of order (now includes customer_id) |
| `/api/square/bowling-orders` | POST | Process deposit payment + create gift card |

## Key Files

| File | What |
|---|---|
| `components/bowling/BowlingWizard.tsx` | Loyalty UI, enrollment, reward selection |
| `app/api/bowling/v2/reserve/route.ts` | Booking endpoint — passes loyalty data through |
| `app/api/square/bowling-orders/route.ts` | Day-of order + deposit + gift card creation |
| `app/api/square/bowling-orders/quote/route.ts` | Quote endpoint (sets customer_id on order) |
| `lib/bowling-lane-open.ts` | Lane-open: gift card payment, order completion, point accrual |
| `lib/sales-lead-config.ts` | Planner phone/email config (Stephanie, Lori, Kelsea) |
| `app/api/square/loyalty/*/route.ts` | Loyalty API wrappers |

## Lessons Learned

1. **customer_id alone doesn't accrue points** — must call AccumulateLoyaltyPoints explicitly
2. **Order must be paid/completed** before accumulation — can't accrue at booking time
3. **Gift card payments don't auto-complete orders** — must explicitly UpdateOrder to COMPLETED
4. **Quote endpoint must include customer_id** — otherwise the day-of order is created without it, and the fallback PUT to add it later can silently fail
5. **`new Date(bookedAt).toLocaleDateString()` shifts dates on UTC servers** — extract date from ISO string directly with `.slice(0, 10)`
6. **Custom GANs work** — `gan_source: "OTHER"` with 8-20 alphanumeric chars lets you label gift cards (e.g., HPFMX77012)
7. **loyaltyAccountId must always be sent** — not just during reward redemption, so lane-open can accrue points without an extra lookup (future optimization)
