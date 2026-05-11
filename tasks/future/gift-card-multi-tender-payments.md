# Gift Card + Multi-Tender Payment Support

**Status:** Research complete, no implementation started
**Date:** 2026-05-11

## Goal

Accept Square gift cards as a payment method across all payment flows (bowling, racing, attractions). Support partial/split payments: if gift card balance is insufficient, allow the remainder on card/Apple Pay/Google Pay.

## Current Payment Landscape

Three independent payment components, no shared abstraction:

| Component | File | Used by | Methods | Backend |
|-----------|------|---------|---------|---------|
| `PaymentForm` | `components/square/PaymentForm.tsx` | Racing, race packs, attractions | Card, Apple Pay, Google Pay, saved cards | `/api/square/pay` |
| `BowlingPaymentStep` | `components/bowling/BowlingPaymentStep.tsx` | KBF, open bowling wizards | Card, Apple Pay | `/api/square/bowling-orders` (5-step) |
| `CardCaptureForm` | `components/square/CardCaptureForm.tsx` | Subscriptions | Card only | Parent-controlled |

### Key differences between flows

- **Racing:** Square charge + optional Pandora `addDeposit()` post-action (race packs). Uses `postPaymentAction` prop.
- **Bowling:** 5-step flow: day-of order (open) -> deposit order -> charge -> create internal eGift card -> activate. The eGift card is an *internal* deposit-tracking mechanism, NOT customer-facing.
- **Attractions:** Simple Square charge. No post-payment actions.

## Square SDK Gift Card Capabilities

### Frontend (Web Payments SDK)
- `payments.giftCard()` follows same attach/tokenize pattern as `payments.card()`
- Attaches to a DOM element, renders a GAN input field
- `giftCard.tokenize()` returns a nonce like card tokenize
- **Not currently declared** in our `SquarePayments` interface — needs adding

### Backend (Square API)
- `RetrieveGiftCardFromNonce` — takes nonce, returns gift card object with balance
- `CreatePayment` with gift card nonce as `source_id` + `accept_partial_authorization: true` — charges up to available balance, returns `approved_money` showing actual amount charged
- Multi-tender: separate `CreatePayment` calls against same `order_id`, finalize with `PayOrder` (or let Square auto-close when fully covered with `autocomplete: true`)

### Multi-Tender Flow
1. Create order
2. Charge gift card: `CreatePayment` with `accept_partial_authorization: true`, `autocomplete: true`
3. Check `approved_money` — if less than order total, charge remainder on card/wallet
4. Square auto-closes order when payments cover the total

## What Exists vs. What Needs Building

### Already built
- Order creation (day-of + deposit pattern, catalog items, tax)
- Single-source payment processing (card, Apple Pay, Google Pay, saved cards)
- Customer management (phone lookup, card-on-file)
- Internal gift card creation/activation (bowling deposit tracking)
- Gift card refunds/deactivation (bowling cancellation)
- Loyalty program integration

### Needs to be built
- `payments.giftCard()` SDK integration (frontend)
- Gift card balance inquiry endpoint (`/api/square/gift-card-balance`)
- Multi-tender payment flow (multiple `CreatePayment` calls per order)
- `accept_partial_authorization` support
- Shared payment method selector UI (gift card + card + wallets)
- Split payment summary UI (shows what's on gift card vs. card)
- Per-flow backend changes to support multiple payment sources

## Proposed Architecture (not finalized)

**Composable pieces** (Option C from planning) — minimal disruption:

1. **`GiftCardCapture`** component — attaches `payments.giftCard()`, tokenizes, server-side balance check
2. **`PaymentMethodSelector`** component — tabs/radio for gift card vs. card vs. wallet
3. **`MultiTenderSummary`** component — shows applied gift card amount + remaining for card
4. Each existing flow composes these into its existing payment step

**Backend:** Each existing endpoint (`/api/square/pay`, `/api/square/bowling-orders`) gets multi-tender support independently, since their flows are structurally different.

## Constraints & Warnings

- **BMI racing deposit is different from bowling deposit** — user explicitly warned to be careful with shared components
- **Bowling's internal eGift card** is a separate concept from customer-facing gift card payments — don't confuse them
- **No shared payment abstraction exists today** — user acknowledged this ("I'm afraid we're not using shared components for payments though")
- **Single Square access token** across all locations — not per-location
- **Tax is order-scoped** via catalog tax objects, not per line-item
- **No `PayOrder` or `accept_partial` code exists anywhere** — fully greenfield

## User Quotes (for context)

> "On our payment screen I'd like to accept gift cards. This goes across all payments, bowling, racing attractions."

> "Gift cards are going to be Square gift cards and need to support partial payment. So if you don't have enough on the gift card you need to allow rest on another form of payment."

> "I'm afraid we're not using shared components for payments though."

> "Keep in mind BMI racing flow deposit is slightly different than our bowling deposits so be careful with shared component."
