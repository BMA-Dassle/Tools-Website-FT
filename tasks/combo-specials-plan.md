# Combo Specials — display + full v2 online booking

> **STATUS (2026-06-10): ALL slices (1–6, incl. Revision 2 guided itinerary) IMPLEMENTED on `feat/combo-specials`.** Owner sign-off received ("Build it"; juniors blocked on Mega confirmed). Registry-generic per owner: future combos are data changes (ordered `ComboLeg[]` + `transitionMinutes`).
> tsc clean · 490 unit tests green (31 new combos tests + 3 settlement-guard tests) · `next build` + a11y gate pass.
> **NOT yet done:** the live e2e smoke (Square sandbox + BMI + QAMF — blocked on the bowling-v2 smoke gate per §Verification), mobile DOM inspection of the three card surfaces, and the staff canary.
> ⚠️ **Before merging to main: set `NEXT_PUBLIC_COMBO_RACE_BOWL_ENABLED=false` in Vercel prod** — the flag defaults ON, so an unset var ships the combo live (display + booking) on deploy.

## Context

**Problem / need.** The owner wants to sell **combo specials** — the first being **"2 Go-Kart Races + 1.5 Hours of Bowling — $65 weekday / $75 weekend, per person"** — and wants a *durable, repeatable system* for adding more combos in the future, not a one-off hard-coded card.

**What exists today (verified in source):**
- The attractions page ([apps/web/app/attractions/page.tsx](apps/web/app/attractions/page.tsx)) is hardcoded TSX. It already has a **placeholder** "Destination Combo Packages (Best Value)" hero CTA (lines 513–564) that just links to `/pricing` — no real combo content.
- `/pricing` ([apps/web/app/pricing/page.tsx](apps/web/app/pricing/page.tsx)) has a "FastTrax Combos" section, but it only sells **race add-ons** (+$10 gel blaster, etc.) — there is **no racing+bowling bundle**.
- Strong precedents for a declarative bundle registry already exist: [apps/web/lib/packages.ts](apps/web/lib/packages.ts) (Rookie Pack / Ultimate Qualifier — weekday/weekend/mega pricing, savings, displayOrder, disclaimers) and [apps/web/src/features/booking/service/membership-discounts.ts](apps/web/src/features/booking/service/membership-discounts.ts).
- The **v2 booking system** ([apps/web/src/features/booking/](apps/web/src/features/booking/)) is the mandated platform (full cutover in progress per [tasks/todo.md](tasks/todo.md)). Its session is a multi-activity cart: **ONE Square order, ONE BMI bill, ONE center per session**, mixing `RaceItem` (BMI), `BowlingItem` (QAMF), `AttractionItem` (BMI). `center` = physical complex (`fort-myers`/`naples`), `brand` = `fasttrax`/`headpinz`, so **one Fort Myers session can hold a FastTrax race AND HeadPinz bowling**.
- The todo's "D16 mixed-cart guard" (bowling+racing can't coexist) was **never implemented** — verified directly (re-verified 2026-06-10): the reducer `addItem` does not reject ([machine.test.ts:62](apps/web/src/features/booking/state/machine.test.ts) asserts "addItem allows mixed carts"), `crossSellFor` only excludes same-kind, and [unified-reserve.ts](apps/web/src/features/booking/service/unified-reserve.ts) `buildCombinedLineItems` already merges race+bowling+attraction into one Square order. `tasks/todo.md`'s D16 entry has been corrected to match — do NOT re-add a guard; combos require mixed carts.
- **2026-06-07 charge-rail refactor (post-dates this plan's first draft):** combos (3-packs) + packages now ride the $0 zero-BMI model too, and ONE shared `raceItemChargeLines` ([checkout.ts:683](apps/web/src/features/booking/service/checkout.ts#L683)) feeds the credit path, the cash path, AND the cart — so the display==charge parity seam this plan hooks into already exists as a single function. Current hook points: `buildZeroModelOverview` at [checkout.ts:868](apps/web/src/features/booking/service/checkout.ts#L868); `buildCombinedLineItems` at [unified-reserve.ts:140](apps/web/src/features/booking/service/unified-reserve.ts#L140), which calls `buildRaceChargeLines` at line 203.
- **Terminology landmine:** in this codebase **"combo" already means the 3-pack race SKUs** (`packType: "combo"`, combo Blue-twins, pack-total pricing). This feature is "combo **specials**" — use `comboSpecialId` (session field, route param, helpers) everywhere in code, never bare `comboId`, to keep the two systems unconfusable.

**Decisions locked with the owner:**
1. **Full online booking in v2 now** — customer picks 2 heats + a 1.5h bowling slot and pays once.
2. **Day tiers:** Mon–Thu = $65, Fri–Sun = $75 (**per person**). **Tuesday/Mega = weekday ($65)**.
3. **Model flexibility:** fixed components **plus** optional "choose-one" option groups (e.g. "laser tag OR gel blaster") and other attractions.
4. **Surfaces:** attractions page (dedicated section), pricing page, home-page teaser.
5. ~~**Race scope (locked 2026-06-10): ANY race tier/track qualifies, Mega included.**~~ **SUPERSEDED by Revision 2 (owner, 2026-06-10 evening):** the combo is a **guided itinerary — Starter race → 1.5h Bowling → Intermediate race, in that order**. The customer picks ONE start time (the Starter heat); the system auto-schedules the bowling slot and the Intermediate heat around it. See § Revision 2 below.
6. **Day-of settlement ownership (locked 2026-06-10): lane-open owns the combo's day-of order.** The race day-of cron must SKIP any day-of order that a bowling/KBF reservation shares (same `NOT EXISTS` guard the attraction query already has). Accepted consequence: a customer who races but skips bowling leaves the order unsettled — it falls to the Square-settled auto-close cron / manual settle.
7. **Deposit (locked 2026-06-10): 100% upfront.** The combo line charges the full $65/$75 per person at booking; day-of "settlement" is only the gift-card → day-of-order money movement, no balance collected at the desk.

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

1. **Entry route** — `apps/web/app/book/combo/[id]/v2/page.tsx` (thin server shell): resolve the `ComboSpecial`, create a fresh session (`center: "fort-myers"`, entryBrand from host), stamp **`session.comboSpecialId = id`** (add optional `comboSpecialId?: string` to `BookingSession` in [state/types.ts](apps/web/src/features/booking/state/types.ts) — captured once like `appliedPromo`; NOT `comboId`, which would collide with the 3-pack "combo" vocabulary), and seed:
   - one **RaceItem** — heats target **2 per racer**, enforced in the heat step when `comboSpecialId` is set. Customer picks **any tier/track (Mega included — locked decision #5)** plus date + racers + heats via the NORMAL single-race steps (capacity is really reserved); heats book as ordinary **zero-model build products**. Do **NOT** reuse `packType: "combo"` — that is the 3-pack SKU plumbing (pack-total charge lines, 3-heat assumptions) and does not fit a 2-heat bundle priced by the combo override.
   - one **BowlingItem** — `durationMinutes: 90` preset; customer picks the lane time. Steps fixed by the combo can be auto-set with `isVisible:false` (polish).
2. **Pricing override — the core.** New **`apps/web/src/features/combos/combo-pricing.ts`** with `comboChargeLines(session)` — the **single source of truth**, called identically at:
   - **display** — inside `buildZeroModelOverview` ([checkout.ts:868](apps/web/src/features/booking/service/checkout.ts#L868)), and
   - **charge** — inside `buildCombinedLineItems` ([unified-reserve.ts:140](apps/web/src/features/booking/service/unified-reserve.ts#L140), which already calls `buildRaceChargeLines` at line 203 for parity — the post-2026-06-07 shared `raceItemChargeLines` rail).

   When `session.comboSpecialId` is set **and the gate passes** (exactly the combo's components present: 2 heats/racer — any tier/track — + 1.5h bowling), emit **ONE combo line per racer-discount-group** — `"Race + Bowl Combo" × N @ $65/$75` — and **suppress the separate race charge lines AND the bowling item's `lineItems`** (the combo line is the whole charge). Price from `comboPriceCentsForDate(combo, raceItem.date)`, **per person × `distinctRacerCount`**. Membership discounts applied per racer by reusing the existing `splitByDiscount` / `racingDiscountFor` pattern (full-price line + discounted line carrying `membershipDiscountPct`).
   - **Invariants preserved:** BMI heats stay **$0** (never put dollars on the BMI bill); the bowling **QAMF reservation is still created + confirmed** but its line items are **not separately charged** in combo mode. Square applies the 6.5% tax on the combo line. The combo line carries **`depositPct: 100`** (locked decision #7) — full price charged at booking.
3. **All-or-nothing** — reuse the existing `unifiedReserve` deposit-as-commitment + NX lock + idempotency. The combo line is part of the one Square order; QAMF + BMI confirmations fan out after the deposit. No new rollback logic.
4. **Day-of settlement guard (required code change — locked decision #6).** A combo's day-of order carries race+bowling value in one line, and today TWO settlement flows would fight over it: [getRaceReservationsAwaitingDayofPay](apps/web/lib/bowling-db.ts#L983) has **no** bowling-on-same-order exclusion, while the attraction query directly below it ([bowling-db.ts:1019](apps/web/lib/bowling-db.ts#L1019)) does. Fix: add the same `NOT EXISTS (SELECT 1 … WHERE b.square_dayof_order_id = r.square_dayof_order_id AND b.product_kind IN ('open','kbf'))` guard to the **race** query, so the race day-of cron skips combo orders and **lane-open settles them** (preserves the "never auto-settle bowling past-start" rule). Accepted consequence: race-only no-shows (raced, skipped bowling) leave the order for the Square-settled auto-close cron / manual settle. Unit-test the guard.
5. **Confirmation** — [app/book/confirmation/v2/page.tsx](apps/web/app/book/confirmation/v2/page.tsx) already renders race + bowling details; add a "You booked the Race + Bowl Combo!" banner keyed off `comboSpecialId`, and persist `comboSpecialId` to the booking record.
6. **Feature flag + cutover safety** — `NEXT_PUBLIC_COMBO_RACE_BOWL_ENABLED` gates the combo (display + booking). Net-new flow (no v1 to replace), but canary with staff/test customers before public enable; the display↔charge parity unit test is a merge gate.
   - **Sequencing prerequisite:** bowling/KBF v2 must pass its **QAMF staging + Square sandbox smoke test** ([todo.md](todo.md) PR-B5 merge gate) **before** the combo canary. The combo is the **first production mixed cart** — race+bowling through `unifiedReserve` in one Square order has never run live.

---

## Revision 2 (2026-06-10): Guided itinerary — Starter → Bowl → Intermediate

**Owner direction (supersedes the generic flow shipped in slice 4):** the combo gets its
OWN guided steps instead of the generic race wizard + bowling wizard. The customer's
visit is a fixed sequence — **Starter race (first event) → 1.5h bowling → Intermediate
race** — and the customer only picks their **start time**; we schedule the rest.
Screenshot evidence of the problem: the generic flow let a customer pick two arbitrary
Starter heats hours apart and configure bowling independently, and even showed package
upsells (Rookie Pack / Ultimate Qualifier) mid-combo.

### What changes vs. slice 4 (what stays)

**Stays (the money backbone is unchanged):** flat $65/$75pp pricing, the
`comboChargeLines` single seam in `buildRaceChargeLines`, bowling line-item suppression,
100% upfront deposit, no credit stacking, the settlement guard, the marketing cards, the
`/book/combo/[id]/v2` entry, `session.comboSpecialId`.

**Changes:**

1. **Registry model — ordered itinerary with tiers.** `ComboComponent` race entries gain
   a `tier`; components are ORDERED and a `transitionMinutes` buffer (default **15** —
   walk time between buildings) separates them:
   ```ts
   components: [
     { kind: "race", tier: "starter", raceCount: 1 },
     { kind: "bowling", durationMinutes: 90 },
     { kind: "race", tier: "intermediate", raceCount: 1 },
   ],
   transitionMinutes: 15,
   ```
2. **Combo step flow (its own wizard).** When `session.comboSpecialId` is set the race
   item runs a COMBO step list — Party → Contact → Date → **Start Time** →
   **Itinerary Review** — and the bowling item's steps are hidden (`isVisible: false`
   when the session is a combo); the bowling item is configured programmatically.
   - **No product picker step** → no Rookie Pack / Ultimate Qualifier upsell can appear
     mid-combo (the owner's "why offer Ultimate during the combo" complaint). POV
     upsell stays (legit add-on, charged on top).
   - **Start Time step:** shows ONLY Starter heats from which a FULL chain is feasible —
     for each candidate Starter heat, there must exist a 90-min QAMF lane slot starting
     ≥ starter-end + 15min, and an Intermediate heat starting ≥ bowling-end + 15min,
     with party-size capacity on both heats. (Same pre-gating pattern as PackageCard's
     Ultimate availability gate.) Infeasible starters render disabled with a reason.
   - **Itinerary Review step:** shows the assembled schedule — Starter @T0 → Bowling
     @T1 → Intermediate @T2 — books the BMI heats + creates the QAMF hold eagerly
     (existing `holdPickedHeats` + bowling hold service + ReservationTimer), then
     continues to the shared checkout. "Change" affordances (pick a different feasible
     bowling slot / intermediate heat) are polish, not v1 — v1 auto-picks the EARLIEST
     feasible chain.
3. **Reuse, don't reinvent:** the Starter→Intermediate same-day pairing is exactly the
   Ultimate Qualifier precedent (`PackageHeatPicker` gap pairing + capacity gating +
   late-night fallback); bowling 90-min availability comes from the hourly probe
   (`kind=open,hourly` — the weekend time-bowling fix already on this branch); QAMF hold
   + line-item enrichment extract from `BowlingOfferStep` into a service function so the
   combo flow can configure the bowling item without rendering bowling steps.
4. **Pricing gate update** (`activeComboSpecial`): per racer exactly ONE Starter heat +
   ONE Intermediate heat (matching the registry tiers, in order), bowling 90-min booked
   between them. The slice-4 "exactly 2 heats any tier" rule and the heat-picker
   exact-count guard are replaced by the combo steps.
5. **Cart: the combo is removable as a unit.** A "Remove combo" action on the cart
   clears `comboSpecialId` AND removes BOTH seeded items (releasing the BMI lines +
   QAMF hold via the existing release paths). Removing either seeded item individually
   does the same (a half-combo cart silently falling back to item-sum pricing is a
   pricing surprise, not a feature).
6. **Licensing:** Starter is the qualifier; the same-day Intermediate follows the
   Ultimate Qualifier precedent. New racers still get the $4.99 license line on top.

### Edge notes
- **Mega Tuesday:** adult Starter Mega exists; there is NO junior Starter Mega product —
  feasibility gating self-resolves this (a junior party on Tuesday simply finds no
  feasible chains → date reads unavailable), but the date step should say why.
- **Already-qualified racers** (existing Intermediate/Pro license): still run the fixed
  Starter-first itinerary — owner's call ("I'd like them to do a starter race, first
  event"), applies to everyone.
- **Defaults assumed (veto if wrong):** 15-min transition buffer; auto-pick = earliest
  feasible chain; juniors allowed (junior Starter + Intermediate products exist on
  non-Tuesday days).

### Verification (Revision 2 additions)
- Unit: chain-feasibility helper (starter×bowling×intermediate matching incl. buffers,
  no-bowling-slot and late-night-no-intermediate cases); updated gate tests
  (starter+intermediate per racer; 2 starters → fallback).
- E2e: pick a start time → assert the assembled itinerary's times are ordered with
  buffers, both heats + QAMF hold exist, review shows $65/$75pp, combo removable from
  cart (holds released).

### PR slicing (continues from slice 4)
5. Registry itinerary model + chain-feasibility service + gate update (unit-tested).
6. Combo wizard steps (Start Time + Itinerary Review, bowling steps hidden, bowling
   item programmatic config) + cart remove-combo + package-upsell suppression.

---

## Risks / guardrails (bake in — from CLAUDE.md + verified probe)

- **display == charge parity:** `comboChargeLines` MUST be called identically (same session, same date parse, same discount map) in both `buildZeroModelOverview` and `buildCombinedLineItems`. Unit-test byte-identical output.
- **$0 BMI invariant:** the combo line lives only on Square; BMI heats remain $0 (`raceUsesZeroBmiModel`). A combo line that leaks BMI dollars = double charge.
- **Gate strictness:** apply the combo price ONLY when exactly the combo's components are present. Slice 4 shipped this as "2 heats/racer + 1.5h bowling, any tier"; **Revision 2 tightens it** to one Starter + one Intermediate per racer with the 90-min bowling between. Anything else falls back to item-sum pricing. Test the downgrade edge cases.
- **Settlement ownership:** the race day-of cron MUST skip orders that bowling shares (decision #6 / booking-layer step 4). Shipping the combo WITHOUT the `NOT EXISTS` guard means the race cron auto-settles the bowling portion at race start — violating the "never auto-settle bowling past-start" rule (fires food to the kitchen for no-shows) and racing lane-open to the same order.
- **BMI id precision:** reuse the existing precision-safe `bookRaceHeat` (raw-string orderId/personId injection) — never `Number()`/`JSON.parse` BMI ids.
- **Membership discounts:** highest-% only, no stacking (existing behavior).
- **Center:** Fort Myers only (racing FM-only). Do not offer/seed the combo at Naples.
- **Mega Tuesday:** combo is allowed and priced as **weekday ($65)** (map `scheduleForDate → mega` to the weekday tier). Mega/Pro heats on Fri–Sun price at the weekend tier ($75) like everything else — the flat price is deliberate (decision #5).
- **QAMF reservation persistence:** confirm ops day-of workflows handle a Neon bowling reservation that exists while Square shows only the combo line (no separate bowling line). Lane-open settles the combo order (decision #6).
- **Naming:** `comboSpecialId` everywhere — never `comboId` / `packType: "combo"`, which belong to the 3-pack system.
- **Never guess CSS:** inspect the real attractions-card DOM before building `ComboSpecialCard` (reuse existing markup).

---

## Verification (prove it works end-to-end)

**Unit tests** (`combo-specials.test.ts`, `combo-pricing.test.ts`):
- `comboPriceCentsForDate`: Mon–Thu → 6500, Fri–Sun → 7500, **Tue/mega → 6500**.
- `comboChargeLines`: display output === charge output (byte-identical) for: no-discount; one racer with Employee Pass 50%; mixed party (one discounted, one not).
- Gate strictness: returns null (→ item-sum fallback) for 1 race, 3 races, or 1h bowling.
- Settlement guard: `getRaceReservationsAwaitingDayofPay` excludes a race row whose `square_dayof_order_id` is shared by an `open`/`kbf` row; still includes race-only rows.

**Local end-to-end** (Square sandbox + BMI + QAMF staging — the "seed + one real smoke before done" rule). **Precondition: bowling v2's own QAMF+Square smoke test has passed** (todo.md PR-B5 merge gate) — this e2e is the first-ever mixed race+bowling cart through `unifiedReserve`:
- Open `/book/combo/race-bowl/v2`, complete 2 heats (2 racers) + 1.5h bowling.
- Assert: review shows **$65pp weekday / $75pp weekend**; the charge total matches the review exactly (100% upfront, decision #7); BMI heats are $0; a QAMF reservation is created; confirmation shows the combo banner; booking record has `comboSpecialId`; the race day-of cron's candidate query does NOT pick up the combo's order (lane-open owns it).

**Display layer** (run the app, inspect real DOM — mobile viewport, since 75% of traffic is mobile):
- Combo cards render correctly on `/attractions`, `/pricing`, and the home teaser; cards stack to 1 column on mobile; "Book This Combo" routes to `/book/combo/race-bowl/v2`.

**Suggested PR slicing** (one purpose each, on `feat/combo-specials`):
1. Registry + helpers + unit tests (`combo-specials.ts`).
2. Display layer (`ComboSpecialCard` + `ComboSpecials` + wire into 3 surfaces).
3. Day-of settlement guard (`NOT EXISTS` bowling exclusion on the race day-of query + unit test) — small, independently shippable, and a hard prerequisite for slice 4.
4. Booking layer (entry route + `session.comboSpecialId` + `combo-pricing.ts` + checkout/reserve hooks + confirmation banner) behind the feature flag, with the parity test as a merge gate. Public enable additionally gated on the bowling-v2 smoke test having passed.
