# Open Tasks

## ⚠️ Temporary fallbacks to remove later

- **Race + standalone-attraction day-of auto-charge on start-time-passed** (added 2026-06-09,
  user-requested stopgap). `/api/cron/race-dayof-pay` normally settles the day-of order only when
  it sees the guest Arrived (-5) on the SMS-Timing dayplanner. As a safety net it now ALSO settles
  when the **activity start time has passed** (earliest heat for race, earliest slot for
  attraction — from `booking_metadata`, NOT `booked_at`), even if the Arrived scan failed/never
  fired. Standalone attractions = no bowling sharing the day-of order (bowling carts settle via
  lane-open). Remove once -5 detection is proven reliable. Search `FALLBACK` in
  `apps/web/app/api/cron/race-dayof-pay/route.ts` to delete (revert the scan-error bail too).
  NOTE: legacy attraction rows booked before this have empty `booking_metadata` → no start time →
  they're skipped (settle them manually via `?billId=…&token=…` if needed).

## HP Arena E-Tickets — Laser Tag + Gel Blaster at HeadPinz FM (LIVE — 2026-06-11)

**Status:** fully live, including the "now checking in" flow. Runbook + integration notes:
`docs/hp-arena-etickets-rollout.md`. Owner decisions: FM only (Naples later) · laser tag +
gel blaster · full HeadPinz identity (HP sender `+12393022155`, headpinz.com links).

- [x] PR-1..PR-5 (shared plumbing, HP ticket views, pre-session cron, schedule, scanner +
      `ARENA_QR_ENABLED`) — merged to main 2026-06-11, cron live (owner approved skipping the
      dry-run sequence; sender = existing HP DID).
- [x] PANDORA ASK — delivered same-day: `sessions/current` (called arena sessions) +
      `sessions/next` (next unstarted session by person/participant). Wired:
      `arena-checkin-alerts` cron (1 min — `race:called:{sid}` banner + NOW CHECKING IN
      SMS/email, source `arena-checkin-cron`) and scanner (called-signal green gate w/
      time-window fallback, "come back at X" via sessions/next).
- [ ] OWNER 0b: verify whether ONLINE arena bookings attach participants pre-session (book one
      2h+ out, probe participants). If purchaser-only/none → coverage = POS/phone population;
      follow-up = send e-ticket link at booking-confirmation time.
- [ ] OWNER 0d: sign off ImportantArenaInfo arrival/waiver copy (conservative defaults live).
- [ ] POST-LAUNCH WATCH (first week): admin board arena rows, `cron:log` `arena-pre` +
      `arena-checkin`, `unclassifiedSessions` in cron responses, undelivered rate on the HP DID,
      racing `bySource.eTicket` canary.
- ⚠️ BEFORE NAPLES: `ticket:bySession:{sid}:{pid}` + `alert:arena-pre/arena-checkin:{sid}:{pid}`
      + `race:called:{sid}` keys are NOT location-scoped — fine at FM (FT+HP FM share one BMI
      server / sessionId namespace), but Naples is a separate BMI server → add a location
      segment to these keys first.

## Booking V1→V2 FULL CUTOVER + race-pack port (IN PROGRESS — 2026-06-07)

**Goal (user directive):** V2 is the booking system. Replace ALL booking entry points
with entry into V2, AND port race-packs to V2 (the only activity with no v2 today).

**Grounding:** ~90 v1 entry points inventoried; 4 shared components carry most traffic.
Cutover mechanism = server-side redirects (catch emails/QR/bookmarks) + middleware fix +
update the hot shared links. Honors the repo cutover rule (redirect v1→v2; delete v1 later).
Decisions locked by `tasks/future/race-pack-as-credit-purchase.md` + v1 parity: race-pack
DEFERS redemption (credits spent in the existing v2 race flow), NO expiration (v1 = year-2999),
single Square SKU + name override, grant via `addDeposit(+N)` on Square capture.

### Phase A — Entry-point cutover for race/attraction/bowling/KBF (conflict-free w/ other workflow)
- [ ] Middleware: exclude `/v2` paths from the HeadPinz `/hp` + `/book/bowling*` + `/book/kids-bowl-free*`
      rewrites (FIXES latent bug: `headpinz.com/book/bowling/v2` → `/hp/book/bowling/v2` 404). Point
      HeadPinz `/book` (exact) → `/book/v2` instead of `/hp/book`.
- [ ] `next.config.ts` redirects (307 temporary during cutover — flip to 308 when v1 deleted):
      `/book`→`/book/v2`, `/book/race`→`/book/race/v2`, `/book/{gel-blaster,laser-tag,duck-pin,shuffly}`→`…/v2`,
      `/book/bowling`→`/book/bowling/v2`, `/book/kids-bowl-free`→`/book/kbf/v2`, plus `/hp/book/*` equivalents.
      EXCLUDE `/book/race-packs`, `/book/confirmation*`, `/book/checkout`, anything `/v2`.
- [ ] Update 4 shared components → v2: `components/Nav.tsx`, `components/MobileBookBar.tsx`,
      `components/headpinz/Nav.tsx`, `components/headpinz/MobileBookBar.tsx`.
- [ ] Update high-traffic CTAs (home Hero, pricing, racing, leaderboards, hp/fort-myers, hp/naples) → v2.
- [ ] Update static email-template booking URLs (redirects also catch these).
- [ ] **MERGE GATE:** bowling/KBF v2 must pass the QAMF+Square smoke test before this branch hits prod.

### Phase B — Race-pack v2 port (DONE — STANDALONE, 2026-06-07)
**Approach:** standalone `/book/race-pack/v2` (user: "whichever easiest/most efficient"). Deliberately
NOT the in-cart `CreditPackItem` from the design doc — that threads through `unified-reserve.ts` +
`types.ts`, which the other workflow is mid-refactor on. Standalone matches what v1 actually does
(race-packs is its own flow) and reuses v1's PROVEN, server-atomic Square + `addDeposit` money rail.
Touches ZERO files the other workflow is editing.
- [x] `src/features/booking/data/packs.ts` — 6 SKUs verified 1:1 vs v1 (price, depositKind, raceCount, shared Square SKU).
- [x] `src/components/features/booking/RacePackFlow.tsx` — pick pack → identify racer (returning lookup /
      new) → review + clickwrap → `PaymentForm` (lineItem + `postPaymentAction:addDeposit`).
- [x] Route `app/book/race-pack/v2/page.tsx` (thin server shell + metadata).
- [x] Confirmation reuses v1 `/book/race-packs/confirmation` (already renders the viaDeposit "Credits
      Loaded" + "Credits Pending" states) — left on v1, NOT redirected.
- N/A `CreditPackItem` union / `credit-pack` service / `unified-reserve.ts` wiring / step registry —
      unused by the standalone approach (charge goes through `/api/square/pay`, never unified-reserve).
- N/A Landing tile on `/book/v2` — the v1 `/book` hub never listed packs either (parity-correct).
- ⚠️ Simplification vs v1: per-mode OTP omitted (loading credits is non-extractive — the buyer pays to
      ADD value, so there's no account-takeover surface to gate). Revisit if abuse ever appears.
- FOLLOW-UP (optional): in-cart `CreditPackItem` integration once the other workflow's unified-reserve
      refactor lands, if mixing a pack into a multi-activity session is ever wanted.

### Phase C — Race-pack cutover (DONE — 2026-06-07)
- [x] Redirect `/book/race-packs` → `/book/race-pack/v2` (middleware `bookingV2Target`, exact match so
      `/book/race-packs/confirmation` stays on v1). Pricing "View Packages" CTA covered by the redirect.
- [ ] Retire/delete the v1 `/book/race-packs` page in a later PR after ops sign-off.

### Phase D — HeadPinz center-aware v2 landing (DONE — 2026-06-07)
Convert HPFM/HPN booking to v2 with center-scoped offering order on `/book/v2`.
- [x] `landingOfferingsFor(brand, center)` in `activities-catalog.ts` — Naples scopes to ONLY
      Naples-available offerings (drops FT-only race/duckpin/shuffly); Fort Myers/unknown shows all;
      within scope the VISITOR'S brand propagates first (FastTrax-first on FT, HP-first on HP;
      shuffly's "auto" brand resolves to the entry brand). + 5 unit tests (26/26 catalog tests pass).
- [x] `?location=` → `session.center`: `EntryContext.center` + parsed in `parse-entry-context.ts`
      (was an unused gap — `setCenter` was never dispatched in v2, so center was always null/FM).
      `BookingFlow` seeds `setCenter` on a fresh session → Naples books with the Naples clientKey.
- [x] `/book/v2` page resolves center from `?location` + passes ordered offerings + center to PromoLanding.
- [x] `PromoLanding` tile links carry `?location` so the picked activity seeds the right center.
- Entry: Naples hero CTA (`/hp/book?location=naples`) → Phase-A redirect → `/book/v2?location=naples` → scopes. ✓
- ⚠️ Minor pre-existing gaps (not blocking): HP nav "Book Now" goes bowling-direct (not the grid) and
      one `/naples` laser-tag link lacks `?location` → defaults to FM center. Polish later if wanted.

## Group-Function: re-price after paid-in-full (IMPLEMENTED — 2026-06-06)
- **Plan + impl log:** [group-function-paid-in-full-reprice.md](group-function-paid-in-full-reprice.md)
- **Problem:** A BMI edit on a *paid-in-full* event recomputed balance as `total − deposit_due`, ignoring the balance already collected → re-sign re-charged it → **overcharge**. No path to charge just the delta. Also: paid Square balance links were never reconciled.
- **Scope (Eric):** Only paid-in-full events. Resign required regardless. Increase → charge difference + load gift cards (card on file, or capture a card on re-sign). Decrease → flag staff, no auto-refund. Deposit-phase flows untouched.
- **Status:** PR-1 + PR-2 implemented on branch `feat/gf-balance-link-reconcile`; typecheck/lint/prettier clean. **Not committed; not live-smoke-tested.** Verify §6 before go-live.

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
  - D16 (2026-06-02): Mixed-cart guard — **NEVER LANDED / entry is stale** (verified 2026-06-10: `addItem` allows mixed carts — `machine.test.ts:62` asserts it; `buildCombinedLineItems` merges race+bowling+attraction into one Square order). Kept that way DELIBERATELY: combo specials ([combo-specials-plan.md](combo-specials-plan.md)) require race+bowling in one session. Do NOT re-add a guard.
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
