# PR-B2 GitHub PR description (draft)

**Branch:** `feat/booking-b2-race` → **Base:** `feat/booking2`

**PR creation URL:** https://github.com/BMA-Dassle/Tools-Website-FT/pull/new/feat/booking-b2-race

**Suggested title:**
> PR-B2: race v2 (BMI adapter, multi-heat, Square payment, confirmation)

**Mark as Draft until Phase A e2e verification passes.**

---

## Body (paste below into PR description)

## Summary

Ships the v2 race booking flow under `/book/race/v2` with the multi-activity cart foundation, end-to-end. v1's race flow at `/book/race` is untouched and keeps serving customers. v2 reuses v1's `/book/confirmation` page via a compat path so SMS, email, `sales_log`, and Pandora-waiver lookups all fire correctly.

- New race wizard: Party → Date → Adult Race → Adult Heats → Junior Race → Junior Heats → POV & Pack → Extras → Checkout
- Real BMI / SMS-Timing dayplanner / Pandora / Square calls — no mock mode
- Bundles checkout (Square anchor + BMI bookHeat + license + POV + add-ons + clickwrap), the BMI verification flow (returning-racer lookup + OTP), Premium Packages, and the HeightAge confirmation modal

## What's shipped

Full parity audit lives at [`tasks/pr-b2-parity-matrix-2026-05-24.md`](tasks/pr-b2-parity-matrix-2026-05-24.md). Summary:

| Category | Shipped | Replaced (compat / arch divergence) | Deferred | v2-only enhancement |
|---|---|---|---|---|
| Customer-visible features | 30 | 2 | 1 (POV Pandora linking) | 1 (Reservation timer) |
| Side effects | 4 | 3 (compat path) | 1 (BMI office notes) | 1 (booking-record 90d) |
| Vendor endpoints | 16 | — | 2 (Pandora POV) | 1 (SMS-verify OTP) |
| Error handling | 13 | — | — | — |

Zero ❌ Missed rows. Zero ⏸️ HOLD rows (sales_log writes inherit v1's compat path automatically).

## Scope decisions (resolved per `v1_race_parity_checklist.md`)

| # | Decision | Status |
|---|---|---|
| 1 | Multi-heat single-bill (3-pack day-of products) | ✅ Shipped — `RaceItem.heats[]`, BMI orderId chains heats |
| 2 | POV video purchase + Pandora session linking | ⏭️ **Deferred** to a "video features" PR (POV UI + sell ship in this PR; Pandora session linking does not) |
| 3 | Express-lane bypass on confirmation | ✅ Shipped — Pandora waiver lookup in RacePartyStep + bypass in shared v1 confirmation page |
| 4 | Rookie Pack appetizer code on confirmation | ✅ Shipped — `rookiePack: true` written to booking-record, shared v1 confirmation page renders the code |
| 5 | License upsell ($4.99 per first-timer) | ✅ Shipped — auto-sold during BMI `booking/sell` in `service/race.ts` |
| 6 | `sales_log` writes from v2 | ✅ Shipped via compat path — v2 redirects to `/book/confirmation` which POSTs to `/api/notifications/booking-confirmation` which calls `logSale()` |
| 7 | BMI office notes (`appendPrivateNote`) | ⏭️ **Deferred** — v1 BMI endpoint pending confirmation |

## Architectural divergences from v1 (intentional, called out)

- **Multi-activity cart:** one `BookingSession.items: SessionItem[]` anchored by one Square Order. Replaces v1's "chain HP add-ons to the race bill" pattern.
- **Per-member `isNewRacer`** in `PartyMember`, not party-wide `racerType`. User-confirmed during commit 8.
- **Brand = theming only.** `session.entryBrand` captured once at session creation, never mutates. Cart can mix FT + HP at Fort Myers; Shuffly resolves Red/Blue side via entryBrand.
- **Per-category step split** (`RaceProductStepAdult/Junior`, `RaceHeatPickerStepAdult/Junior`). v2's wizard runs one StepDef at a time; v1's bookingCategory cycling becomes two visibility-gated steps. Same UX outcome.
- **Booking-store key** is `booking:${billId}` (Redis colon) rather than v1's `booking_{billId}`. Shared confirmation page works with both formats (verify in Phase A).
- **Reservation timer** (10-min Ticketmaster-style countdown) is a v2-only enhancement — no v1 equivalent.
- **Comprehensive booking-record** (90d TTL, per-racer assignments + Rookie Pack flag) writes to a new `/api/booking-record` endpoint. v2-only.

## Test plan

Walk `http://localhost:3000/book/race/v2` end-to-end. Mark each ✅/❌ after testing.

| # | Path | Status |
|---|---|---|
| A1 | New racer single-heat: 1 adult new → date → Starter → heat → POV → checkout → Square sandbox → confirmation | ☐ |
| A2 | Existing racer (BMI verification): pick "returning" → ReturningRacerLookup → phone/email → OTP → linked account selection | ☐ |
| A3 | Mixed adult + junior new: confirm 2 BMI lines on one bill + 2 licenses auto-sold | ☐ |
| A4 | Multi-heat 3-Pack: Intermediate Weekday 3-Pack → TrackPickerModal Blue → 3 heats chained on BMI orderId | ☐ |
| A5 | Premium Package: pick multi-component package → PackageHeatPicker walks per-component → bundled pricing | ☐ |
| A6 | Add-ons: Gel Blaster (HP, per-person) + Shuffly (FT, per-group); pick slots avoiding race + cross-building 30-min buffer | ☐ |
| A7 | Discount code: `/book/v2?code=<active_race_code>` → land on race wizard → Square line discount applied | ☐ |
| A8 | HeightAgeConfirmModal: new racer → party → Next to date → modal appears → blocks until all checkboxes ticked | ☐ |
| A9 | Private event date: date in `lib/group-events.ts` GROUP_EVENTS → amber-greyed + tooltip + click blocked | ☐ |
| A10 | Mega Tuesday + new juniors: pick Tuesday with junior new racer → "Heads up — Mega Tuesday" banner + Next disabled | ☐ |
| A11 | Reservation timer: 10-min countdown in sticky bar, refresh works, expiry behavior verified | ☐ |
| A12 | Error path: trigger BMI failure mid-checkout (disconnect network during book) → no charge + retry UI surfaces | ☐ |

Side-effect verification (after a successful e2e):
- ☐ Square sandbox shows a charge with the correct line items + amount
- ☐ BMI bill shows reservation number + heat assignments
- ☐ `/admin/{token}/sales` shows the booking in `sales_log` (within ~1 min)
- ☐ Customer receives SMS confirmation
- ☐ Customer receives email confirmation
- ☐ Confirmation page shows QR per racer + reservation number + (if Rookie Pack) RACEAPP appetizer code

Build / typecheck / test:
- ☐ `npx turbo run typecheck test --filter=fasttrax-web` clean (currently 313/313 passing)
- ☐ `npx turbo run build --filter=fasttrax-web` clean

## Deferred to follow-up PRs

| Feature | Why | Next PR |
|---|---|---|
| POV Pandora session linking (8s post-confirm scheduling) | Scope decision §2 — separate video-features PR | "Race video features" |
| BMI office notes (`appendPrivateNote` buffer) | v1 BMI endpoint pending confirmation | TBD |
| Cross-session navigation (cross-sell tile joins existing cart) | Out of scope; squarely a v2 polish concern | PR-B2.5 |
| Race-pack credit purchases | Scope decision in `tasks/future/race-pack-as-credit-purchase.md` | PR-B4 |
| Square Orders + Catalog adapter wiring (`data/square.ts`, `data/square-catalog.ts`) | Racing doesn't need them; checkout calls `/api/square/pay` directly. Bowling + attractions will need the catalog reader | PR-B3 prerequisite |
| Selected `packageId` tracking on RaceItem (so sales_log captures Premium Package selections accurately) | Today, package selection isn't persisted to state, so `sales_log.package_id` is NULL for v2 package bookings. Same as v1's behavior for non-packaged bookings, but degrades package analytics | Small follow-up |

## Architectural reference

Memory files that document the rules this PR follows (auto-loaded for Alex's sessions):
- `feedback_v1_strict_parity_attraction_flow.md` — read v1 source before building; mirror, don't approximate
- `feedback_v2_parity_with_v1.md` — every v1 feature must exist in v2 unless explicitly replaced
- `feedback_no_mock_mode.md` — BMI / Square / Pandora / KBF always hit live endpoints
- `booking_v2_architecture.md` — multi-activity cart rules
- `booking_v2_promo_integration.md` — discount-codes integration
- `v1_race_parity_checklist.md` — comprehensive v1 race behavior checklist

## Open questions for review

1. **Selected `packageId` tracking** — should we land the small follow-up (~10 lines on RaceItem state + 1 line in `saveBookingDetails`) before merge so Premium Package bookings are counted correctly in `sales_log`? Currently they're counted as plain race bookings.
2. **Booking-store key format** (`booking:${billId}` vs v1's `booking_{billId}`) — verify the shared v1 confirmation page reads the new key. If not, either rename or add a fallback read.
3. **Cross-session navigation** — should PR-B2.5 land before PR-B3 (attractions) or after?

---

## Commits in this PR

```
e2d5c37e  PR-B2 commits 10-14: checkout, confirmation compat, racing features complete
9e0636ca  PR-B2 commit 9b 5/7: strict v1 visual parity reverts + handoff doc
8e984622  PR-B2 commit 9b 4/7: RaceAddonsStep -- v1 AddOnsPage port
498f9f73  PR-B2 commit 9b 3/7: RacePovStep -- POV upsell + Rookie Pack chooser
7dbc8736  PR-B2 commit 9b 2d/7: RaceHeatPickerStep v1 warnings
ace031f1  PR-B2 commit 9b 2c/7: RaceProductStep v1 parity -- TrackPickerModal, tier descs
4e269530  PR-B2 commit 9b 2b/7: RaceDateStep v1 warnings + operating principles
4ada9ba9  PR-B2 commit 9b 2a/7: race v1-parity step order + per-racer modal
d784457a  PR-B2 9b polish: drop isNewRacer checkbox + back-to-landing link + remove wrong-domain redirect
92dcf1d2  PR-B2 commit 9b (1/4): RaceProductStep — tier-grouped product picker
c7eb4513  PR-B2 fix: match real admin slug vocabulary in isOfferingInPromoScope
cfd4c882  PR-B2 landing rev 2.5: match HP book hub styling + highlight (not filter) on promo
3fbb54cf  PR-B2 commit 8.5: promo session state + /book/v2 landing + slug-mismatch redirect
5ab845cf  PR-B2 commit 9a: real RaceDateStep + RacePartyStep (visual reference check)
0c4fa83e  PR-B2 commit 8: state-shape refactor — party roster + per-line assignments
0029f342  PR-B2 commit 7: race service modules + Square catalog reader (mock)
ea2ad8d7  PR-B2 commit 6 close-out: export bmiAdapter from data/index.ts
```

Plus discount-codes work that merged in from main (cross-domain promo support, used by the v2 race wizard's promo integration).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
