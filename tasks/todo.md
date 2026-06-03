# Open Tasks

## PR-B5: Bowling + KBF into Unified BookingFlow (IN PROGRESS — 2026-06-02)
- **Branch:** `feat/booking-b2-race` · merged with main 2026-06-02
- **What shipped (all build-verified):**
  - D1: Type extensions — BowlingItem/KbfItem with 30+ fields, LoyaltyState on BookingSession, 5 new reducer actions
  - D2: Bowling service — `service/bowling.ts` (hold/confirm/cancel/reserve) wired into `getService()`
  - D3: 7 bowling step components — Players, Slots, Tier, Offer (QAMF hold), Shoes, Attractions (info-only), Food
  - D4: 2 KBF steps — KbfIdentity (lookup→OTP→verify), KbfBowlers (family member selection)
  - D5: Hold timer generalized — ReservationTimer handles BMI + QAMF with 8-min auto-extend
  - D6: Checkout bowling path → `bowlingReserve()` → `/api/bowling/v2/reserve`
  - D6b: Shared HeadPinz Loyalty — LoyaltySection at checkout for ALL HeadPinz bookings (earning + redeeming)
  - D7: Step registry — all bowling/kbf placeholders replaced with real components
  - D8: Deposit unification — bowling reserve uses `createDepositAndCharge()`, same as race/attraction
  - D9: DiscountCodeInput on bowling slots step
  - D10 (2026-06-02): BowlingSlotsStep → HP_LOCATIONS for real center hours
  - D11 (2026-06-02): BowlingOfferStep — duration picker for hourly, line-item enrichment (label/price/catalog/deposit%), per-lane vs per-person multipliers, product overrides
  - D12 (2026-06-02): Checkout quote fetch from `/api/square/bowling-orders/quote` + real line-item display (product names, per-line amounts, booking fee, tax, deposit breakdown)
  - D13 (2026-06-02): BowlingShoesStep stores shoe product metadata for checkout name resolution
  - D14 (2026-06-02): BowlingAttractionsStep → info-only (attractions are separate cart items, same as racing)
  - D15 (2026-06-02): Loyalty params wired to BMI reserve path (loyaltyAccountId, rewardTierId, rewardDiscountCents)
  - D16 (2026-06-02): Mixed-cart guard — bowling (QAMF) and race/attraction (BMI) can't share a checkout; cross-sell + reducer reject incompatible adds
- **Still needs before go-live:**
  - Smoke test with QAMF staging + Square sandbox
  - Full Square Loyalty API reward creation in BMI reserve route (currently applies discount only; bowling route has full implementation)

## v2 Checkout: Server-side atomic BMI payment/confirm
- **Priority:** Medium (v2 checkout milestone)
- **Context:** v1 confirms BMI payment client-side on the confirmation page after Square charges. PR #13 (2026-06-02) added retry + error UI as an immediate fix, but the architecture still has a gap if the browser closes between Square charge and confirmation page load.
- **v2 fix:** Add `confirmBmi` postPaymentAction to `/api/square/pay` so Square charge + BMI confirm happen atomically server-side. Extract shared `lib/bmi-client.ts` for BMI auth + `confirmPayment()`. Wire into v2 checkout service.
- **See:** [restructure-plan.md § v2 checkout: server-side atomic BMI payment/confirm](restructure-plan.md)

## SEO: HeadPinz metadata on shared /book routes
- **Priority:** High
- **Issue:** `headpinz.com/book/*` pages show FastTrax title/description in Google results because `/book` routes use the root layout metadata (FastTrax-branded), not the `/hp` layout
- **Root cause:** Middleware line 69 excludes `/book` from the `/hp` rewrite, so shared booking pages inherit the root `app/layout.tsx` metadata
- **Fix:** Use `generateMetadata` in `/book` pages that reads the `x-brand` header (set by middleware) to return HeadPinz or FastTrax metadata dynamically
- **Files:** `app/layout.tsx`, `app/book/[attraction]/page.tsx`, `app/book/race/page.tsx`, `middleware.ts`
- **Google result example:** `headpinz.com/book/gel-blaster` shows "Indoor Go-Kart Racing & Entertainment | Fort Myers, FL" and "63000 sq ft of high-performance electric go-kart racing..."
