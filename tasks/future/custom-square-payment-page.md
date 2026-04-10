# Custom Square Payment Page - Implementation Plan

## Context

Currently, non-bowling checkout (racing, gel blaster, laser tag, duckpin, shuffleboard) redirects users to Square's hosted Payment Link page. The user leaves fasttraxent.com, pays on Square, and gets redirected back. This creates friction, loses brand control, and prevents features like saved cards.

**Goal:** Replace the Square redirect with an embedded payment form on our site using the Square Web Payments SDK. Add card-on-file support for returning racers. Enhance confirmation messages with payment details.

**Scope:** All non-bowling services. Bowling stays on QAMF. Credit orders still bypass payment entirely.

### Key Decisions
- **Payment methods:** Credit/debit cards + Apple Pay + Google Pay
- **Save card:** Returning racers only (verified SMS-Timing profile required)
- **Confirmation messages:** Amount + card last 4 (e.g. "$49.99 charged to Visa ending in 4242")

---

## Architecture Overview

```
CURRENT FLOW:
  OrderSummary → POST /api/square/checkout → redirect to Square → redirect back → confirmation

NEW FLOW:
  OrderSummary → show PaymentForm inline → tokenize card (Square SDK) →
  POST /api/square/pay (create order + process payment) → inline success → redirect to confirmation
```

---

## Phase 1: Square Web Payments SDK Component

### New File: `components/square/PaymentForm.tsx`

Client component that loads the Square Web Payments SDK and renders card input fields.

**Props:**
```ts
interface PaymentFormProps {
  amount: number;            // dollars (e.g. 49.99)
  itemName: string;          // "Starter Race x2" etc.
  billId: string;            // BMI bill ID
  billIds: string[];         // All bill IDs (multi-racer)
  bills: { billId: string; racerName: string; personId?: string }[];
  contact: { firstName: string; lastName: string; email: string; phone: string };
  onSuccess: (result: PaymentResult) => void;
  onError: (error: string) => void;
  // Card-on-file props (returning racers)
  squareCustomerId?: string;     // If we found/created a Square customer
  savedCards?: SavedCard[];      // Cards on file for this customer
  confirmationPath?: string;     // Override for non-racing attractions
}
```

**Behavior:**
1. Load Square SDK script from `https://web.squarecdn.com/v1/square.js`
2. Initialize `Square.payments(appId, locationId)` 
3. Render `payments.card()` — Square's PCI-compliant iframe fields
4. Render Apple Pay button via `payments.applePay()` (if supported — requires merchant ID)
5. Render Google Pay button via `payments.googlePay()` (if supported)
6. On submit: `card.tokenize()` / `applePay.tokenize()` / `googlePay.tokenize()` → returns `token` (nonce)
6. POST token + order details to `/api/square/pay`
7. Show success/failure inline
8. "Save this card for future visits" opt-in checkbox (only shown for **returning racers** with a verified SMS-Timing profile)

**UI States:**
- `idle` — card form rendered, "Pay $XX.XX" button
- `processing` — spinner, button disabled, "Processing payment..."
- `success` — green checkmark, "Payment successful!", brief pause then redirect
- `error` — red message with retry button, card form stays active

**Error Messages (mapped from Square error codes):**
- `INSUFFICIENT_FUNDS` → "Card declined — insufficient funds. Try a different card."
- `GENERIC_DECLINE` → "Card declined. Please try a different card."
- `INVALID_EXPIRATION` → "Card expired. Please use a different card."
- `CVV_FAILURE` → "CVV check failed. Please re-enter your card details."
- Default → "Payment could not be processed. Please try again."

### New File: `components/square/SavedCardSelector.tsx`

Shows saved cards for returning racers, with option to use a saved card or enter a new one.

**Props:**
```ts
interface SavedCardSelectorProps {
  cards: SavedCard[];
  selectedCardId: string | null;
  onSelect: (cardId: string | null) => void;  // null = "use new card"
}

interface SavedCard {
  id: string;
  brand: string;       // "VISA", "MASTERCARD", etc.
  last4: string;       // "4242"
  expMonth: number;
  expYear: number;
  expired: boolean;
}
```

**Behavior:**
- Renders a list of saved cards with brand icon, last 4, expiry
- Expired cards shown grayed out with "Expired" badge
- "Use a different card" option at bottom shows the full card form
- Default selection: most recently added non-expired card

---

## Phase 2: Server-Side Payment Processing

### New File: `app/api/square/pay/route.ts`

Processes the payment server-side using the tokenized card nonce.

**Request Body:**
```ts
{
  token: string;              // From card.tokenize() or savedCardId
  useSavedCard: boolean;      // true if paying with card on file
  savedCardId?: string;       // Card ID if using saved card
  amount: number;             // Dollar amount
  billId: string;             // Primary BMI bill ID
  itemName: string;           // Line item description
  contact: { firstName, lastName, email, phone };
  // Card-on-file
  saveCard: boolean;          // User opted to save card
  squareCustomerId?: string;  // Existing Square customer ID
}
```

**Server Flow:**
1. Generate idempotency key: `randomUUID()`
2. Create Square order: `POST /v2/orders`
   ```json
   {
     "location_id": "SQUARE_LOCATION_ID",
     "line_items": [{
       "name": itemName,
       "quantity": "1",
       "base_price_money": { "amount": amountCents, "currency": "USD" }
     }]
   }
   ```
3. Process payment: `POST /v2/payments`
   ```json
   {
     "source_id": token,          // nonce from tokenize, OR card ID
     "idempotency_key": uuid,
     "amount_money": { "amount": amountCents, "currency": "USD" },
     "order_id": orderId,         // From step 2
     "location_id": "SQUARE_LOCATION_ID",
     "autocomplete": true,
     "buyer_email_address": email,
     "note": "FastTrax - {itemName} | Ref: {billId}",
     "customer_id": squareCustomerId  // Links payment to customer
   }
   ```
4. If `saveCard && squareCustomerId && !useSavedCard`:
   - Store card on file: `POST /v2/cards`
   ```json
   {
     "idempotency_key": uuid,
     "source_id": token,
     "card": {
       "customer_id": squareCustomerId
     }
   }
   ```
5. Return response:
   ```ts
   {
     success: true,
     paymentId: string,
     orderId: string,
     receiptUrl: string,        // Square receipt URL
     cardBrand: string,         // "VISA"
     cardLast4: string,         // "4242"
     savedCardId?: string,      // If card was saved
   }
   ```

### New File: `app/api/square/customer/route.ts`

Finds or creates a Square customer for a racer. Bridges BMI → Square gap.

**POST — Find or create customer:**
```ts
// Request
{ phone: string; firstName: string; lastName: string; email?: string }

// Flow:
// 1. Search customers by phone: POST /v2/customers/search
// 2. If found: update name/email if missing, return customer
// 3. If not found: create customer: POST /v2/customers
// 4. Return: { customerId, cards: SavedCard[] }
```

**GET — List saved cards for customer:**
```ts
// Query: ?customerId=SQ_CUST_ID
// Call: GET /v2/cards?customer_id={id}
// Return: { cards: SavedCard[] }
```

---

## Phase 3: Integration into Checkout Flows

### Modify: `app/book/race/components/OrderSummary.tsx`

**Current behavior (lines 442-486):** Creates Square payment link → redirects.

**New behavior:** Replace the Square redirect section with inline `<PaymentForm>`.

Changes to `handleConfirm()`:
1. Everything up to the credit order check (line 440) stays the same
2. Replace lines 442-486 (the "Cash order — create Square checkout" block) with:
   - Resolve Square customer: call `/api/square/customer` with contact info + phone
   - Fetch saved cards if returning racer has a squareCustomerId
   - Set state to `{ status: "paying", squareCustomerId, savedCards }` (new state variant)
3. Remove the redirect logic — PaymentForm handles it

New state variant:
```ts
| { status: "paying"; squareCustomerId?: string; savedCards?: SavedCard[]; cashOwed: number; raceName: string; orderId: string; allBillIds: string[]; bills: RacerBill[] }
```

Render change: When `state.status === "paying"`, show `<PaymentForm>` instead of the current go-kart animation:
```tsx
if (state.status === "paying") {
  return (
    <PaymentForm
      amount={state.cashOwed}
      itemName={state.raceName}
      billId={state.orderId}
      billIds={state.allBillIds}
      bills={state.bills}
      contact={contact}
      squareCustomerId={state.squareCustomerId}
      savedCards={state.savedCards}
      onSuccess={(result) => {
        // Store payment details for confirmation page
        sessionStorage.setItem(`payment_${state.orderId}`, JSON.stringify({
          cardBrand: result.cardBrand,
          cardLast4: result.cardLast4,
          amount: state.cashOwed,
          paymentId: result.paymentId,
        }));
        // Redirect to confirmation page (same as before)
        window.location.href = confirmationUrl;
      }}
      onError={(msg) => setState({ status: "error", message: msg })}
    />
  );
}
```

### Modify: `app/book/[attraction]/page.tsx`

Same pattern as OrderSummary. Replace the `handlePay()` function (lines 790-815):
- Instead of calling `/api/square/checkout` and redirecting
- Resolve Square customer, then set state to show `<PaymentForm>`
- Same `onSuccess` handler pattern

### Modify: `app/book/confirmation/page.tsx`

- Read `payment_${billId}` from sessionStorage (set by PaymentForm on success)
- Pass payment details (`cardBrand`, `cardLast4`, `amount`) into the notification payload
- No changes to the BMI `payment/confirm` flow — that stays exactly the same

---

## Phase 4: Card-on-File for Returning Racers

### Identity Linkage: BMI ↔ Square

**Phone number** is the bridge between the two systems:

```
BMI (SMS-Timing)              Square
┌──────────────┐    phone    ┌──────────────┐
│  personId    │─────────────│  customerId  │
│  fullName    │   (E.164)   │  phone       │
│  phone  ◄────────────────► │  name        │
│  memberships │             │  email       │
└──────────────┘             └──────┬───────┘
                                    │ customer_id
                              ┌─────┴──────┐
                              │  Cards API │
                              │  card_id   │
                              │  last4     │
                              │  brand     │
                              │  exp_month │
                              └────────────┘
```

- Racer verifies via SMS-Timing → we know their phone
- At checkout, we search Square customers by that phone (`POST /v2/customers/search`)
- If found → fetch their saved cards (`GET /v2/cards?customer_id=X`)
- If not found → create Square customer from BMI profile data → no cards yet
- Cards are stored on the Square customer via `POST /v2/cards` with `customer_id`
- Next visit: same phone → same Square customer → same saved cards

### Flow: Returning Racer with Saved Card

```
1. Racer verifies via phone/email/code → BMI returns PersonData
2. At checkout, we resolve their Square customer by phone
3. Fetch their saved cards via GET /v2/cards?customer_id={id}
4. PaymentForm shows SavedCardSelector with their cards
5. Racer picks a saved card → PaymentForm sends cardId as source_id
6. Server processes payment with card on file (no tokenization needed)
```

### Flow: Returning Racer Saves New Card

```
1. Racer at checkout → no saved cards (or chooses "new card")
2. PaymentForm shows card input + "Save this card for future visits" checkbox
3. Racer checks the box and pays
4. /api/square/pay processes payment AND stores card via POST /v2/cards
5. Next visit: card shows up in SavedCardSelector
```

### Flow: New Racer (no BMI profile)

```
1. New racer enters contact form
2. At checkout, we create a Square customer by phone (for payment tracking)
3. No saved cards — PaymentForm shows card input only
4. "Save card" checkbox NOT shown — new racers don't have a verified identity yet
5. On their NEXT visit as a returning racer, they CAN save a card
```

### Edge Cases
- **Expired saved card:** Shown grayed out, not selectable. User must enter new card.
- **Saved card declined:** Show error, fall back to new card input with clear message.
- **Multiple saved cards:** Show all non-expired, most recent first.
- **Customer not found in Square but exists in BMI:** Create Square customer from BMI data (name, phone, email), then proceed.

---

## Phase 5: Enhanced User Messaging

### Confirmation Email Additions

**Modify:** `app/api/notifications/booking-confirmation/route.ts`

Add new fields to the request body:
```ts
paymentAmount?: number;    // e.g. 49.99
cardBrand?: string;        // e.g. "VISA"
cardLast4?: string;        // e.g. "4242"
```

Add a new `^PaymentSection()$` placeholder in the email template:
```html
<!-- Only shown when payment details are present -->
<tr>
<td style="padding: 0 40px 24px 40px; font-family: Arial, sans-serif;">
<table width="100%" cellpadding="14" cellspacing="0" border="0"
       style="background-color: #F0F9FF; border: 1px solid #BFDBFE; border-radius: 6px;">
<tr><td style="font-family: Arial, sans-serif;">
  <p style="margin: 0 0 6px 0; font-size: 14px; font-weight: bold; color: #1E40AF;">Payment Received</p>
  <p style="margin: 0; font-size: 14px; color: #333;">
    $XX.XX charged to VISA ending in 4242
  </p>
</td></tr></table>
</td>
</tr>
```

**Modify:** `emails/booking-confirmation-waiver.html` — add `^PaymentSection()$` placeholder after the reservation section.

### SMS Additions

Add payment line to SMS body (after reservation info):
```
Payment: $49.99 — VISA ending in 4242
```

### Confirmation Page Inline Payment Details

**Modify:** `app/book/confirmation/page.tsx`

Read payment details from sessionStorage and display alongside the reservation:
```
Payment received: $49.99 — Visa ending in 4242
```

---

## Phase 6: Environment Variables

### New Variables Required
```env
NEXT_PUBLIC_SQUARE_APP_ID=sq0idp-xxxxx        # Square Application ID (public, for SDK init)
NEXT_PUBLIC_SQUARE_LOCATION_ID=Lxxxxx          # Location ID (public, for SDK init)
APPLE_PAY_MERCHANT_ID=merchant.com.fasttrax    # Apple Pay merchant ID (optional — Apple Pay won't render without it)
```

**Apple Pay Setup:** Requires registering a merchant ID with Apple and hosting a domain verification file at `/.well-known/apple-developer-merchantid-domain-association`. Google Pay works with just the Square Application ID.

### Existing Variables (no changes)
```env
SQUARE_ACCESS_TOKEN=EAAAl...     # Server-side only, already used
SQUARE_LOCATION_ID=Lxxxxx        # Server-side, already used
```

**Note:** The `NEXT_PUBLIC_` prefix makes these available client-side, which is required for the Square Web Payments SDK initialization. The Application ID and Location ID are public values (visible in Square's own JS on any merchant site).

---

## Files Summary

### New Files (4)
| File | Purpose |
|------|---------|
| `components/square/PaymentForm.tsx` | Square Web Payments SDK card form + Apple/Google Pay |
| `components/square/SavedCardSelector.tsx` | Saved card picker for returning racers |
| `app/api/square/pay/route.ts` | Server-side payment processing (create order + charge) |
| `app/api/square/customer/route.ts` | Find/create Square customer, list saved cards |

### Modified Files (5)
| File | Change |
|------|--------|
| `app/book/race/components/OrderSummary.tsx` | Replace Square redirect with inline PaymentForm |
| `app/book/[attraction]/page.tsx` | Replace Square redirect with inline PaymentForm |
| `app/book/confirmation/page.tsx` | Read + display payment details from sessionStorage |
| `app/api/notifications/booking-confirmation/route.ts` | Add payment details to email/SMS |
| `emails/booking-confirmation-waiver.html` | Add `^PaymentSection()$` placeholder |

### Unchanged Files
| File | Why |
|------|-----|
| `app/api/square/checkout/route.ts` | Keep as fallback — can remove later |
| `app/api/square/update-redirect/route.ts` | Only used by bowling (QAMF) |
| `app/api/square/loyalty/*` | Loyalty system untouched |
| `app/hp/book/bowling/*` | Bowling excluded from scope |

---

## Implementation Order

1. **`app/api/square/customer/route.ts`** — Find/create Square customer + list cards
2. **`app/api/square/pay/route.ts`** — Process payment with token or saved card
3. **`components/square/SavedCardSelector.tsx`** — Saved card picker UI
4. **`components/square/PaymentForm.tsx`** — Full payment form with SDK
5. **`app/book/race/components/OrderSummary.tsx`** — Wire up PaymentForm for racing
6. **`app/book/[attraction]/page.tsx`** — Wire up PaymentForm for attractions
7. **`emails/booking-confirmation-waiver.html`** — Add payment placeholder
8. **`app/api/notifications/booking-confirmation/route.ts`** — Payment in email/SMS
9. **`app/book/confirmation/page.tsx`** — Show payment details on confirmation

---

## Verification Plan

1. **Unit test the API routes** with Square sandbox credentials
   - `/api/square/customer` — create customer, search, list cards
   - `/api/square/pay` — successful payment, declined card, saved card payment
2. **Test PaymentForm in browser** with Square sandbox card numbers:
   - Success: `4111 1111 1111 1111`
   - Decline: `4000 0000 0000 0002`
   - CVV failure: `4000 0000 0000 0101`
3. **End-to-end racing checkout:**
   - New racer → full card entry → payment → confirmation → check email/SMS for payment details
   - Returning racer → save card → next visit → saved card appears → pay with saved card
4. **End-to-end attraction checkout:**
   - Book gel blaster → inline payment → confirmation
5. **Edge cases:**
   - Card declined → shows error → user enters different card → succeeds
   - Saved card expired → shown as unavailable → user enters new card
   - Network failure during payment → idempotency key prevents double charge on retry
   - Credit order → still bypasses payment entirely (no regression)
6. **Verify bowling is untouched** — bowling flow still uses QAMF redirect
