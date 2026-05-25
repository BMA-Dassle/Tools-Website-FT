# Open Tasks

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

## SEO: HeadPinz metadata on shared /book routes
- **Priority:** High
- **Issue:** `headpinz.com/book/*` pages show FastTrax title/description in Google results because `/book` routes use the root layout metadata (FastTrax-branded), not the `/hp` layout
- **Root cause:** Middleware line 69 excludes `/book` from the `/hp` rewrite, so shared booking pages inherit the root `app/layout.tsx` metadata
- **Fix:** Use `generateMetadata` in `/book` pages that reads the `x-brand` header (set by middleware) to return HeadPinz or FastTrax metadata dynamically
- **Files:** `app/layout.tsx`, `app/book/[attraction]/page.tsx`, `app/book/race/page.tsx`, `middleware.ts`
- **Google result example:** `headpinz.com/book/gel-blaster` shows "Indoor Go-Kart Racing & Entertainment | Fort Myers, FL" and "63000 sq ft of high-performance electric go-kart racing..."
