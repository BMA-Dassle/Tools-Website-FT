# Open Tasks

## PR-B3.5: Shared Deposit + Reservations Infrastructure (DONE — 2026-05-27)
- **Branch:** `feat/booking-b2-race`
- **What shipped (all deliverables build-verified):**
  - D1: Neon reservations schema widened — `ReservationProductKind` now "kbf" | "open" | "race" | "attraction", `booking_metadata` JSONB column, `productKinds` filter param on `listBowlingReservations()`
  - D2: Shared deposit service — `createDepositAndCharge()` + `rollbackDeposit()` extracted from bowling-orders into `features/booking/service/deposit.ts`
  - D2b: Square catalog map — 57+ race + 12+ attraction BMI product IDs mapped to Square catalog variation IDs in `features/booking/data/square-catalog-map.ts`
  - D2 addon: GAN regex updated for RACE/ATTR prefixes in `square-gift-card.ts`
  - D3: v2 Reserve API route at `/api/booking/v2/reserve` — builds Square day-of order (catalog line items + county tax), charges deposit via shared service, confirms BMI payment server-side (bigint-safe), persists Neon reservation
  - D4: v2 checkout wiring — `reserveBooking()` in checkout.ts, `onTokenize` prop on PaymentForm for tokenize-only mode, CheckoutStep calls reserve route instead of /api/square/pay, confirmation page skips payment/confirm for v2=1 bookings
  - D5: Admin dashboard — product kind badges (Race=green, Attr=orange alongside existing KBF=purple, Open=blue), kind filter tabs with counts, `bmiBillId`/`bmiReservationNumber` fields on Reservation interface
- **Still needs:** end-to-end smoke test with real Square sandbox + BMI staging

## PR-B4: Race-Pack Credit Purchase v2 (IN PROGRESS — 2026-05-27)
- **Branch:** `feat/booking-b2-race`
- **What shipped (all deliverables build-verified):**
  - D1: Pack data layer — `features/booking/data/race-packs.ts` with 6 pack variants, typed interfaces, tax/total helpers, Square catalog + location + tax IDs
  - D2: Server-side purchase route — `/api/booking/v2/purchase-pack/route.ts` orchestrates validate → person resolution → Square order → multi-tender charge → Pandora deposit → Neon insert → sales log → Redis store
  - D3: Client service — `features/booking/service/credit-pack.ts` thin POST wrapper
  - D4: UI flow — `RacePackFlow.tsx` 3-step wizard (select → racer → review+pay), `page.tsx` + `layout.tsx` at `/book/race-pack/v2`, reuses ReturningRacerLookup + PaymentForm + ClickwrapCheckbox
  - D5: Admin dashboard — "race-pack" ReservationProductKind, amber "Pack" badge, "Race Pack" full label, filter tab
- **Still needs:** manual smoke test, then commit + push

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
- **Resolved:** "License removal" bug is NOT reproducible — license isn't a separate cart item, it's auto-computed from `session.party` members with `isNewRacer`. No per-line remove buttons exist. The estimate in the cart and the actual charge at checkout both derive from party state.
- **Still needs manual testing:** timer expiry (10-min wait), cross-sell round-trip, tab restore persistence

## SEO: HeadPinz metadata on shared /book routes
- **Priority:** High
- **Issue:** `headpinz.com/book/*` pages show FastTrax title/description in Google results because `/book` routes use the root layout metadata (FastTrax-branded), not the `/hp` layout
- **Root cause:** Middleware line 69 excludes `/book` from the `/hp` rewrite, so shared booking pages inherit the root `app/layout.tsx` metadata
- **Fix:** Use `generateMetadata` in `/book` pages that reads the `x-brand` header (set by middleware) to return HeadPinz or FastTrax metadata dynamically
- **Files:** `app/layout.tsx`, `app/book/[attraction]/page.tsx`, `app/book/race/page.tsx`, `middleware.ts`
- **Google result example:** `headpinz.com/book/gel-blaster` shows "Indoor Go-Kart Racing & Entertainment | Fort Myers, FL" and "63000 sq ft of high-performance electric go-kart racing..."
