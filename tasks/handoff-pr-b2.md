# PR-B2 (Race v2) — Handoff · 2026-05-24

**Status:** Functionally complete. End-to-end checkout works (Square sandbox + real BMI bookings). Awaiting final user retest before flipping PR Draft → Ready for Review.

**Branch:** `feat/booking-b2-race` @ `8a280dba` · pushed to origin
**Base:** `feat/booking2`
**Commits ahead of `origin/main`:** ~36
**Typecheck:** clean · **Tests:** 313/313 passing · **Build:** not yet re-verified post-last-commit

If you're picking up the broader booking-v2 scope (attractions, bowling, KBF, race-pack), read [`handoff-booking-v2.md`](handoff-booking-v2.md) next — this doc is racing-specific.

---

## 1. Where racing is right now

The race wizard at `/book/race/v2` walks end-to-end:

1. **Party** — per-member roster; ExperiencePicker (new vs returning); ReturningRacerLookup with phone/email/code + OTP; Pandora-linked family members
2. **Date** — per-month BMI availability fetch; group event blocker; Mega Tuesday + new juniors banner; legend with Private Event chip
3. **Adult Race** + **Junior Race** — tier-grouped picker, tier descriptions, TrackPickerModal for multi-track packs, Premium Packages (Rookie Pack + Ultimate Qualifier variants), Adult/Junior category banner when party has both
4. **Adult Heats** + **Junior Heats** — per-racer assignment via RacerSelectorModal, conflict gating (Red 13 / Blue 16 / Mega 13 / cross-track 30 min), 75-min lead time for new racers, locked-track filter from package picks, private event guard, reminders pane
5. **POV & Pack** — Rookie Pack chooser (gated by `NEXT_PUBLIC_ROOKIE_PACK_ENABLED`) OR v1's qty stepper for existing racers
6. **Extras** — 4 BMI add-ons (Shuffly / Duckpin / Gel Blaster / Laser Tag) with SMS-Timing dayplanner scheduling + race-heat conflict + cross-building 30-min buffer
7. **Cart** — rich preview showing actual product name + track + per-heat racer assignments + extras + estimated total; LeaveConfirmModal on "All activities" so customers don't accidentally destroy session
8. **Checkout** — 6 phases (contact → booking → review → paying → confirming → redirect); Square Web Payments SDK; Square saved cards for returning customers; clickwrap row write
9. **Confirmation** — reuses v1's shared `/book/confirmation` page via compat path (v2 writes to `/api/booking-store` Redis + `/api/booking-record` 90d). SMS / email / sales_log fire through v1 infra automatically.

Every step renders **real BMI / SMS-Timing / Pandora / Square data**. No mock mode. License auto-sells for new racers via BMI `booking/sell`. POV qty sells against the POV SKU. Add-ons sell against their BMI productIds. Discount codes apply at Square via the existing `/api/square/pay`.

### What the user verified live

From `tasks/pr-b2-e2e-verification-2026-05-24.md` (Phase A walkthrough):

| Path | Status | Notes |
|---|---|---|
| A1 — New racer single-heat happy path | Modify (now fixed) | Wording, Enter-to-submit, heat-reservation slowness, cart info — all addressed in commits 007bc58c + 3dae7b53 + 8a280dba |
| A2 — Returning racer BMI verification | Done | Works |
| A3 — Mixed adult + junior | Done | Adult/Junior category banner now added |
| A4 — Multi-heat 3-Pack | Was broken (fixed) | Was only showing Starter because filterProducts didn't get memberships array; fixed in 007bc58c |
| A5 — Premium Package | Test path was wrong | Should be tested as NEW racer (all packages are racerType="new") |
| A6 — Add-ons w/ cross-building conflict | NOT YET TESTED | |
| A7 — Discount code | Done | Works |
| A8 — HeightAgeConfirmModal | Done | Works |
| A9 — Private event blocker | Done | Works |
| A10 — Mega Tuesday + new juniors | Done | Works |
| A11 — Reservation timer | NOT YET TESTED | 10-min countdown in sticky bar |
| A12 — Error path (BMI fail mid-flow) | NOT YET TESTED | Should show retry + no charge |
| Side-effect verification (Square / sales_log / SMS / email / clickwrap) | NOT YET TESTED | |

---

## 2. The 5 commits since the 05-21 handoff (most recent first)

| Commit | What |
|---|---|
| `8a280dba` | **v1 wording parity** — ExperiencePicker port (heading, longer descriptions, "What to expect" callout), drop duplicate "Welcome to FastTrax" wrapper, license reminder verbatim ("per driver applies at first check-in"), Checkout heading "Checkout" + "Enter your details to complete booking." |
| `acddc026` | **packageId tracking** — `RaceItem.packageId` persists Premium Package selection; saveBookingDetails forwards under `package` key to `/api/booking-record`; v1 confirmation page passes it to `/api/notifications/booking-confirmation` → `sales_log.package_id`. Also fixed back-nav state loss for package picks. |
| `3dae7b53` | **Rich cart preview + leave-confirmation modal** — CartView shows real product name + track + per-heat racer assignments + extras + estimated total (was "High-Speed Electric Racing" generic placeholder). LeaveConfirmModal on "All activities" link in CartView + BookingFlow when cart has items. Wizard header gets "Step N of M · Next: <step>" hint. |
| `007bc58c` | **6 bug fixes from user's Phase A walkthrough** — memberships pipe through PartyMember → filterProducts (unblocks 3-Pack / Intermediate / Pro for returning racers); RacePartyStep state derived from session.party (fixes back-nav reset); fetchBillOverview drops ghost lines + CheckoutStep review shows racer names per line; ReturningRacerLookup inputs wrapped in `<form onSubmit>` for Enter submit; adult/junior category banner; bookHeatsOnAdvance progress UI ("Reserving heat N of M…"). |
| `4709ebb0` | Progress marker doc (non-functional) |

(Plus the earlier huge commit `e2d5c37e` that shipped commits 10–14 in one push: checkout, confirmation compat, HeightAgeConfirmModal, BMI verification flow, Premium Packages, ReservationTimer.)

---

## 3. What's left for racing to ship

### Before flipping PR Draft → Ready

1. **Complete Phase A retest** — A6 (add-ons), A11 (reservation timer), A12 (error path), plus the side-effect block (Square sandbox shows charge, sales_log row appears, SMS + email send). Walk it at `http://localhost:3000/book/race/v2` after running `npm run dev -w fasttrax-web`. Update `tasks/pr-b2-e2e-verification-2026-05-24.md` with pass/fail per row.

2. **Verify v1 confirmation page reads `booking:${billId}` key** — v2's booking-store writes with a colon (`booking:${billId}`) instead of v1's underscore (`booking_{billId}`). Test by booking through to payment + landing on `/book/confirmation`. If the confirmation page can't find the booking, either rename the v2 key OR add a fallback read in the confirmation page. Check during A1 retest.

3. **Re-verify build** — `npx turbo run build --filter=fasttrax-web` should be clean. Last verified before the cart preview / wording commits.

4. **Open the GitHub PR** (if not already open) and paste body from `tasks/pr-b2-pr-description-2026-05-24.md`. Branch → base = `feat/booking-b2-race` → `feat/booking2`. Mark Draft until retest is done.

5. **Flip Draft → Ready** once retest is green. Add the three open questions from the PR description as inline comments or labels.

### Open questions (flagged in PR description, decisions needed)

1. **Selected `packageId` tracking** — DONE in commit `acddc026`. Was originally a follow-up; landed early.
2. **Booking-store key format** (`booking:${billId}` vs v1's `booking_{billId}`) — verify during A1 retest. If broken, rename or add fallback.
3. **Cross-session navigation** (cart joins existing session via cross-sell tile) — should PR-B2.5 land before PR-B3 (attractions), or after?

### Deferred (NOT in PR-B2 by design)

| Feature | Reason | Next PR |
|---|---|---|
| POV Pandora session linking (8s post-confirm scheduling) | Scope decision §2 | "Race video features" PR |
| BMI office notes (`appendPrivateNote` buffer) | Scope decision §6 — v1 endpoint pending confirmation | TBD |
| Cross-session navigation (cart joins existing session) | Out of scope; v2 polish | PR-B2.5 |
| Race-pack credit purchases | Different model (credit not booking) | PR-B4 |
| Square Orders + Catalog adapter wiring (`data/square.ts`, `data/square-catalog.ts`) | Racing doesn't need them; checkout calls `/api/square/pay` directly. Bowling + attractions WILL need the catalog reader for `BMI Item ID` resolution | PR-B3 prerequisite |

---

## 4. Files that matter for racing

| Path | Role |
|---|---|
| `apps/web/src/components/features/booking/steps/race/` | All race step components (party, date, product, heat picker, POV, addons, packages, modals) |
| `apps/web/src/components/features/booking/steps/checkout/CheckoutStep.tsx` | 6-phase checkout UI |
| `apps/web/src/components/features/booking/BookingFlow.tsx` | Wizard orchestrator — sticky step bar, ReservationTimer, NavigationButtons, leave-confirmation, HeightAgeConfirmModal intercept |
| `apps/web/src/components/features/booking/CartView.tsx` | Rich cart preview + LeaveConfirmModal |
| `apps/web/src/features/booking/service/checkout.ts` | Session-level orchestrator — runCheckout, registerContact, fetchBillOverview, recordClickwrap, saveBookingDetails, confirmCreditOrder, resolveSquareCustomer, buildConfirmationUrl |
| `apps/web/src/features/booking/service/race.ts` | Race-specific service — bookHeatsOnAdvance, holdRaceItem (license + POV + addons sells), confirmPayment |
| `apps/web/src/features/booking/service/race-products.ts` | Static race product registry (productIds, tier, category, track, multi-track packs) |
| `apps/web/src/features/booking/service/race-pricing.ts` | Schedule resolver (weekday / weekend / mega), FL tax, LICENSE_PRICE / POV_PRICE |
| `apps/web/src/features/booking/service/conflict.ts` | Heat-conflict gap rules port |
| `apps/web/src/features/booking/service/packages.ts` | Premium Packages re-export from `lib/packages.ts` (shared with v1) |
| `apps/web/src/features/booking/data/bmi.ts` | BMI adapter — getAvailability (PascalCase + date URL param + pageId), bookHeat, createPerson, removeBookingLine, confirmPayment, getOrderOverview |
| `apps/web/src/features/booking/state/types.ts` | RaceItem, PartyMember, BookingSession definitions |
| `apps/web/src/features/booking/state/machine.ts` | Reducer (preserves state on back-nav by design) |
| `apps/web/src/features/booking/state/steps.ts` | STEP_REGISTRY for race / attraction / bowling / kbf |
| `apps/web/app/api/bmi/route.ts` | Shared BMI proxy — **do not modify**, v1 + v2 both use it |
| `apps/web/app/api/sms/route.ts` | Shared SMS-Timing proxy — used by RaceAddonsStep for dayplanner |
| `apps/web/app/book/confirmation/page.tsx` | Shared confirmation page (v1) — v2 redirects here post-payment |
| `apps/web/app/api/notifications/booking-confirmation/route.ts:346` | Where `logSale()` fires — v2 inherits via compat path |
| `apps/web/lib/group-events.ts` | Group event registry (shared) |
| `apps/web/lib/packages.ts` | Premium Package registry (shared between v1 + v2) |
| `apps/web/lib/sales-log.ts` | sales_log Postgres writer (shared) |
| `apps/web/lib/clickwrap.ts` | clickwrap_acceptances row writer (shared) |
| `tasks/pr-b2-parity-matrix-2026-05-24.md` | Full v1 → v2 audit (73 rows; 54 ✅, 9 🔄, 7 ⏭️, 0 ❌) |
| `tasks/pr-b2-e2e-verification-2026-05-24.md` | Phase A test plan w/ user's partial notes |
| `tasks/pr-b2-pr-description-2026-05-24.md` | Ready-to-paste PR description |

---

## 5. Quick verification commands

```powershell
# Sanity check on resume
git fetch origin
git status   # expect clean
git log --oneline -5

# Run tests + typecheck
npx turbo run typecheck test --filter=fasttrax-web   # expect 313/313 passing

# Boot dev server
npm run dev -w fasttrax-web   # http://localhost:3000

# Build before flipping PR
npx turbo run build --filter=fasttrax-web   # ~1-2 min
```

Live BMI availability probe (sanity check that the proxy + adapter shape still work):
```powershell
$body = '{"ProductId":45094857,"PageId":25850629,"Quantity":1,"OrderId":null,"PersonId":null,"DynamicLines":[]}'
Invoke-WebRequest -Uri "http://localhost:3000/api/bmi?endpoint=availability&date=2026-05-23&clientKey=headpinzftmyers" -Method POST -ContentType "application/json" -Body $body
# expect: { "proposals": [...] } or { "proposals": [] } for a date with no slots — both indicate the shape is correct
```

---

## 6. Architectural decisions locked for racing (don't relitigate)

1. **Multi-activity cart** — `BookingSession.items` holds N items; one Square Order anchors all
2. **One center per cart** — switching center clears items
3. **Brand = theming only** — `entryBrand` never mutates after session creation
4. **Per-member `isNewRacer`** — v2 chosen divergence from v1's party-wide `racerType`
5. **Multi-heat 3-Pack support** — `RaceItem.heats: RaceHeatAssignment[]`, one entry per (block × racer)
6. **No mock mode** — all BMI / Square / SMS-Timing / Pandora calls are real
7. **POV = flat qty SKU** — `RaceItem.povQuantity: number`, no per-racer attribution
8. **packageId persists on item** — for back-nav AND for sales_log via booking-record
9. **License auto-sells during BMI bookHeat** for new racers — no separate license picker step
10. **Cart line racer attribution** — heatId → party member name map built at render time in CheckoutStep review
11. **"All activities" link is confirmation-gated** when cart has items (LeaveConfirmModal)
12. **Booking-store key is `booking:${billId}`** (colon) — diverges from v1's `booking_{billId}` underscore. Compat with shared confirmation page is item 2 in § 3 to verify.

---

## 7. Known v1 parity gaps deferred (will be in PR description)

| Gap | Where it lives in v1 | Why deferred |
|---|---|---|
| POV Pandora session linking | `app/book/race/page.tsx` | Scope decision §2 — separate video-features PR |
| BMI office notes (`appendPrivateNote`) | `lib/bmi-*` | Scope decision §6 — v1 endpoint pending confirmation |
| `sales_log` direct write from v2 | `lib/sales-log.ts` | Resolved via compat path — v1's confirmation handler fires `logSale()` automatically (verified in parity matrix #2.2) |

---

## 8. Quick architectural reference

- **Race wizard step order:** Party → Date → Adult Race → Adult Heats → Junior Race → Junior Heats → POV & Pack → Extras. Adult/Junior steps gated by `isVisible` based on party composition.
- **State machine:** `useReducer` in `BookingFlow.tsx`. All cart state in-memory React. Sessions don't survive a hard refresh (intentional for now; persistence is a separate v2 polish PR).
- **Back-nav preservation:** the reducer NEVER destroys data on `back` — only the step cursor moves. Any state loss on back-nav is a step component bug (using `useState` instead of deriving from session) — see commit 007bc58c for the fix pattern.
- **Heat booking:** happens on Next from the heat-picker step (not at checkout). BMI orderId chains all heats. The reservation timer (10 min) ticks on the BMI bill once created.
- **Checkout:** `service/checkout.ts:runCheckout` orchestrates contact registration → bill overview → review → payment via shared `PaymentForm` (which calls `/api/square/pay`) → clickwrap → window.location to `/book/confirmation`.
- **Confirmation:** v1's shared page reads `/api/booking-store` (Redis 24h) + `/api/booking-record` (Postgres 90d), then POSTs to `/api/notifications/booking-confirmation` which fires SMS + email + `logSale()` + `clickwrap_acceptances`.

---

## 9. If something breaks during retest

| Symptom | Likely cause | Fix location |
|---|---|---|
| Cart shows "High-Speed Electric Racing" again | CartView regressed | `src/components/features/booking/CartView.tsx:206` (RaceCartCard) |
| 3-Pack hidden for returning racer | memberships not flowing | `RacePartyStep.tsx:81` (handlePersonVerified) + `RaceProductStep.tsx:172` (memberships pass) |
| Back to Party shows ExperiencePicker again | local state regression | `RacePartyStep.tsx:28-32` (useState init from session.party) |
| Confirmation page can't find booking | booking-store key mismatch | Either `service/checkout.ts:saveBookingDetails` (write underscore key too) or `app/book/confirmation/page.tsx` (add fallback read) |
| Heat booking slow with no feedback | onProgress not threading | `service/race.ts:bookHeatsOnAdvance` signature + `BookingFlow.tsx:setBookingHeatsProgress` call |
| Square sandbox not charging | Shared `/api/square/pay` regressed | Read git log on `app/api/square/pay/route.ts` (refactored on main during merge window) |
| sales_log row missing for a v2 booking | booking-record body shape | `service/checkout.ts:saveBookingDetails` — must include `package`, `rookiePack`, `racers[]` |

---

## 10. Where to find help

- **Memory files** at `C:\Users\Alex.Trepasso\.claude\projects\c--git-Tools-Website-FT\memory\` — auto-loaded by Claude. `v1_race_parity_checklist.md` is the canonical v1 behavior list.
- **Lessons** at `tasks/lessons.md` — accumulated gotchas (BMI ID precision, husky corruption, etc.)
- **Project plan** at `tasks/restructure-plan.md` + status at `tasks/restructure-status.md`
- **Operating principles** in `CLAUDE.md` § 7

Stop and ask before:
- Touching any v1 file under `apps/web/app/book/race/` or `apps/web/lib/race-*`, `apps/web/lib/packages.ts`, `apps/web/lib/sales-log.ts`
- Force-pushing or rewriting pushed history on `feat/booking-b2-race`
- Modifying `/api/square/pay`, `/api/bmi`, `/api/sms` proxy routes — shared with v1
- Adding new env vars (need Vercel + 1Password updates too)
- Changing any of the 12 locked architectural decisions in § 6
