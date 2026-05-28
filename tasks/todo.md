# Open Tasks

## PR-B3.5: Shared Deposit + Reservations Infrastructure (IN PROGRESS — 2026-05-27)
- **Branch:** `feat/booking-b2-race`
- **What shipped (all deliverables build-verified):**
  - D1: Neon reservations schema widened — `ReservationProductKind` now "kbf" | "open" | "race" | "attraction", `booking_metadata` JSONB column, `productKinds` filter param on `listBowlingReservations()`
  - D2: Shared deposit service — `createDepositAndCharge()` + `rollbackDeposit()` extracted from bowling-orders into `features/booking/service/deposit.ts`
  - D2b: Square catalog map — 57+ race + 12+ attraction BMI product IDs mapped to Square catalog variation IDs in `features/booking/data/square-catalog-map.ts`
  - D2 addon: GAN regex updated for RACE/ATTR prefixes in `square-gift-card.ts`
  - D3: v2 Reserve API route at `/api/booking/v2/reserve` — builds Square day-of order (catalog line items + county tax), charges deposit via shared service, confirms BMI payment server-side (bigint-safe), persists Neon reservation
  - D4: v2 checkout wiring — `reserveBooking()` in checkout.ts, `onTokenize` prop on PaymentForm for tokenize-only mode, CheckoutStep calls reserve route instead of /api/square/pay, confirmation page skips payment/confirm for v2=1 bookings
  - D5: Admin dashboard — product kind badges (Race=green, Attr=orange alongside existing KBF=purple, Open=blue), kind filter tabs with counts, `bmiBillId`/`bmiReservationNumber` fields on Reservation interface
- **Still needs:** end-to-end smoke test with real Square sandbox + BMI staging, then commit + push

## PR-B2.5: Session Persistence + Cross-Sell + Timer Expiry (DONE — 2026-05-25)
- **Branch:** `feat/booking-b2-race` @ `d120b614` · pushed
- **What shipped:**
  - `usePersistedReducer` hook — sessionStorage persistence, SSR-safe (hydrates post-mount via `restoreSession` action)
  - Cross-sell navigation — BookingFlow detects incoming activity not in cart, adds it after hydration
  - ReservationTimer `forwardRef` + `useImperativeHandle` exposing `refresh()`
  - ReservationExpiredModal — blocking modal with Extend Time / Start Over
  - MiniCartV2 — floating cart button on `/book/v2` landing page
  - LeaveConfirmModal no longer clears session; copy says "progress is saved"
  - CheckoutStep calls `clearBookingSession()` before redirect
- **Known bug:** New racers can remove license from cart (cart remove button not guarded for mandatory items)
- **Still needs manual testing:** timer expiry (10-min wait), cross-sell round-trip, tab restore persistence

## PR-B5: Bowling + KBF into Unified BookingFlow (IN PROGRESS — 2026-05-28)
- **Branch:** `feat/booking-b2-race`
- **What shipped (all deliverables build-verified):**
  - D1: Type extensions — BowlingItem/KbfItem with 30+ fields (experience, QAMF, shoes, food, pricing), LoyaltyState on BookingSession, 5 new reducer actions
  - D2: Bowling service — `service/bowling.ts` with hold/confirm/cancel/reserve, wired into `getService()` for bowling + kbf
  - D3: 7 bowling step components — BowlingPlayers, BowlingSlots (calendar+hours+minutes), BowlingTier (Regular/VIP video cards), BowlingOffer (experience cards + QAMF hold), BowlingShoes (rental add-ons), BowlingAttractions, BowlingFood (pizza-bowl modifiers)
  - D4: 2 KBF steps — KbfIdentity (lookup → OTP → verify composite), KbfBowlers (family member selection)
  - D5: Hold timer generalized — ReservationTimer handles both BMI and QAMF holds with auto-extend
  - D6: Checkout integration — bowling path in CheckoutStep routes to `bowlingReserve()` → `/api/bowling/v2/reserve`
  - D6b: Shared loyalty — LoyaltySection component for HeadPinz Rewards (earning + redeeming) at checkout for ALL HeadPinz bookings
  - D7: Step registry — all placeholders replaced with real components
  - D8: Deposit unification — bowling reserve migrated from `/api/square/bowling-orders` to shared `createDepositAndCharge()`
- **Still needs:** DiscountCodeInput for mid-flow entry on bowling slots, end-to-end testing

## SEO: HeadPinz metadata on shared /book routes
- **Priority:** High
- **Issue:** `headpinz.com/book/*` pages show FastTrax title/description in Google results because `/book` routes use the root layout metadata (FastTrax-branded), not the `/hp` layout
- **Root cause:** Middleware line 69 excludes `/book` from the `/hp` rewrite, so shared booking pages inherit the root `app/layout.tsx` metadata
- **Fix:** Use `generateMetadata` in `/book` pages that reads the `x-brand` header (set by middleware) to return HeadPinz or FastTrax metadata dynamically
- **Files:** `app/layout.tsx`, `app/book/[attraction]/page.tsx`, `app/book/race/page.tsx`, `middleware.ts`
- **Google result example:** `headpinz.com/book/gel-blaster` shows "Indoor Go-Kart Racing & Entertainment | Fort Myers, FL" and "63000 sq ft of high-performance electric go-kart racing..."
