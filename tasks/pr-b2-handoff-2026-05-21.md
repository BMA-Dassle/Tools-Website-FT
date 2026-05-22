# PR-B2 Handoff — 2026-05-21 (rev 3)

**Status:** Race wizard step parade is complete + reverted to strict v1 visual parity. Branch is on `feat/booking-b2-race`. **Not ready for review yet** — checkout (commit 10) and confirmation (commit 11) are the remaining major chunks.

**Resume here in a fresh session.** This file is self-contained — read it top to bottom before touching code. Then read `CLAUDE.md` § 7 (Operating Principles) and the memory files at `C:\Users\Alex.Trepasso\.claude\projects\c--git-Tools-Website-FT\memory\`. Two prior handoffs (`tasks/restructure-status.md`, `C:\Users\Alex.Trepasso\.claude\plans\we-are-going-to-polymorphic-hejlsberg.md`) have older context — the older "commit plan" sections in them are superseded by what's below.

---

## TL;DR

- `feat/booking-b2-race` is 75+ commits ahead of `origin/main`.
- Race wizard is 9 steps: **Party → Date → Adult Race → Adult Heats → Junior Race → Junior Heats → POV & Pack → Extras** (Contact + Pay + Confirmation are cart/session-level, not per-item — they land in commits 10 + 11).
- All 9 race steps render real BMI / SMS-Timing dayplanner data. No mock mode.
- Typecheck clean. 313/313 vitest cases pass.
- **NOT YET COMMITTED:** strict v1 visual parity reverts (5 files). Diff is on disk, typecheck clean. Commit message is queued in § "Final pre-handoff commit" below — first action of new session is to commit this.

---

## Branch state

```
feat/booking-b2-race  (HEAD: see git log)
└─ uncommitted on disk: 5 files of strict-v1 parity reverts
    apps/web/src/components/features/booking/steps/race/RacePovStep.tsx       (full rewrite — povRacerIds → povQuantity + qty stepper)
    apps/web/src/components/features/booking/steps/race/RaceHeatPickerStep.tsx (full rewrite — drop TRACK_BADGE/TRACK_CARD/NEUTRAL/DISABLED, ProgressDots, "Heats Selected" pane, "M heats each" summary; add v1's start→stop time render)
    apps/web/src/components/features/booking/steps/race/RaceProductStep.tsx   (edits — titles match v1, drop multi-track hint, drop category interpolation in description)
    apps/web/src/components/features/booking/steps/race/RaceAddonsStep.tsx    (edit — inline SlotPicker per v1)
    apps/web/src/features/booking/state/types.ts                              (edit — povRacerIds: string[] → povQuantity: number)

Last 7 pushed commits (oldest → newest):
  d784457a PR-B2 9b polish: drop isNewRacer checkbox + back-to-landing link + remove wrong-domain redirect
  4ada9ba9 PR-B2 commit 9b 2a/7: race v1-parity step order + per-racer modal
  4e269530 PR-B2 commit 9b 2b/7: RaceDateStep v1 warnings + operating principles
  ace031f1 PR-B2 commit 9b 2c/7: RaceProductStep v1 parity -- TrackPickerModal, tier descs
  7dbc8736 PR-B2 commit 9b 2d/7: RaceHeatPickerStep v1 warnings
  498f9f73 PR-B2 commit 9b 3/7: RacePovStep -- POV upsell + Rookie Pack chooser
  8e984622 PR-B2 commit 9b 4/7: RaceAddonsStep -- v1 AddOnsPage port
```

---

## Final pre-handoff commit (run this FIRST in new session)

```bash
git add apps/web/src/components/features/booking/steps/race/RacePovStep.tsx \
        apps/web/src/components/features/booking/steps/race/RaceHeatPickerStep.tsx \
        apps/web/src/components/features/booking/steps/race/RaceProductStep.tsx \
        apps/web/src/components/features/booking/steps/race/RaceAddonsStep.tsx \
        apps/web/src/features/booking/state/types.ts \
        tasks/pr-b2-handoff-2026-05-21.md

git commit -m "$(cat <<'EOF'
PR-B2 commit 9b 5/7: strict v1 visual parity reverts

Five files reverted to mirror v1 verbatim where v2 had drifted:

state/types.ts:
- RaceItem.povRacerIds (string[]) -> povQuantity (number); BMI POV is a flat qty SKU, no per-racer attribution

RacePovStep:
- existing-racer flow now uses v1's qty stepper (Add for all N button -> -/+ adjuster) instead of per-racer checkbox list
- drop bottom 'Rookie Pack applied to N first-timers' footer summary

RaceHeatPickerStep:
- drop TRACK_BADGE / TRACK_CARD / NEUTRAL_CARD / DISABLED_CARD constants -- v1 uses uniform white/10 cards
- drop ProgressDots component
- drop 'Heats Selected' green pane (picked state is visible from card highlighting)
- summary line now 'Booking for N racer(s)' verbatim; drop 'M heats each' addition
- add v1's start arrow stop time render (-> formatTime(block.stop))

RaceProductStep:
- titles match v1 verbatim: 'Pick Your Starter Race' / 'Choose Your Race' (drop junior-specific variants)
- drop 'Choose Red or Blue track ->' pre-selection hint on multi-track cards
- drop ${category}s interpolation in description -- v1 says 'racers'

RaceAddonsStep:
- inline SlotPicker into per-card render (v1 AddOnsPage:470-597 pattern); drop separate SlotPicker function

tasks/pr-b2-handoff-2026-05-21.md:
- new handoff document for next-session continuation

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

After commit, verify with: `npx turbo run typecheck test --filter=fasttrax-web` — expect typecheck clean + 313/313 tests green.

---

## Race wizard step inventory (post-reverts)

| Step | File | What it does | Real APIs |
|---|---|---|---|
| Party | `RacePartyStep.tsx` | per-member roster — name, category (adult/junior), isNewRacer per member. No first-time checkbox (system-decided). Footer note for returning-racer flow coming later. | n/a |
| Date | `RaceDateStep.tsx` | per-month BMI availability fetch (Mega + Mon-Thu Starter Red + Fri-Sun Starter Red); group event blocker; Mega Tuesday + new juniors banner; legend with Private Event amber chip; "no available dates" message | `/api/bmi?endpoint=availability` (GET range) |
| Adult Race | `RaceProductStep.tsx` (Adult variant) | tier-grouped picker; tier descriptions; TrackPickerModal for multi-track packs (Red + Blue with track images) | n/a (static registry) |
| Adult Heats | `RaceHeatPickerStep.tsx` (Adult variant) | grid of heats with status pills; capacity bar; conflict gating via `service/conflict.ts`; 75-min lead time for new racers; locked-track filter from product step's modal pick; per-racer RacerSelectorModal when any returning racer in scope; private event guard | `/api/bmi?endpoint=availability` (POST PascalCase) |
| Junior Race | `RaceProductStep.tsx` (Junior variant) | same as Adult, filtered to category=junior + isVisible-gated | n/a |
| Junior Heats | `RaceHeatPickerStep.tsx` (Junior variant) | same as Adult, filtered to junior product | `/api/bmi?endpoint=availability` |
| POV & Pack | `RacePovStep.tsx` | when `NEXT_PUBLIC_ROOKIE_PACK_ENABLED=1` AND party has new racers: Rookie Pack vs License-only radio. Otherwise: v1's qty stepper (Add for all N → -/+). POV video preview. | n/a (BMI sells at checkout) |
| Extras | `RaceAddonsStep.tsx` | 4 add-ons (Shuffly, Duckpin, Gel Blaster, Laser Tag); per-card SMS dayplanner probe at 2-hour jumps; race-heat conflict (30 min buffer); cross-addon conflict (0 same-building / 30 cross-building) | `/api/sms?endpoint=dayplanner/dayplanner` |

---

## Architecture / state model (LOCKED — do not relitigate)

These are baked in. If you think one is wrong, ASK Alex before touching.

1. **Multi-activity cart.** One `BookingSession.items: SessionItem[]`. Race + bowling + attraction on one Square Order = one transaction.
2. **One center per cart.** `session.center` locks when first item picks it. Changing center clears items.
3. **Brand = theming only.** `session.entryBrand` captured once at session creation, never mutates. Cart can mix FT + HP at Fort Myers (Shuffly resolves Red/Blue side via entryBrand).
4. **No `/book/v2` chooser route in race entry path.** Entry is always activity-specific (`/book/race/v2`). `/book/v2` is now the promo landing page (commit 8.5).
5. **Square = source of truth for finance.** Cart IS the Square Order. BMI/Conq/KBF reservations are non-financial (priced at $0); Square holds the money.
6. **Square custom attributes drive vendor mapping** (`BMI Item ID`, `Booking Activity`, etc.). v1 `PRODUCT_ATTRACTION_MAP` is the BMI fallback. No Neon mapping table.
7. **Race-pack DEFERRED to PR-B4** as credit-purchase, NOT a booking. `Activity` enum is `race | attraction | bowling | kbf` only.
8. **`EntryContext`** is the extension shell (member, promo, prefilledContact, partyMembers, referrer). PR-B2 consumes `prefilledContact` only.
9. **3-pack day-of multi-heat races ship in PR-B2** (`RaceItem.heats: RaceHeatAssignment[]`, BMI orderId chains heats).
10. **No mock mode.** BMI / Square / Pandora / KBF adapters always hit live endpoints. Existing mock impls (`mockBmiAdapter` etc.) stay as inactive code for vitest, but normal dev = real APIs.
11. **POV is a flat qty SKU** (BMI productId `43746981`). `RaceItem.povQuantity: number`, NOT per-racer attribution. (Just reverted from `povRacerIds: string[]` to match v1.)
12. **Per-member `isNewRacer`** in v2 (party roster has per-member flag) is the one chosen divergence from v1's party-wide `racerType` — user-confirmed.

---

## RaceItem state shape (current, post-reverts)

```ts
export interface RaceItem extends BookingItemBase {
  kind: "race";
  date: string | null;                          // YYYY-MM-DD

  // Product picks — productIdAdult/Junior = parent BMI id, productTrack* = chosen track from TrackPickerModal
  productIdAdult: string | null;
  productIdJunior: string | null;
  productTrackAdult: string | null;             // "Red" | "Blue" | null
  productTrackJunior: string | null;

  // Heats: one entry per (block × racer). HeatPickerStep adds to this array
  heats: RaceHeatAssignment[];                  // { productId, track, heatId, bmiLineId, assignedTo }

  // POV
  povQuantity: number;                          // count of cameras (BMI sells qty, no per-racer)
  rookiePack: boolean | null;                   // true=pack, false=opted out, null=not asked

  // Add-ons
  addons: Array<{
    id: string;                                  // BMI productId
    qty: number;
    selectedTime: string | null;                 // ISO start
    bmiLineId: string | null;                    // set after BMI booking/sell (checkout writes this)
  }>;
}
```

`PartyMember`:
```ts
{
  id: string;
  firstName: string;
  lastName?: string;
  bmiPersonId?: string;            // populated by BMI verification flow (deferred follow-up PR)
  isNewRacer: boolean;             // drives Starter-only filter + license fee
  category?: "adult" | "junior";   // drives product eligibility
  isBillingCustomer?: boolean;
}
```

`BookingSession`:
```ts
{
  squareOrderId: string | null;     // lazy — created at checkout
  bmiBillId: string | null;         // lazy — created on first BMI line
  entryBrand: Brand;                // captured once
  center: CenterCode | null;        // locks when items[] non-empty
  contact: Partial<ContactInfo>;    // billing customer
  context: EntryContext;            // prefilled data
  appliedPromo: AppliedPromo | null;// captured at /book/v2 landing or ?code= seed
  party: PartyMember[];             // roster
  kbfIdentity?: KbfIdentityState;   // present only when KbfItem in items[]
  items: SessionItem[];             // cart
  activeItemId: string | null;      // null = cart view, non-null = in sub-wizard
  cursors: Record<string, number>;  // per-item step cursor
}
```

---

## Remaining work (in order)

### Commit 10 — checkout

One commit. Bundles Square adapter wiring + Square Order anchor + BMI bookHeat + auto-license + POV/addon sells + discount apply + clickwrap row.

Files to create / modify:

- **`apps/web/src/features/booking/data/square.ts`** — wire `squareAdapter.createOrder`, `getOrder`, `cancelOrder` real impls (Square Orders REST API). Currently throws "lands in commit 10".
- **`apps/web/src/features/booking/data/square-catalog.ts`** — wire `squareCatalogAdapter.findByBmiItemId`, `findByBookingActivity`, `getById` real impls (Square Catalog API). Currently throws "lands in commit 10".
- **`apps/web/src/features/booking/service/checkout.ts`** — orchestrator. Sequence:
  1. Create or fetch Square Order (`squareAdapter.createOrder`)
  2. Create BMI bill if not yet (lazy — `session.bmiBillId`); for each `item.heats[]` entry call `bmiAdapter.bookHeat` with `assignedTo`'s `bmiPersonId` (or create new person for first-time racers via `bmiAdapter.createPerson`)
  3. Auto-sell license for each new racer: BMI `booking/sell` against productId `43473520` (license SKU — verify against v1 `race/page.tsx:1070`)
  4. Sell POV: BMI `booking/sell` against productId `43746981` with `quantity = item.povQuantity`
  5. Sell each add-on entry with qty > 0 + selectedTime: BMI `booking/sell` against entry's productId
  6. Apply `session.appliedPromo` to matching Square Order lines (race domain only — bowling/kbf cross-promo not in PR-B2)
  7. Square payment via existing `/api/square/pay` route (DO NOT fork it; internal-fetch from `data/square.ts`)
  8. On payment success: write `clickwrap_acceptances` row via `lib/clickwrap.ts` (unchanged)
- **`apps/web/src/components/features/booking/steps/checkout/CheckoutStep.tsx`** — Contact + Pay step at session level (CartView opens it when customer clicks "Checkout"). Square Web Payments SDK form. Mirror v1's `/book/checkout/page.tsx`.
- **`apps/web/src/components/features/booking/CartView.tsx`** — wire the Checkout button (currently disabled) to launch the checkout step.

**Critical:** `/api/square/pay` was refactored on main during the merge window (added 238 lines for multi-tender / GC). Race v2 calls it WITHOUT `giftCardNonce`. Read `apps/web/app/api/square/pay/route.ts` BEFORE writing the orchestrator.

**No sales_log write.** ON HOLD — ask Alex before merge.

**No marketing opt-in.** Deferred to a follow-up PR. Race v1 doesn't enroll either.

### Commit 11 — confirmation

One commit.

- **`apps/web/app/book/race/v2/confirmation/page.tsx`** — server component, reads `?orderId=` from URL.
- **`apps/web/src/components/features/booking/ConfirmationView.tsx`** — client island.
- **`apps/web/src/features/booking/service/confirm.ts`** — SMS / email send + express-lane lookup.

Features (port from v1 `/book/confirmation/page.tsx`):
- QR code per racer
- Heat schedule grouped by time + track
- Reservation number
- Express-lane bypass for verified returning racers (Pandora waiver lookup)
- Rookie Pack appetizer code (`RACEAPP` for first-timers @ Nemo's) — display-only
- Discount applied line above tax
- SMS confirmation via existing `lib/sms-*.ts` (Voxtelesys primary, Twilio failover)
- Email confirmation via existing SendGrid integration

### Post-commit-11

1. v1 parity audit — walk `v1_race_parity_checklist.md` row-by-row.
2. Decide sales_log HOLD with Alex.
3. Flip Draft → Ready for Review.

---

## v1 parity divergences (forced vs unforced)

**Forced (v2 architecture, cannot mirror v1):**

| Divergence | Why |
|---|---|
| `RaceProductStepAdult/Junior` + `RaceHeatPickerStepAdult/Junior` split | v2 wizard runs ONE StepDef at a time. v1's single-component-with-bookingCategory-cycling becomes 2 visibility-gated steps. |
| No inline "Continue" CTA buttons inside step bodies | v2's BookingFlow owns Next in the wizard footer. v1's per-step inline CTAs are duplicate UI. |
| Click-to-toggle heat picks | v2 supports multi-heat (3-Pack day-of) in ONE picker step; v1 uses separate PackHeatPicker. |
| `bookedHeats` derived from `item.heats` dedup-by-heatId | v2 stores per-racer-per-heat assignments; v1 has a flat `bookings` array. |
| Per-member `isNewRacer` | v2 user-confirmed divergence — party roster carries per-member state, not party-wide `racerType`. |
| Heat duration approximated to 30 min in RaceAddonsStep | v2's RaceHeatAssignment stores heatId (block.start) but not block.stop. 30 min is wider than any real heat (Red 12 / Blue 15 / Mega 24) so addon conflict detection errs safe. |

**Deferred (gaps from strict v1 parity — flag at PR review):**

| Gap | Where it lives in v1 | Why deferred |
|---|---|---|
| Premium Packages | `apps/web/lib/packages.ts` + `PackageHeatPicker`, `PackHeatPicker` | Substantial port (packages registry + live BMI pricing); separate commit |
| "Showing tier and below" qualification banner on Product step | v1 `page.tsx:2147-2164` | Depends on per-racer BMI verification data (verifiedRacers[].category memberships) which doesn't exist in v2 until BMI verification flow ships (separate follow-up PR) |
| HeightAgeConfirmModal (party → date transition) | v1 `page.tsx:2370-2456` | Party-step concern, not heat-picker. Hasn't been ported yet. |
| BMI verification flow for returning racers (lookup → 6-digit → assign personId) | v1 `RacerSelector.tsx` + `page.tsx:1214-1232` | Sizeable. Lives in a follow-up PR; `bmiPersonId` on PartyMember is the integration point. |
| POV video purchase + Pandora session linking | v1 `page.tsx` | Deferred to a "video features" PR |
| BMI office notes (`appendPrivateNote`) | v1 `lib/bmi-*` | Skipped in PR-B2 |

---

## Key files index

| Path | Role |
|---|---|
| `apps/web/src/features/booking/data/bmi.ts` | BMI adapter — `getAvailability` (POST PascalCase + date URL param + pageId), `bookHeat`, `createPerson`, `removeBookingLine`, `confirmPayment`, `getOrderOverview`. PascalCase + numeric IDs (`Number(productId)`). Date as URL query, body as PascalCase. Matches v1's shape. |
| `apps/web/src/features/booking/data/square.ts` | Square Orders adapter — `createOrder/getOrder/cancelOrder` throw "lands in commit 10". |
| `apps/web/src/features/booking/data/square-catalog.ts` | Square Catalog adapter — `findByBmiItemId` etc. throw "lands in commit 10". |
| `apps/web/src/features/booking/state/types.ts` | Session + RaceItem + PartyMember definitions. **Post-revert state shape is documented above.** |
| `apps/web/src/features/booking/state/machine.ts` | Reducer for `BookingSession`. |
| `apps/web/src/features/booking/state/steps.ts` | `STEP_REGISTRY` per item kind. Race step list is final. |
| `apps/web/src/features/booking/service/race-products.ts` | Static race-products registry (productId + pageId + trackProducts map). |
| `apps/web/src/features/booking/service/race-pricing.ts` | Schedule resolution + `LICENSE_PRICE`. |
| `apps/web/src/features/booking/service/conflict.ts` | Heat conflict gap rules (Red 13 / Blue 16 / Mega 13 / cross-track 30). |
| `apps/web/src/components/features/booking/BookingFlow.tsx` | Wizard runtime — step indicator, Back/Next footer, CartView swap. |
| `apps/web/src/components/features/booking/CartView.tsx` | Cart view — items list + AdditionalActivities cross-sell + Checkout button (currently disabled). |
| `apps/web/app/api/bmi/route.ts` | Shared BMI proxy — pure pass-through. **Do not modify.** v1 + v2 both call it. |
| `apps/web/app/api/sms/route.ts` | Shared SMS-Timing proxy — used by RaceAddonsStep for dayplanner. **Do not modify.** |
| `apps/web/app/api/square/pay/route.ts` | Square payment route (added multi-tender on main during merge — read before writing checkout). |
| `apps/web/lib/group-events.ts` | Group event registry. RaceDateStep + RaceHeatPickerStep import `getGroupEventForDate` directly (shared utility, not v1-specific). |
| `apps/web/lib/clickwrap.ts` | Waiver acceptance row writer — reuse unchanged in commit 10. |
| `apps/web/lib/sms-*.ts` | SMS confirmation infra — reuse unchanged in commit 11. |
| v1 race files at `apps/web/app/book/race/` | **Read these in full before touching the corresponding v2 step.** v1 is the source of truth for visual + behavioral parity. |

---

## Test plan (v2 race wizard end-to-end)

After committing the strict-parity reverts, walk `/book/race/v2` at `http://localhost:3000` (run `npm run dev -w fasttrax-web` first):

1. **Party** — add 1 adult + 1 junior, both flagged new. No first-time checkbox (system-decided).
2. **Date** — calendar shows BMI-available days only. Legend has Private Event amber chip. Pick a Tuesday → "Heads up — Mega Tuesday" banner + Next disabled. Pick non-Tuesday weekday.
3. **Adult Race** — title "Pick Your Starter Race". Description "All first-time racers start here…". Pick Intermediate Weekday 3-Pack → TrackPickerModal opens with Blue + Red. Pick Blue.
4. **Adult Heats** — uniform white/10 cards (no track theming). Time format: start + arrow + stop time per cell. Heat name + status pill + capacity bar. First few heats greyed (75-min lead time). Click heat → RacerSelectorModal opens (because at least one returning racer in scope after BMI verification ships; today modal opens unconditionally since no racer has bmiPersonId set, so modal won't open).
5. **Junior Race** — same title "Pick Your Starter Race" (verbatim match to adult).
6. **Junior Heats** — same uniform layout.
7. **POV & Pack** — if `NEXT_PUBLIC_ROOKIE_PACK_ENABLED=1` in `.env.local`: Rookie Pack chooser appears. Otherwise: "Add for all 2 racers — $10.00" big button → click → -/+ stepper with "2 cameras" label + "Set to all 2 racers" helper.
8. **Extras** — 4 add-on cards. Click "Add for all 2 racers" on Gel Blaster → slot list loads (real BMI dayplanner). Race heat 🏎️ pills interleaved as non-clickable markers. Pick a slot. Add Shuffly (FT) → same-building back-to-back slots remain pickable.

If anything visually diverges from v1 (compare to `http://localhost:3000/book/race`), it's drift — file an issue + add to "deferred gaps" section above.

---

## Operating principles (locked, in `CLAUDE.md` § 7)

Every session inherits these:

1. **Read before you propose.** Full file reads, not grep snippets, before any structural recommendation. If you skim, say so + list what you didn't verify.
2. **State your grounding before you propose.** Brief list of what you've confirmed vs. inferred.
3. **The task is done when the deliverable is done.** No "for now / pause later / iterate tomorrow" exits. Name specific blockers or keep working.
4. **Banned exit phrases:** "for now," "as a starting point," "we can iterate tomorrow," "let's leave it here," "we can refine later," "this is a good place to pause."
5. **Operate like the highest-standards collaborator.** Default to more thorough, not less.
6. **Push back honestly** on bad framing / scope / half-baked asks.
7. **Use the context window.** Long reads, multi-step reasoning expected.

---

## Open questions for Alex

Flag these in the PR description when ready-for-review:

1. **`sales_log` writes from v2** — ON HOLD. Decide before merge: v2 dual-writes to `sales_log` + Square metadata, or sales board pivots to Square Search Orders first.
2. **Premium Packages** — port now (extends PR-B2 scope ~1 day of work) or follow-up PR?
3. **HeightAgeConfirmModal** — drop into RacePartyStep transition or follow-up?
4. **Returning-racer BMI verification flow** — confirmed follow-up PR, but blocks the "Showing tier and below" qualification banner from working in v2.
5. **Cross-session navigation** (clicking cross-sell tile joins same cart) — flag as PR-B2.5.

---

## Memory files relevant to this work (auto-loaded)

Index lives at `C:\Users\Alex.Trepasso\.claude\projects\c--git-Tools-Website-FT\memory\MEMORY.md`. Read these:

- `feedback_operating_principles.md` — the 7 rules above (mirror of CLAUDE.md § 7)
- `feedback_v2_parity_with_v1.md` — every v1 feature must exist in v2
- `feedback_v1_strict_parity_attraction_flow.md` — read v1 source before building
- `feedback_v2_styling_parity.md` — match v1 styling; structural rewrite not visual redesign
- `feedback_verify_dont_assume.md` — don't claim work works without proving it
- `feedback_lean_commit_messages.md` — terse subject + bullets, not essays
- `feedback_no_mock_mode.md` — real API calls only
- `v1_race_parity_checklist.md` — comprehensive v1 race behavior checklist
- `booking_v2_architecture.md` — multi-activity cart rules
- `booking_v2_promo_integration.md` — discount-codes integration

---

## Final note

The race wizard is **visually faithful to v1** after the 5-file revert commit. If something doesn't look like v1 after that commit lands, it's a real bug — file it. Don't add "improvements" to the wizard during commits 10 + 11; only touch step components if checkout/confirmation needs new data from them.
