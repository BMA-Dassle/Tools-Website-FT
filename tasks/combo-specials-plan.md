# Combo Specials — display + full v2 online booking

## Context

**Problem / need.** The owner wants to sell **combo specials** — the first being **"2 Go-Kart Races + 1.5 Hours of Bowling — $65 weekday / $75 weekend, per person"** — and wants a *durable, repeatable system* for adding more combos in the future, not a one-off hard-coded card.

**What exists today (verified in source):**
- The attractions page ([apps/web/app/attractions/page.tsx](apps/web/app/attractions/page.tsx)) is hardcoded TSX. It already has a **placeholder** "Destination Combo Packages (Best Value)" hero CTA (lines 513–564) that just links to `/pricing` — no real combo content.
- `/pricing` ([apps/web/app/pricing/page.tsx](apps/web/app/pricing/page.tsx)) has a "FastTrax Combos" section, but it only sells **race add-ons** (+$10 gel blaster, etc.) — there is **no racing+bowling bundle**.
- Strong precedents for a declarative bundle registry already exist: [apps/web/lib/packages.ts](apps/web/lib/packages.ts) (Rookie Pack / Ultimate Qualifier — weekday/weekend/mega pricing, savings, displayOrder, disclaimers) and [apps/web/src/features/booking/service/membership-discounts.ts](apps/web/src/features/booking/service/membership-discounts.ts).
- The **v2 booking system** ([apps/web/src/features/booking/](apps/web/src/features/booking/)) is the mandated platform (full cutover in progress per [tasks/todo.md](tasks/todo.md)). Its session is a multi-activity cart: **ONE Square order, ONE BMI bill, ONE center per session**, mixing `RaceItem` (BMI), `BowlingItem` (QAMF), `AttractionItem` (BMI). `center` = physical complex (`fort-myers`/`naples`), `brand` = `fasttrax`/`headpinz`, so **one Fort Myers session can hold a FastTrax race AND HeadPinz bowling**.
- The todo's "D16 mixed-cart guard" (bowling+racing can't coexist) was **never implemented** — verified directly: the reducer `addItem` does not reject, `crossSellFor` only excludes same-kind, and [unified-reserve.ts](apps/web/src/features/booking/service/unified-reserve.ts) `buildCombinedLineItems` already merges race+bowling+attraction into one Square order.

**Decisions locked with the owner:**
1. **Full online booking in v2 now** — customer picks 2 heats + a 1.5h bowling slot and pays once.
2. **Day tiers:** Mon–Thu = $65, Fri–Sun = $75 (**per person**). **Tuesday/Mega = weekday ($65)**.
3. **Model flexibility:** fixed components **plus** optional "choose-one" option groups (e.g. "laser tag OR gel blaster") and other attractions.
4. **Surfaces:** attractions page (dedicated section), pricing page, home-page teaser.

**Intended outcome.** A declarative `combo-specials` registry that is the single source of truth for (a) the marketing cards on three surfaces and (b) the v2 booking flow + fixed combo pricing. Adding a future combo becomes a data change, not a UI/booking refactor. Racing is Fort Myers-only, so combos that include racing are a **Fort Myers-complex** offering.

---

## Step 0 — Dedicated branch (do this first)

Before any code: `git checkout -b feat/combo-specials`. All commits + the PR live here; `main` is untouched. (Repo rule: never bypass git hooks.)

---

## The durable model — `combo-specials` registry

Create a new feature folder per v2 conventions (`src/features/<name>/`):

**`apps/web/src/features/combos/combo-specials.ts`** — the source of truth, mirroring the declarative pattern of [lib/packages.ts](apps/web/lib/packages.ts) and [membership-discounts.ts](apps/web/src/features/booking/service/membership-discounts.ts).

```ts
type ComboComponent =
  | { kind: "race"; raceCount: number }                 // fixed: 2 heats/racer
  | { kind: "bowling"; durationMinutes: number }        // fixed: 90 min
  | { kind: "attraction"; slug: string }                // fixed extra
  | { kind: "choose-one"; label: string; options: ComboComponent[] }; // option group

interface ComboSpecial {
  id: string;                 // kebab slug, e.g. "race-bowl"
  name: string;               // "Race + Bowl Combo"
  shortDescription: string;
  longDescription: string;
  includes: string[];         // display bullets: ["2 Go-Kart Races", "1.5 Hours of Bowling"]
  heroImage: string;
  accentColor: string;
  center: CenterCode;         // "fort-myers" (racing is FM-only)
  /** Per-person price in CENTS. */
  price: { weekday: number; weekend: number }; // { weekday: 6500, weekend: 7500 }
  components: ComboComponent[];
  enabled: boolean;           // env-flag-aware (default ON unless explicitly "false")
  displayOrder?: number;
  /** Optional seasonal window — future combos (mirrors discount-codes). */
  availability?: { startsAt?: string; expiresAt?: string; allowedWeekdays?: number[] };
}
```

First entry:

```ts
{
  id: "race-bowl",
  name: "Race + Bowl Combo",
  includes: ["2 Go-Kart Races", "1.5 Hours of Bowling"],
  center: "fort-myers",
  price: { weekday: 6500, weekend: 7500 },
  components: [
    { kind: "race", raceCount: 2 },
    { kind: "bowling", durationMinutes: 90 },
  ],
  enabled: COMBO_RACE_BOWL_ENABLED, // NEXT_PUBLIC_COMBO_RACE_BOWL_ENABLED !== "false"
  displayOrder: 10,
}
```

Helpers (pure, unit-tested):
- `getComboSpecial(id)`, `enabledCombos()`
- `comboPriceCentsForDate(combo, dateYmd)` → reuses `scheduleForDate` ([race-pricing.ts](apps/web/src/features/booking/service/race-pricing.ts) / [packages.ts](apps/web/lib/packages.ts) line 831): `weekend` → `price.weekend`; `weekday` **and `mega`** → `price.weekday`.
- `comboTotalCents(combo, dateYmd, headcount)` = `comboPriceCentsForDate × headcount`.

---

## Display layer (cards on three surfaces)

1. **`apps/web/src/components/features/combos/ComboSpecialCard.tsx`** — mobile-first card matching the existing attractions-card markup (dashed accent border, image `height: clamp(150px,25vw,200px)`, includes list, weekday/weekend price, "Book This Combo" CTA). **Reuse the exact card structure** from [attractions/page.tsx](apps/web/app/attractions/page.tsx) lines 282–350 so the visual stays consistent. No Shadcn — hand-rolled only.
2. **`ComboSpecials.tsx`** section — renders `enabledCombos().map(ComboSpecialCard)` in `grid-cols-1 sm:grid-cols-2 lg:grid-cols-3`.
3. Wire into the three surfaces:
   - **Attractions** — replace the placeholder "Destination Combo Packages" hero (lines 513–564 of [attractions/page.tsx](apps/web/app/attractions/page.tsx)) with `<ComboSpecials>` (keep the "Best Value" heading + the existing `group-events-bg` backdrop treatment).
   - **Pricing** — insert `<ComboSpecials>` into the existing "FastTrax Combos" section (lines 664–812 of [pricing/page.tsx](apps/web/app/pricing/page.tsx)).
   - **Home teaser** — a compact teaser section near [components/home/Attractions.tsx](apps/web/components/home/Attractions.tsx) linking to `/attractions#combos`.
4. **CTA** → deep-links into v2: `/book/combo/[id]/v2` (see booking layer). Use the existing [BookingLink](apps/web/components/BookingLink.tsx) wrapper for analytics + internal/external routing.
5. **No middleware change needed** — we are *not* adding a new top-level shared route (cards live on existing pages + a `/book/...` route). If a standalone `/combos` page is ever added later, it must be added to `SHARED_TOP_LEVEL_ROUTES` in the same commit (HeadPinz 404 rule).

---

## Booking layer (full v2 online booking)

A combo books as a **normal v2 session pre-seeded with both items**, with a **fixed-price override** at checkout. No new `SessionItem` kind, no new step kind — the existing per-kind `STEP_REGISTRY` ([state/steps.ts](apps/web/src/features/booking/state/steps.ts)) runs race steps → bowling steps → shared checkout automatically.

1. **Entry route** — `apps/web/app/book/combo/[id]/v2/page.tsx` (thin server shell): resolve the `ComboSpecial`, create a fresh session (`center: "fort-myers"`, entryBrand from host), stamp **`session.comboId = id`** (add optional `comboId?: string` to `BookingSession` in [state/types.ts](apps/web/src/features/booking/state/types.ts) — captured once like `appliedPromo`), and seed:
   - one **RaceItem** — heats target `raceCount: 2`; customer picks date + racers + heats (capacity is really reserved). Reuse the existing combo/pack heat-picker plumbing (`packType: "combo"` in [race-products.ts](apps/web/src/features/booking/service/race-products.ts)).
   - one **BowlingItem** — `durationMinutes: 90` preset; customer picks the lane time. Steps fixed by the combo can be auto-set with `isVisible:false` (polish).
2. **Pricing override — the core.** New **`apps/web/src/features/combos/combo-pricing.ts`** with `comboChargeLines(session)` — the **single source of truth**, called identically at:
   - **display** — inside `buildZeroModelOverview` ([checkout.ts](apps/web/src/features/booking/service/checkout.ts) ~line 868), and
   - **charge** — inside `buildCombinedLineItems` ([unified-reserve.ts](apps/web/src/features/booking/service/unified-reserve.ts) ~line 125, which already calls `buildRaceChargeLines` at line 188 for parity).

   When `session.comboId` is set **and the gate passes** (exactly the combo's components present: 2 heats/racer + 1.5h bowling), emit **ONE combo line per racer-discount-group** — `"Race + Bowl Combo" × N @ $65/$75` — and **suppress the separate race + bowling charge lines**. Price from `comboPriceCentsForDate(combo, raceItem.date)`, **per person × `distinctRacerCount`**. Membership discounts applied per racer by reusing the existing `splitByDiscount` / `racingDiscountFor` pattern (full-price line + discounted line carrying `membershipDiscountPct`).
   - **Invariants preserved:** BMI heats stay **$0** (never put dollars on the BMI bill); the bowling **QAMF reservation is still created + confirmed** but its line items are **not separately charged** in combo mode (the combo line is the whole charge). Square applies the 6.5% tax on the combo line.
3. **All-or-nothing** — reuse the existing `unifiedReserve` deposit-as-commitment + NX lock + idempotency. The combo line is part of the one Square order; QAMF + BMI confirmations fan out after the deposit. No new rollback logic.
4. **Confirmation** — [app/book/confirmation/v2/page.tsx](apps/web/app/book/confirmation/v2/page.tsx) already renders race + bowling details; add a "You booked the Race + Bowl Combo!" banner keyed off `comboId`, and persist `comboId` to the booking record.
5. **Feature flag + cutover safety** — `NEXT_PUBLIC_COMBO_RACE_BOWL_ENABLED` gates the combo (display + booking). Net-new flow (no v1 to replace), but canary with staff/test customers before public enable; the display↔charge parity unit test is a merge gate.

---

## Risks / guardrails (bake in — from CLAUDE.md + verified probe)

- **display == charge parity:** `comboChargeLines` MUST be called identically (same session, same date parse, same discount map) in both `buildZeroModelOverview` and `buildCombinedLineItems`. Unit-test byte-identical output.
- **$0 BMI invariant:** the combo line lives only on Square; BMI heats remain $0 (`raceUsesZeroBmiModel`). A combo line that leaks BMI dollars = double charge.
- **Gate strictness:** apply the combo price ONLY when exactly the combo's components are present (2 heats/racer + 1.5h bowling). Anything else falls back to item-sum pricing. Test the downgrade edge cases (1 race, or 1h bowling).
- **BMI id precision:** reuse the existing precision-safe `bookRaceHeat` (raw-string orderId/personId injection) — never `Number()`/`JSON.parse` BMI ids.
- **Membership discounts:** highest-% only, no stacking (existing behavior).
- **Center:** Fort Myers only (racing FM-only). Do not offer/seed the combo at Naples.
- **Mega Tuesday:** combo is allowed and priced as **weekday ($65)** (map `scheduleForDate → mega` to the weekday tier).
- **QAMF reservation persistence:** confirm ops day-of workflows handle a Neon bowling reservation that exists while Square shows only the combo line (no separate bowling line).
- **Never guess CSS:** inspect the real attractions-card DOM before building `ComboSpecialCard` (reuse existing markup).

---

## Verification (prove it works end-to-end)

**Unit tests** (`combo-specials.test.ts`, `combo-pricing.test.ts`):
- `comboPriceCentsForDate`: Mon–Thu → 6500, Fri–Sun → 7500, **Tue/mega → 6500**.
- `comboChargeLines`: display output === charge output (byte-identical) for: no-discount; one racer with Employee Pass 50%; mixed party (one discounted, one not).
- Gate strictness: returns null (→ item-sum fallback) for 1 race or 1h bowling.

**Local end-to-end** (Square sandbox + BMI + QAMF staging — the "seed + one real smoke before done" rule):
- Open `/book/combo/race-bowl/v2`, complete 2 heats (2 racers) + 1.5h bowling.
- Assert: review shows **$65pp weekday / $75pp weekend**; the deposit/charge total matches the review exactly; BMI heats are $0; a QAMF reservation is created; confirmation shows the combo banner; booking record has `comboId`.

**Display layer** (run the app, inspect real DOM — mobile viewport, since 75% of traffic is mobile):
- Combo cards render correctly on `/attractions`, `/pricing`, and the home teaser; cards stack to 1 column on mobile; "Book This Combo" routes to `/book/combo/race-bowl/v2`.

**Suggested PR slicing** (one purpose each, on `feat/combo-specials`):
1. Registry + helpers + unit tests (`combo-specials.ts`).
2. Display layer (`ComboSpecialCard` + `ComboSpecials` + wire into 3 surfaces).
3. Booking layer (entry route + `session.comboId` + `combo-pricing.ts` + checkout/reserve hooks + confirmation banner) behind the feature flag, with the parity test as a merge gate.
