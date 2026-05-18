# PR-B2 Handoff Document — Booking v2 Rewrite

**Audience:** A coworker (experienced Claude Code user) picking up booking v2 work for ~2 days while Alex is out.
**Goal:** Get as far as possible. Minimum: ship PR-B2 (race v2) to ready-for-review. Stretch: start PR-B3 (attractions) or beyond.
**Author:** Alex Trepasso + Claude (handoff written 2026-05-17).

---

## TL;DR (read this first)

We are halfway through rewriting the FastTrax/HeadPinz booking experience into a unified v2 flow under `apps/web/src/features/booking/`. The new flow supports a **multi-activity cart** anchored by a single Square Order — one transaction can hold a race heat + a bowling lane + a gel-blaster slot.

- **Branch you'll be working on:** `feat/booking-b2-race` (pushed to origin, 5 commits in)
- **Branch it merges into:** `feat/booking2` (the umbrella PR-B2 branch)
- **Then onward to:** `main` (after all of PR-B2 is approved)
- **Where you stop:** when commits 6–11 are pushed and the PR is ready-for-review on GitHub
- **What's done:** all the activity-agnostic plumbing (state machine, EntryContext, activities catalog, cart view, cross-sell)
- **What's left:** the race-specific work (BMI adapter, race step components, Square anchor + payment, confirmation page)

If you only read one other section, read **§ The PR-B2 commit plan (commits 6–11)** below.

---

## 1. Environment setup (first ~30 min)

The repo is cloned. You need env vars + deps.

### 1a. Get env vars from 1Password

The vault is **"FastTrax Dev"** (1Password). Copy its contents into `apps/web/.env.local`. If anything is missing, Vercel has the full live env (`vercel env pull` from a logged-in CLI works too).

Critical vars (don't proceed without these):
- `DATABASE_URL` — Neon shared dev DB
- `KV_REST_API_URL` + `KV_REST_API_TOKEN` — Upstash Redis (shared dev)
- `SQUARE_ACCESS_TOKEN`, `SQUARE_LOCATION_ID_FT`, `SQUARE_LOCATION_ID_HP`, `SQUARE_LOCATION_ID_NAPLES` — Square sandbox
- `BMI_API_BASE`, `BMI_CLIENT_KEY_FASTTRAX`, `BMI_CLIENT_KEY_HEADPINZ`, `BMI_CLIENT_KEY_NAPLES`
- `PANDORA_API_BASE`, `PANDORA_API_TOKEN`
- `NEXT_PUBLIC_SQUARE_APPLICATION_ID`, `NEXT_PUBLIC_SQUARE_LOCATION_ID_*`

For PR-B2 you'll mostly hit Square sandbox + BMI. Pandora is needed for the express-lane check on the confirmation page (commit 11).

### 1b. Install + boot

```powershell
# from repo root c:\git\Tools-Website-FT
npm install
npm run dev -w fasttrax-web
# → http://localhost:3000
```

Brand switching is via query param or cookie (middleware reads them in dev):
- `http://localhost:3000?brand=fasttrax` (sets the cookie + redirects to clean URL)
- `http://localhost:3000?brand=headpinz`

Per-activity entry URLs:
- `http://localhost:3000/book/race/v2`
- `http://localhost:3000/book/bowling/v2`
- `http://localhost:3000/book/kbf/v2`
- `http://localhost:3000/book/gel-blaster/v2`

### 1c. Sanity check before coding

```powershell
git checkout feat/booking-b2-race
git pull
npx turbo run typecheck test --filter=fasttrax-web
# expect: 22 vitest cases pass, typecheck clean
```

If those don't pass, **stop and ask** — something has drifted.

---

## 2. Where this work stands

### Branch state

```
main
  └─ feat/booking2  ← umbrella PR-B2 branch (merges to main when fully done)
       └─ feat/booking-b2-race  ← YOUR working branch
```

`feat/booking-b2-race` has 5 commits pushed to origin:

| Commit | What it does |
|---|---|
| `2e72a54` | Drop `/book/v2` chooser route + capture deferred-work notes |
| `0aef943` | Refactor state to multi-item `BookingSession` + drop race-pack from `Activity` |
| `74f9a3a` | Parse `EntryContext` from URL params + wire pages (9 tests) |
| `1b81f53` | Activities catalog (per-center matrix + shuffly entry-brand resolution, 13 tests) |
| `e7a188a` | Session-level `CartView` + `AdditionalActivities` cross-sell |

**Test count:** 22 vitest cases pass. **Typecheck:** clean.

### Draft PR

A draft PR has been pre-staged but not yet opened on GitHub. Open it via:

**https://github.com/BMA-Dassle/Tools-Website-FT/pull/new/feat/booking-b2-race**

- **Base:** `feat/booking2`
- **Title:** `PR-B2: race v2 (BMI adapter, multi-heat, Square payment, confirmation)`
- **Mark as Draft** — keep it draft until commits 6–11 are pushed AND v1 race parity is verified.
- **Body:** paste the PR body from the chat transcript with Alex (or use the test plan in § 11 below as a starting point).

### What's NOT done

- The race wizard renders breadcrumb + placeholder steps but cannot complete a booking. No real BMI calls. No Square payment. No confirmation page. No SMS. No email.
- Cross-session navigation: clicking a cross-sell tile spawns a fresh session at the target URL — session-sharing across navigation is a follow-up (probably PR-B2.5 or later) once the Square Order id is the cross-tab anchor.

---

## 3. Critical reading (in this order, before writing code)

These are the source of truth for this work. **Read them in order**; don't skip.

1. **[CLAUDE.md](c:/git/Tools-Website-FT/CLAUDE.md)** — Project-wide hard rules. The "Project-specific hard rules" section is non-negotiable.
2. **[tasks/restructure-status.md](c:/git/Tools-Website-FT/tasks/restructure-status.md)** — Current phase + which PRs have landed.
3. **[tasks/restructure-plan.md](c:/git/Tools-Website-FT/tasks/restructure-plan.md)** — Full restructure plan (you mostly need § Phase 2).
4. **[tasks/lessons.md](c:/git/Tools-Website-FT/tasks/lessons.md)** — Accumulated lessons. Pay special attention to:
   - **BMI ID Precision** (use `@ft/db.stringifyWithRawIds`, never `JSON.stringify` on BMI IDs)
   - **pnpm → npm** decision history
   - **Husky core.hooksPath corruption** fix on Windows
5. **Memory files** at `C:\Users\<you>\.claude\projects\c--git-Tools-Website-FT\memory\`. Read all of them — these encode every architectural decision already made:
   - `MEMORY.md` (index)
   - `booking_v2_architecture.md` — multi-activity cart, per-center constraint, brand-as-theming, `entryBrand`
   - `booking_v2_entry_context.md` — typed extension shell
   - `booking_v2_square_attributes.md` — `BMI Item ID`, `Booking Activity`, `Pack Slug` schema
   - `booking_v1_catalog_reference.md` — where v1's per-activity matrix lives
   - `feedback_v2_parity_with_v1.md` — **every v1 feature must exist in v2 unless explicitly replaced**
   - `v1_race_parity_checklist.md` — every v1 race behavior + the 6 scope decisions Alex resolved before stepping away
6. **[tasks/future/race-pack-as-credit-purchase.md](c:/git/Tools-Website-FT/tasks/future/race-pack-as-credit-purchase.md)** — why race-pack is NOT in PR-B2 (it's PR-B4 as a credit-purchase, not a booking).
7. **[apps/web/CLAUDE.md](c:/git/Tools-Website-FT/apps/web/CLAUDE.md)** — Next.js 16 warning ("this is NOT the Next.js you know"). Heed it.

**Recommended Claude opener** for the first session:

> I'm continuing PR-B2 booking v2 work on branch `feat/booking-b2-race`. Read all memory files at `C:\Users\<me>\.claude\projects\c--git-Tools-Website-FT\memory\`, read `CLAUDE.md`, `tasks/restructure-status.md`, and `tasks/lessons.md`. Then summarize the plan back to me and what commit 6 needs to do.

That bootstraps Claude with the full context in ~3 file reads.

---

## 4. Architectural decisions LOCKED — do NOT relitigate

These are in project memory and several have already shipped in code. Do NOT relitigate them with Claude or the user without explicit cause. If you think one is wrong, ask Alex first.

1. **Multi-activity cart**. One Square Order = N booking items. `BookingSession.items: SessionItem[]`. NOT one-activity-per-cart.
2. **One center per cart.** `BookingSession.center` is locked when first item picks it. Changing center clears the cart.
3. **Brand = entry theming.** `BookingSession.entryBrand` is captured once at session creation, never mutates. Cart can mix FT + HP activities at the same physical complex (Fort Myers hosts both).
4. **Shuffly resolves via entryBrand.** Two physically different shuffly venues at Fort Myers (FT-side + HP-side). The catalog resolves which Square item / which BMI product set by reading `session.entryBrand`.
5. **No `/book/v2` chooser page.** Entry is always activity-specific. Cross-activity discovery lives in `AdditionalActivities` cross-sell tiles in the cart.
6. **Square is source of truth for everything financial.** Cart IS the Square Order. BMI/Conq/KBF reservations are non-financial (priced at $0); Square holds the money.
7. **Square custom attributes drive vendor mapping.** Reuse `BMI Item ID` (already in Square from the membership flow). Add new attrs: `Booking Activity` (enum), `Pack Slug` (race-packs only, PR-B4), `Conq Item ID` (PR-B5), `KBF Pass Type` (PR-B6). No Neon mapping table.
8. **v1 `PRODUCT_ATTRACTION_MAP` is the BMI fallback** until Square attributes are backfilled. Adapter reads attrs first, falls back to v1 hardcode when missing.
9. **Race-pack is DEFERRED to PR-B4** as a credit-pack purchase, NOT a booking. `Activity` enum is `race | attraction | bowling | kbf` only.
10. **`EntryContext`** is the extension point for prefilled data (member, promo, prefilledContact, partyMembers, referrer). PR-B2 ships the shell + URL-param parser; only `prefilledContact` is consumed today. Don't delete the dormant fields.
11. **Activity catalog (`activities-catalog.ts`)** is the source of truth for "what's offered where." A runtime config layer (Neon table + admin UI) is captured in `tasks/future/activity-config-layer.md` and intentionally deferred.
12. **3-pack day-of multi-heat races** SHIP in PR-B2 (RaceItem will hold `heats: Array<...>`, BMI orderId chains heats). Race-pack credits are different and live in PR-B4.

### PR-B2 scope decisions (resolved 2026-05-16)

From `v1_race_parity_checklist.md`:

| Decision | Status |
|---|---|
| 3-pack day-of multi-heat | ✅ ship in PR-B2 |
| POV video purchase + Pandora session linking | ⏭️ defer to a "video features" PR |
| Express-lane bypass on confirmation | ✅ ship in PR-B2 |
| Rookie Pack appetizer code | ✅ ship in PR-B2 |
| License upsell ($30–$40 per first-timer) | ✅ ship in PR-B2 (Square catalog line item) |
| `sales_log` writes from v2 | ⏸️ HOLD — revisit with Alex before merge |
| BMI office notes (`appendPrivateNote`) | ⏭️ skip in PR-B2 |

---

## 5. The PR-B2 commit plan (commits 6–11)

Six commits remain. Each is its own atomic unit — push commits incrementally to the same `feat/booking-b2-race` branch.

### Commit 6 — BMI adapter (Square attribute reader + v1 fallback)

**Files to create:**
- `apps/web/src/features/booking/data/bmi.ts` — BMI client
- `apps/web/src/features/booking/data/bmi.test.ts` — unit tests
- `apps/web/src/features/booking/data/__fixtures__/bmi.ts` — mock fixtures for `isMockMode("bmi")`

**Behavior:**
- Wraps BMI's HTTP endpoints (see v1 `app/book/race/data.ts` for reference):
  - `getAvailability(date, productId, track?)` → dayplanner heat slots
  - `createPerson({ firstName, lastName, email, phone })` → BMI personId (raw text)
  - `bookHeat({ orderId, productId, heatId, partySize, personId })` → `{ orderId, billLineId }` — chains heats by reusing `orderId`
  - `removeHeat(orderId, billLineId)` → undo without cancelling whole order
  - `confirmPayment(orderId)` → `{ reservationNumber, reservationCode }`
  - `getOrderOverview(orderId)` → pre-conversion summary
- Uses `@ft/db.stringifyWithRawIds` for ALL BMI payloads. **Never `JSON.stringify` on BMI IDs.**
- Mock mode: `isMockMode("bmi")` returns realistic fixture data so the wizard works without BMI credentials locally.
- BMI client key resolution: read brand + center → pick the right `BMI_CLIENT_KEY_*` env var.

**Critical reference files:**
- `apps/web/app/book/race/data.ts` — canonical raw-ID injection pattern (port carefully)
- `apps/web/lib/attractions-data.ts` — `PRODUCT_ATTRACTION_MAP` is the v1 fallback
- `packages/db/src/raw-ids.ts` — `stringifyWithRawIds` helper

**Verification:**
- `npx turbo run typecheck test --filter=fasttrax-web` — new tests cover raw-ID handling, mock-mode toggling, response parsing.
- Manual: with `LOCAL_BMI_MOCK=1` in `.env.local`, hit `/book/race/v2` and confirm the wizard can pretend to fetch availability.

---

### Commit 7 — Service modules (Square catalog reader, heat-conflict, race pricing)

**Files to create:**
- `apps/web/src/features/booking/data/square-catalog.ts` — reads Square catalog API, joins on `Booking Activity` + `BMI Item ID` custom attributes
- `apps/web/src/features/booking/service/conflict.ts` — port of `apps/web/lib/heat-conflict.ts`
- `apps/web/src/features/booking/service/race-pricing.ts` — port relevant bits of `apps/web/lib/packages.ts` (race products, tier filtering, per-track variants)
- `apps/web/src/features/booking/service/race-products.ts` — static race product registry (v1 keeps this in code, NOT in BMI — privacy-optimized)
- Tests for each.

**Behavior:**
- `square-catalog.ts`:
  - Calls Square Catalog API search by `Booking Activity` attribute value.
  - Reads `BMI Item ID` (variation-level, comma-separated supported).
  - Falls back to v1 `PRODUCT_ATTRACTION_MAP` when the Square attr is missing.
  - Cached via React Query (factory key from `bookingKeys`).
- `conflict.ts`: port the gap rules verbatim (same-track ≥13min Red/Mega, ≥16min Blue, cross-track ≥30min walk buffer). Pure function — easy to unit test.
- `race-pricing.ts`: race tier (Starter / Intermediate / Pro), per-track variants (Red / Blue / Mega), weekday/weekend/Tuesday-Mega schedule selection.
- `race-products.ts`: static registry of FT race products (matches v1 `lib/packages.ts` shape).

**Verification:**
- Heat-conflict tests should cover all the gap-rule edge cases v1 enforces.
- `race-pricing` tests should cover tier filtering by party size, per-track variant resolution, schedule day-of-week dispatch.

---

### Commit 8 — `RaceItem` state expansion + reducer actions

**Files to modify:**
- `apps/web/src/features/booking/state/types.ts` — expand `RaceItem` to hold `heats[]`, `isNewRacer`, `smsOptIn`, `licenseFeeApplied`
- `apps/web/src/features/booking/state/machine.ts` — add reducer actions for `addHeat`, `removeHeat`, `setRaceField`
- Tests at `apps/web/src/features/booking/state/machine.test.ts`

**Shape change:**
```ts
export interface RaceItem extends BookingItemBase {
  kind: "race";
  personId: string | null;
  partySize: number | null;
  isNewRacer: boolean;
  smsOptIn: boolean;
  licenseFeeApplied: boolean;
  /** Multiple heats chained on one BMI orderId. */
  heats: Array<{
    date: string | null;
    productId: string | null;
    track: "red" | "blue" | "mega" | null;
    heatId: string | null;
    bmiLineId: string | null;
  }>;
}
```

**Behavior:**
- Single-heat race bookings have `heats.length === 1`.
- 3-pack day-of products have `heats.length === 3`.
- Heat-conflict validation runs on the whole `heats[]` when `>1`.

---

### Commit 9 — Race step components

**Files to create under `apps/web/src/components/features/booking/steps/race/`:**
- `RaceDateStep.tsx`
- `RacePartyStep.tsx`
- `RaceProductStep.tsx` (tier + track variant selection)
- `RaceHeatPickerStep.tsx` (multi-heat aware; renders N heat pickers based on product)
- `RaceLicenseStep.tsx` (only visible when `isNewRacer && partySize > 0`)
- `RaceContactStep.tsx` (session-level — first/last/email/phone, SMS opt-in)
- `RaceWaiverStep.tsx` (clickwrap acceptance UI)
- `RaceReviewStep.tsx` (heat summary, line items, total with FL 6.5% tax)

**Files to modify:**
- `apps/web/src/features/booking/state/steps.ts` — replace race placeholders with real step components.

**Pattern for each step:**
```ts
const Component: StepDef<RaceItem>["Component"] = ({ item, session, onChange }) => {
  // read item.<field> + session.context for prefill
  // dispatch onChange({ field: newValue }) on user input
  // surface validation in canAdvance via `{ reason: "..." }` returns
};
```

---

### Commit 10 — Checkout: Square anchor + payment + `clickwrap_acceptances`

**Files to create:**
- `apps/web/src/features/booking/service/checkout.ts` — orchestrator that, on Checkout click:
  1. Creates the Square Order (POST `/api/square/pay`'s `mode: "create-order"` or whatever internal-fetch pattern v1 uses)
  2. For each item in `session.items`: dispatches to the per-activity vendor service to create the reservation
  3. Square payment via the existing `/api/square/pay` route (DO NOT fork it)
  4. On success: writes `clickwrap_acceptances` row via `lib/clickwrap.ts`
- `apps/web/src/components/features/booking/CheckoutForm.tsx` — Square Web Payments SDK form
- `apps/web/src/features/booking/hooks/useCheckout.ts` — React Query mutation wrapper

**Files to modify:**
- `apps/web/src/components/features/booking/CartView.tsx` — wire the Checkout button to `useCheckout`

**Critical reference files:**
- `apps/web/app/api/square/pay/route.ts` — DO NOT modify; internal-fetch from `data/square.ts` instead
- `apps/web/lib/clickwrap.ts` — reuse as-is for the waiver evidence write

**Verification:**
- End-to-end: race v2 happy path completes through Square sandbox + a successful BMI mock booking.
- Failure injection: kill the BMI call mid-flow → Square Order stays in DRAFT, customer sees friendly error.

---

### Commit 11 — Confirmation page

**Files to create:**
- `apps/web/app/book/race/v2/confirmation/page.tsx` — server component, reads `?orderId=` from URL
- `apps/web/src/components/features/booking/ConfirmationView.tsx` — client island
- `apps/web/src/features/booking/service/confirm.ts` — SMS / email send orchestration + express-lane lookup

**Behavior:**
- Single Square Order GET by id → all financial detail
- BMI overview fetch for heat times
- QR code per racer (use whatever v1 uses — likely `qrcode` package)
- Express-lane check via `lib/pandora-*.ts` waiver lookup (skips Guest Services if verified)
- Rookie Pack appetizer code (display-only — show `RACEAPP` to first-timers)
- SMS confirmation via the existing `lib/sms-*.ts` infra (Voxtelesys primary, Twilio failover, retry queue)
- Email confirmation via the existing SendGrid integration

**Critical reference files:**
- `apps/web/app/book/confirmation/page.tsx` — v1 confirmation (port idea, not code)
- `apps/web/lib/sms-*.ts` — reuse SMS infra unchanged
- `apps/web/lib/email-*.ts` (or wherever SendGrid lives)

---

### After commit 11 — v1 parity audit

Open `v1_race_parity_checklist.md` (memory file). Walk through every row. For each:
- ✅ Confirm it ships in v2
- ⏭️ Confirm it has an explicit deferral note
- ⏸️ For HOLD items (just `sales_log` right now): ask Alex before merge

**Then convert the PR from Draft to Ready for Review.**

---

## 6. How to verify each commit

After EVERY commit:

```powershell
npx turbo run typecheck test --filter=fasttrax-web
```

After commits 8–11 (UI changes):

```powershell
npm run dev -w fasttrax-web
# Walk through /book/race/v2 end-to-end
```

Before the FINAL push of PR-B2:

```powershell
npx turbo run build --filter=fasttrax-web
# Must complete cleanly (1m20s-ish, a11y clean)
```

If lint suddenly fails: lint is `continue-on-error` in CI (~105 pre-existing errors) but DON'T add new errors. Pre-commit hook runs prettier-only.

---

## 7. GitHub workflow

### Push commits

```powershell
git push origin feat/booking-b2-race
```

The pre-commit hook (Husky 9 + lint-staged) runs prettier on staged files before each commit. Don't bypass with `--no-verify`. If it fails, fix the underlying issue.

### Open / update the draft PR

If not yet opened:
- Go to **https://github.com/BMA-Dassle/Tools-Website-FT/pull/new/feat/booking-b2-race**
- Base = `feat/booking2`
- Check the **Draft** checkbox
- Paste the test plan from § 11 below as the body

If already opened (Alex may have done this):
- Each new pushed commit updates the PR automatically
- Update the PR description as you finish commits — note what's now done

### CI checks to watch

GitHub Actions runs on every push to a PR branch:
- `format:check` — prettier formatting (must pass)
- `typecheck` — `tsc --noEmit` (must pass)
- `lint` — eslint (continue-on-error, but don't add new errors)
- `test` — vitest (must pass)
- `build` — `next build` (must pass)

Look at the bottom of the PR for the green/red status. If any required check is red, fix before continuing.

### Convert from Draft to Ready for Review

When all 6 remaining commits are pushed AND v1 parity is audited AND CI is green:

GitHub UI → bottom of the PR → "Ready for review" button.

### Merge into `feat/booking2`

DO NOT merge `feat/booking-b2-race` into `feat/booking2` yourself unless Alex confirms or explicitly delegates. The flow is:

1. PR-B2 (`feat/booking-b2-race` → `feat/booking2`) gets review
2. After approval, you (or Alex) merge with **Squash and merge** (preferred — keeps `feat/booking2` history clean)
3. After PR-B2 lands on `feat/booking2`, the full `feat/booking2` → `main` merge happens at a later point with all v2 booking PRs (B2 + B3 + ...) bundled.

### When in doubt

Ask Alex on Slack BEFORE doing anything irreversible (force push, branch deletion, merge to main).

---

## 8. Memory system primer

The `memory/` directory at `C:\Users\<you>\.claude\projects\c--git-Tools-Website-FT\memory\` already has these files (Alex wrote them):

- `MEMORY.md` — index. Always loaded into Claude's context automatically.
- `booking_v2_architecture.md` — multi-activity cart rules
- `booking_v2_entry_context.md` — EntryContext shell
- `booking_v2_square_attributes.md` — Square attr schema
- `booking_v1_catalog_reference.md` — v1 catalog pointer
- `feedback_v2_parity_with_v1.md` — "every v1 feature exists in v2"
- `v1_race_parity_checklist.md` — the v1 race audit

**When Claude makes a non-obvious decision during your work**, ask it to save the rationale as a memory file. Future sessions (yours, Alex's, anyone's) will load it automatically.

**When Claude references "memory says X"**, verify against current code state if you're about to act on it. Memory is a snapshot in time; code may have moved.

---

## 9. Hard rules — do NOT violate

From `CLAUDE.md`:

1. **NEVER use `Number()` or `JSON.stringify()` on BMI personId / billId / orderId.** Use `@ft/db.stringifyWithRawIds` or raw-text injection.
2. **NEVER add a new top-level page using `headers()` to switch on host** without updating `SHARED_TOP_LEVEL_ROUTES` in middleware. HeadPinz visitors will 404.
3. **NEVER install Shadcn/ui** or any other component-library kit. Custom components in `src/components/ui/` only.
4. **NEVER introduce an ORM** (Prisma / Drizzle / Kysely). Raw SQL via `@neondatabase/serverless`.
5. **NEVER read `process.env` directly** outside `@ft/env` (when it lands in PR4).
6. **NEVER record session replay on KBF or admin routes.** COPPA + PII.
7. **NEVER skip git hooks** (`--no-verify`, `--no-gpg-sign`, etc.). Fix the underlying issue.
8. **NEVER edit v1 files** during v2 work. v1 must keep working unchanged until v2 is cut over.
9. **ALWAYS audit v1 parity** before declaring a v2 activity done. See feedback memory.
10. **ALWAYS inspect actual HTML / computed styles** before writing UI code — never guess at a live site's CSS.

---

## 10. v1 race parity — what MUST exist in v2 race

Read `v1_race_parity_checklist.md` for the full table. Critical highlights:

- **Multi-heat single-bill** (3-pack day-of products work via `heats[]`)
- **Heat-conflict gap rules** (port from `lib/heat-conflict.ts`)
- **BMI raw-ID precision** (`@ft/db.stringifyWithRawIds`)
- **Static race product registry** (don't fetch BMI's `/page`; keep products in code)
- **License upsell** ($30–$40 per first-timer, as Square line item)
- **Contact form** (first/last/email/phone, SMS opt-in)
- **Waiver acceptance** → `clickwrap_acceptances` row write (use `lib/clickwrap.ts` unchanged)
- **Square payment via existing `/api/square/pay`** (internal-fetch — do not fork)
- **Confirmation: QR per racer, heat schedule, reservation number**
- **SMS confirmation** (Voxtelesys + Twilio failover + retry queue)
- **Email confirmation** (SendGrid HTML template)
- **Express-lane bypass** (Pandora waiver lookup short-circuits Guest Services)
- **Rookie Pack appetizer code** (RACEAPP @ Nemo's, display-only)
- **FL 6.5% sales tax**
- **FT-only entry** (racing is FastTrax Fort Myers only; HP customers can still ADD a race to a Fort Myers cart via cross-sell)

Explicit deferrals (do NOT ship in PR-B2):
- POV video purchase + Pandora session linking
- `sales_log` writes (ON HOLD — ask Alex)
- BMI office notes (`appendPrivateNote`)
- Race-pack credit purchases (PR-B4)

---

## 11. Suggested test plan for the PR body

```markdown
## Test plan

### Routes
- [ ] `/book/race/v2` — race wizard end-to-end (date → party → product → heats → license → contact → waiver → review → checkout → confirmation)
- [ ] `/book/race/v2?firstName=Alex&email=a@b.co` — contact prefilled from EntryContext
- [ ] `/book/v2` returns 404
- [ ] `/book/race-pack/v2` returns 404 (deferred to PR-B4)
- [ ] `/book/race` (v1) still serves real bookings

### Heat selection
- [ ] Single-heat product books one heat on the BMI bill
- [ ] 3-pack day-of product books 3 heats chained on the same `orderId`
- [ ] Heat-conflict blocking surfaces when picking heats with insufficient gap (≥13 min same-track Red/Mega, ≥16 min Blue, ≥30 min cross-track)
- [ ] BMI personId + orderId preserve full precision (no JSON.stringify on them)

### Payment
- [ ] Square sandbox card charges successfully
- [ ] Card declined → friendly error, no BMI booking left dangling
- [ ] FL 6.5% tax applied
- [ ] License fee adds $30–$40 line for first-timers, omitted for returning racers

### Side effects
- [ ] `clickwrap_acceptances` row written on payment success
- [ ] SMS confirmation sent (Voxtelesys primary)
- [ ] Email confirmation sent (SendGrid)
- [ ] BMI bill finalized via `/payment/confirm`

### Confirmation
- [ ] QR code per racer
- [ ] Heat schedule grouped by time + track
- [ ] Reservation number visible
- [ ] Express-lane bypass shown for verified returning racers
- [ ] Rookie Pack appetizer code (RACEAPP) shown for first-timers

### Cross-sell
- [ ] AdditionalActivities tile in cart shows other FM offerings (bowling, gel-blaster, etc.) on a FT race entry
- [ ] Naples bowling cart doesn't show FT-only race / duck-pin / shuffly tiles

### Build / tests
- [ ] `npx turbo run typecheck test --filter=fasttrax-web` clean (≥22 cases passing — count grows per commit)
- [ ] `npx turbo run build --filter=fasttrax-web` clean

### Mock-mode dev path
- [ ] With `LOCAL_BMI_MOCK=1` + `LOCAL_SQUARE_MOCK=1`, race v2 walks end-to-end with no real vendor calls
```

---

## 12. After PR-B2 — moving to PR-B3 (Attractions)

If you finish PR-B2 with time left, start PR-B3.

**Branch:** `feat/booking-b3-attractions` off `feat/booking2`.

**Activities covered:** gel-blaster, laser-tag, duck-pin, shuffly.

**Scope:**
- Build a single AttractionItem step set: Date → Slot → Party → Review
- Most logic reuses commit 6's BMI adapter (attractions are also BMI-vendored). The Square attribute reader will resolve which BMI product based on `Booking Activity` + center + (for shuffly) `session.entryBrand`.
- Confirmation page reuses the race v2 confirmation pattern but for slot-based bookings.
- v1 reference: `apps/web/app/book/[attraction]/page.tsx` is the source. Per `v1_race_parity_checklist.md`'s lesson, do a v1 attraction parity audit before declaring PR-B3 done.

**Estimated:** 6–8 commits across attractions. The BMI adapter is already in place from commit 6 so most of the heavy lifting is the per-attraction step components + UX polish.

**For PR-B5 (bowling) and PR-B6 (KBF):** see the original `we-are-going-to-polymorphic-hejlsberg.md` (the doc you're reading now, replaced with this handoff). The Conq adapter and KBF identity gate are net-new in those PRs. Don't start them in your 2 days — they're enough work to warrant their own design pass with Alex.

---

## 13. Open decisions for you to surface back to Alex

Add these to the PR description so they're visible at review time:

1. **`sales_log` writes from v2** — ON HOLD. Need Alex's decision before PR-B2 merges. Either v2 dual-writes to `sales_log` AND Square metadata, or the sales board pivots to Square Search Orders first. Right now v2 race writes NOTHING to `sales_log`.
2. **Express-lane TTL** — `v1_race_parity_checklist.md` notes the 24h pre-race + 6h check-in TTLs may need recalibration. Leave as-is in PR-B2; flag for follow-up.
3. **Heat-conflict thresholds** (13/16/30 min) — hardcoded in v1 from operator feedback. Port as-is; flag for follow-up if you spot operator dissatisfaction in support tickets.
4. **BMI office notes endpoint** — pending v1 confirmation. v2 deliberately skips this; backfill comes later.
5. **Cross-session navigation** (clicking a cross-sell tile → joins the same cart) — not in PR-B2. Probably PR-B2.5. Surface as a follow-up issue.

---

## 14. When you should stop and ask Alex

- ANY violation of the 10 hard rules in § 9.
- The build breaks in a way you can't fix in 30 minutes.
- You think an architectural decision in § 4 is wrong.
- BMI / Square sandbox returns something nobody expected.
- You discover a v1 race behavior that's NOT in `v1_race_parity_checklist.md` and you can't tell if it should be in PR-B2.
- The `sales_log` HOLD decision becomes blocking.
- You need to force-push, rebase, or do anything that rewrites already-pushed history.
- A pre-commit hook fails and you can't figure out why.
- You're tempted to add a new env var (no env vars without Alex; they need to be added to Vercel + 1Password too).

**How to reach Alex (out of office):**
- Slack: `@alex` — best for async questions, expect 1–4h response time
- Email: `alex@headpinz.com` — for anything Slack misses
- Truly urgent / customer-impacting: text Alex's cell (ask Slack DM for it if you don't have it)

---

## 15. Glossary

- **BMI** — Backoffice booking system used by FastTrax + HeadPinz for racing, race-packs, and attractions. RESTful API; IDs are 17-digit and must NOT be coerced through `Number()` or `JSON.stringify()`. Helpers in `@ft/db`.
- **Conq / QAMF** — Bowling reservation backend (HeadPinz only). v2 wraps it in `features/booking/data/conq.ts` (lands in PR-B5).
- **Pandora** — In-house BMA system; tracks waivers, race deposits, video sessions. Adapter at `features/booking/data/pandora.ts` (in flight).
- **KBF** — Kids Bowl Free. HeadPinz-only summer program. Identity gate (lookup → 6-digit code → roster) + Neon tables `kbf_passes`, `kbf_pass_members`. v2 adapter lands in PR-B6.
- **Square** — Payment + catalog. The source of truth for all financial state in v2. Custom attributes on catalog items map them to BMI/Conq/KBF products.
- **Vox / Voxtelesys** — Primary SMS provider. Twilio is failover.
- **`@ft/db`** — Workspace package with `stringifyWithRawIds` + `withIdempotency` helpers. Lives at `packages/db/`.
- **EntryContext** — Typed shell carrying prefilled session data (member, promo, contact, party). Lives at `apps/web/src/features/booking/state/entry-context.ts`.
- **SessionItem** — Union of `RaceItem | AttractionItem | BowlingItem | KbfItem`. In PR-B4 will gain a `CreditPackItem` variant for race-packs.
- **`entryBrand`** — `fasttrax | headpinz`. Captured once at session creation. Drives theming + shuffly's FT/HP-side resolution.
- **Center** — Physical complex: `fort-myers | naples`. Cart constraint.
- **Express lane** — Bypass for verified returning racers (skip Guest Services check-in). Pandora waiver lookup on the confirmation page.
- **Rookie Pack** — Promotional code (`RACEAPP`) shown to first-time racers on the confirmation page — redeemable at Nemo's restaurant inside the venue.

---

## 16. Verification — how to confirm the handoff worked

Before you (the coworker) start coding, you should be able to answer these in your own words:

1. Why is `/book/v2` a 404 in this codebase? (Because: entry is always activity-specific; cross-sell lives in the cart.)
2. What happens when a customer enters via FT racing then adds an HP bowling lane? (Same Square Order, both items on the same cart, one payment. Center is locked at Fort Myers.)
3. Why does `RaceItem` need `heats[]` (plural)? (Because v1 sells 3-pack day-of products that chain 3 heats on one BMI orderId. Scope decision: ship in PR-B2.)
4. Where does the BMI productId for a given race-tier-and-track come from? (Static registry in `service/race-products.ts`, NOT live BMI `/page` fetch — privacy-optimized matches v1.)
5. What's the v1 fallback in the BMI adapter? (When a Square catalog variation lacks `BMI Item ID` attr, fall back to `lib/attractions-data.ts`'s `PRODUCT_ATTRACTION_MAP`.)
6. Why is race-pack NOT in PR-B2? (Race-pack is a credit-purchase, not a booking. Lives in PR-B4 as a separate `CreditPackItem` SessionItem variant.)
7. What happens to v1 race during all of this? (Untouched. Keeps serving customers at `/book/race`.)

If you can't answer all of these, read § 3 again before touching code.

---

**Good luck. Push small. Verify often. Ask early.**

— Alex (handoff drafted with Claude)
