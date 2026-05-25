# Booking v2 — General Handoff · 2026-05-24

**Audience:** Anyone picking up booking v2 work — racing polish (PR-B2.5), attractions (PR-B3), race-pack credits (PR-B4), bowling (PR-B5), KBF (PR-B6), or follow-up features (video, marketing, cross-session navigation).

**This doc is the architecture + roadmap.** For racing-specific status, read [`handoff-pr-b2.md`](handoff-pr-b2.md) first.

For end-of-2026-05-17 context (older PR-B2 doc), see git history of this file.

---

## 1. What "booking v2" is

We're rewriting FastTrax / HeadPinz booking from per-activity standalone flows (under `apps/web/app/book/<activity>/`) into a unified **multi-activity cart** anchored by a single Square Order. One transaction can hold a race heat + a bowling lane + a gel-blaster slot.

```
v1 (today, still live):                       v2 (in flight):
/book/race           (standalone, real)        /book/race/v2           ← PR-B2 (shipping)
/book/[attraction]   (standalone, real)        /book/[attraction]/v2   ← PR-B3 (next)
/book/bowling        (standalone, real)        /book/bowling/v2        ← PR-B5
/book/kbf            (standalone, real)        /book/kbf/v2            ← PR-B6
                                               /book/race-pack/v2      ← PR-B4 (different: credit purchase)

Each v2 entry creates ONE BookingSession with N items, ONE Square Order, ONE checkout, ONE confirmation.
```

v1 stays running unchanged until each v2 activity is cut over individually. **NEVER edit v1 files during v2 work.**

---

## 2. Locked architectural decisions (do not relitigate)

These are baked in and ALREADY shipped in code. If you think one is wrong, ASK Alex before any change.

| # | Decision | Where it lives |
|---|---|---|
| 1 | **Multi-activity cart** — `BookingSession.items: SessionItem[]`. One Square Order, N items. | `state/types.ts` |
| 2 | **One center per cart** — `session.center` locks when first item picks it; switching clears `items[]`. | `state/machine.ts:setCenter` |
| 3 | **Brand = theming only** — `session.entryBrand` captured at session creation, never mutates. | `state/types.ts:emptySession` |
| 4 | **Shuffly resolves via `entryBrand`** — two physically different shuffly venues at Fort Myers (FT-side + HP-side). Catalog reads entryBrand to pick which BMI product / Square item. | `activities-catalog.ts` |
| 5 | **No /book/v2 chooser route** as the customer's primary entry — entry is always activity-specific. `/book/v2` exists as the promo-code landing page only (PR-B2 commit 8.5). | `app/book/v2/page.tsx` |
| 6 | **Square = source of truth for finance** — cart IS the Square Order. BMI / Conq / KBF reservations are non-financial (priced at $0); Square holds the money. | `service/checkout.ts` |
| 7 | **Square custom attributes drive vendor mapping** — `BMI Item ID`, `Booking Activity`, `Pack Slug` (race-packs), `Conq Item ID` (PR-B5), `KBF Pass Type` (PR-B6). No Neon mapping table. | `data/square-catalog.ts` (stubs) |
| 8 | **v1 `PRODUCT_ATTRACTION_MAP` is the BMI fallback** until Square attributes are backfilled. Adapter reads attrs first, falls back to v1 hardcode when missing. | `data/bmi.ts` |
| 9 | **Race-pack is DEFERRED to PR-B4** as a credit-pack purchase, NOT a booking. `Activity` enum is `race \| attraction \| bowling \| kbf` only. | `tasks/future/race-pack-as-credit-purchase.md` |
| 10 | **`EntryContext`** is the typed extension shell for prefilled session data (member, promo, prefilledContact, partyMembers, referrer). PR-B2 ships the shell; only `prefilledContact` is consumed today. | `state/entry-context.ts` |
| 11 | **Activity catalog (`activities-catalog.ts`) is the source of truth** for "what's offered where." A runtime config layer (Neon table + admin UI) is captured in `tasks/future/activity-config-layer.md` and intentionally deferred. | `features/booking/activities-catalog.ts` |
| 12 | **No mock mode** for new v2 work — BMI / Square / Pandora / KBF adapters always hit live endpoints. Existing `mockBmiAdapter` etc. stay as inactive code for vitest fixtures, but `isMockMode(vendor)` always returns false in normal dev. | `data/bmi.ts:362-end`, memory: `feedback_no_mock_mode.md` |
| 13 | **Per-member `isNewRacer`** in `PartyMember` (not party-wide `racerType`) — v2's chosen divergence from v1, user-confirmed. | `state/types.ts:PartyMember` |
| 14 | **3-pack day-of multi-heat races ship in PR-B2** via `RaceItem.heats: RaceHeatAssignment[]`. Race-pack credits are PR-B4 and use a different shape. | `state/types.ts:RaceItem` |
| 15 | **Reducer NEVER destroys data on back-nav** — only the step cursor moves. Step components that lose state on remount are bugs (use `useState(() => deriveFromSession(...))` to fix). | `state/machine.ts:back/goto` |

---

## 3. Module layout

All new code lives under `apps/web/src/features/booking/`:

```
apps/web/src/features/booking/
├── data/                    Vendor adapters (BMI, Square, Square Catalog, Pandora — adapters return raw API shapes)
│   ├── bmi.ts               Real impl + mockBmiAdapter (gated by isMockMode)
│   ├── square.ts            STUB — createOrder/getOrder/cancelOrder throw "lands in PR-B2"; racing bypasses this via shared /api/square/pay
│   ├── square-catalog.ts    STUB — findByBmiItemId/findByBookingActivity/getById throw; needed for PR-B3
│   └── index.ts             Re-exports
├── service/                 Pure business logic + orchestration (no UI, no React)
│   ├── checkout.ts          Session-level orchestrator (runCheckout, fetchBillOverview, recordClickwrap, saveBookingDetails, confirmCreditOrder, resolveSquareCustomer, buildConfirmationUrl)
│   ├── race.ts              Race service (bookHeatsOnAdvance, holdRaceItem, sell license/POV/addons)
│   ├── race-products.ts     Static race product registry
│   ├── race-pricing.ts      Schedule resolver + FL tax + LICENSE_PRICE/POV_PRICE
│   ├── conflict.ts          Heat-conflict gap rules
│   ├── packages.ts          Re-export from lib/packages.ts
│   └── index.ts             getService(kind) → BookingService dispatcher
├── state/                   State machine + types
│   ├── types.ts             BookingSession, SessionItem union, RaceItem / AttractionItem / BowlingItem / KbfItem, PartyMember, factories
│   ├── machine.ts           reducer + Action union
│   ├── steps.ts             STEP_REGISTRY per item kind + StepDef contract
│   ├── entry-context.ts     EntryContext shape + URL parser
│   └── parse-entry-context.test.ts
├── activities-catalog.ts    Per-center activity matrix + offering definitions
├── queries.ts               React Query keys (bookingKeys factory)
├── types.ts                 Activity / Brand / CenterCode / ContactInfo enums
├── index.ts                 Public surface
└── (tests scattered as *.test.ts)

apps/web/src/components/features/booking/
├── BookingFlow.tsx          Wizard orchestrator — sticky step bar, ReservationTimer, navigation, modals
├── CartView.tsx             Multi-item cart + AdditionalActivities cross-sell + LeaveConfirmModal
├── AdditionalActivities.tsx Cross-sell tile grid (always cart-promo-agnostic per memory)
├── ReservationTimer.tsx     10-min countdown pill in sticky bar
├── steps/
│   ├── checkout/CheckoutStep.tsx          6-phase checkout (contact → booking → review → paying → confirming → redirect)
│   └── race/                              All race step components, modals, package picker
```

v1 lives at `apps/web/app/book/<activity>/` — **never edit those files during v2 work**.

---

## 4. State model

### `BookingSession` — the cart

```ts
{
  squareOrderId: string | null;     // lazy — created at checkout
  bmiBillId: string | null;         // lazy — created on first BMI line
  entryBrand: "fasttrax" | "headpinz";  // captured once
  center: "fort-myers" | "naples" | null;  // locks when items[] non-empty
  contact: Partial<ContactInfo>;    // billing customer
  context: EntryContext;            // prefilled data
  appliedPromo: AppliedPromo | null;  // captured at /book/v2 landing or ?code= seed; NEVER mutates
  party: PartyMember[];             // roster
  kbfIdentity?: KbfIdentityState;   // present only when KbfItem in items[]
  items: SessionItem[];             // cart
  activeItemId: string | null;      // null = cart view; non-null = in sub-wizard
  cursors: Record<string, number>;  // per-item step cursor
}
```

### `SessionItem` union — what's in the cart

```ts
type SessionItem = RaceItem | AttractionItem | BowlingItem | KbfItem;
// PR-B4 adds: | CreditPackItem (for race-pack purchases)
```

Each item has a `kind` discriminator + its own per-activity shape. See `state/types.ts` for the full definitions.

### `PartyMember` — roster element

```ts
{
  id: string;
  firstName: string;
  lastName?: string;
  bmiPersonId?: string;       // populated by BMI verification (returning racer)
  isNewRacer: boolean;
  category?: "adult" | "junior";
  isBillingCustomer?: boolean;
  memberships?: string[];     // BMI membership names (drives tier filtering for returning racers)
}
```

### Step registry

`state/steps.ts:STEP_REGISTRY` maps each `SessionItem["kind"]` to an ordered `StepDef[]`. The wizard runs them filtered by `isVisible(item, session)`, gated by `canAdvance(item, session)`.

Currently:
- **race** — populated (Party / Date / Adult Race / Adult Heats / Junior Race / Junior Heats / POV & Pack / Extras)
- **attraction** — all placeholders, **needs PR-B3**
- **bowling** — all placeholders, **needs PR-B5**
- **kbf** — all placeholders, **needs PR-B6**

---

## 5. Adapter status

| Adapter | File | Status | What it needs |
|---|---|---|---|
| **BMI** | `data/bmi.ts` | ✅ Real impl shipping | Full v1-parity adapter (getAvailability PascalCase + pageId, bookHeat with raw-ID via `@ft/db.stringifyWithRawIds`, createPerson, removeBookingLine, confirmPayment, getOrderOverview). Mock impl stays for vitest. |
| **Square Orders** | `data/square.ts` | 🔴 Stub | `createOrder` / `getOrder` / `cancelOrder` throw "lands in PR-B2". Racing bypasses this via shared `/api/square/pay`. **Bowling + attractions WILL need this** — wire against Square Orders REST. |
| **Square Catalog** | `data/square-catalog.ts` | 🔴 Stub | `findByBmiItemId` / `findByBookingActivity` / `getById` throw. Needed by attractions to resolve which BMI product a Square catalog item maps to (custom attribute reads). v1 fallback via `lib/attractions-data.ts:PRODUCT_ATTRACTION_MAP`. |
| **Pandora** | (inline in step components) | ✅ Real calls in flow | Used by `RacePartyStep` for waiver lookups + linked-racer fetch. No dedicated adapter file yet; consider extracting `data/pandora.ts` if PR-B5 needs it. |
| **SMS-Timing** | (inline in `service/race.ts:probeAddonSlot`) | ✅ Real calls | Used for dayplanner add-on availability via `/api/sms`. Consider extracting `data/sms-timing.ts`. |
| **Conq / QAMF** | `data/conq.ts` | ❌ Doesn't exist | **PR-B5 net-new** — bowling reservation backend. v1 reference: `apps/web/lib/conq-*.ts`. |
| **KBF** | `data/kbf.ts` | ❌ Doesn't exist | **PR-B6 net-new** — Kids Bowl Free identity gate + pass roster. v1 reference: `apps/web/lib/kbf-*.ts`. |

**Shared API routes (do NOT modify — v1 + v2 both use them):**
- `apps/web/app/api/bmi/route.ts` — BMI proxy
- `apps/web/app/api/sms/route.ts` — SMS-Timing proxy
- `apps/web/app/api/square/pay/route.ts` — Square Orders + Payments + saved cards (multi-tender)
- `apps/web/app/api/square/customer/route.ts` — Square customer lookup + saved cards
- `apps/web/app/api/booking-store/route.ts` — Redis booking cache (24h TTL)
- `apps/web/app/api/booking-record/route.ts` — Postgres booking record (90d TTL)
- `apps/web/app/api/notifications/booking-confirmation/route.ts` — SMS + email + `logSale()` + clickwrap fan-out
- `apps/web/app/api/clickwrap/record/route.ts` — clickwrap_acceptances writer
- `apps/web/app/api/pandora/route.ts` — Pandora waiver/related lookups
- `apps/web/app/api/sms-verify/route.ts` — OTP send/verify for returning racer lookup
- `apps/web/app/api/bmi-office/route.ts` — BMI office search/person/deposits (v1 lookup helper)

---

## 6. Catalog system

`activities-catalog.ts` is the source of truth for "what activities exist where + which brand they belong to + which Square / BMI products back them." It's static code today; runtime config (admin-managed) is captured in `tasks/future/activity-config-layer.md` as deferred.

### Square custom attributes drive vendor mapping

Pattern (per `booking_v2_square_attributes.md` in memory):

| Attribute | On | Purpose |
|---|---|---|
| `BMI Item ID` | Square catalog variation | Maps Square item → BMI product (comma-separated for multi-product variants) |
| `Booking Activity` | Square catalog item | Enum (`racing` / `gel-blaster` / `bowling` / etc.) — drives the v2 catalog search |
| `Pack Slug` | Square catalog item (race-packs only) | Used in PR-B4 for credit-purchase resolution |
| `Conq Item ID` | Square catalog variation | PR-B5 — maps to Conq bowling product |
| `KBF Pass Type` | Square catalog variation | PR-B6 — maps to KBF pass type enum |

The catalog reader (`data/square-catalog.ts`) is stubbed. PR-B3 needs to wire it for attractions.

### v1 fallback

When the Square `BMI Item ID` attribute is missing on a variation, fall back to `apps/web/lib/attractions-data.ts:PRODUCT_ATTRACTION_MAP` (v1's hardcoded mapping). This is a transitional measure until all Square items have the attribute backfilled.

---

## 7. Promo / discount-codes integration

The discount-codes feature shipped to main during the merge window and is cross-domain by design (one row can scope to bowling / racing / attractions). v2 captures the promo at session START:

1. Customer lands on `/book/v2?code=X` OR types code into the landing
2. Server validates via `resolveAppliedPromo()` from `features/discount-codes`
3. Valid codes filter the LANDING tile list to in-scope activities (cross-sell in cart is NOT filtered — see `booking_v2_promo_integration.md`)
4. On tile click, customer lands on `/book/<activity>/v2?code=X` — code carried in URL
5. Activity page seeds the session with `appliedPromo: <validated promo>`
6. The product step + date step optionally filter by scope/window (only when promo set AND no items in cart yet)
7. **Cart cross-sell IGNORES the promo** — bowling cross-sell shows even if the code is racing-only
8. At checkout, the discount applies to every Square Order line whose domain matches the code's scope

Direct-slug entry with a wrong-domain code (e.g. `/book/race/v2?code=BOWL10` where `BOWL10` is bowling-only) used to redirect; we removed the redirect — instead the code is captured and the customer can still book racing (just without the discount applying to racing lines).

Files:
- `apps/web/src/features/discount-codes/` — types, service, data, API routes
- `apps/web/app/book/v2/page.tsx` — landing
- `apps/web/app/api/booking/v2/promo/route.ts` — public `resolveAppliedPromo` wrapper

---

## 8. PR roadmap (post-PR-B2)

### PR-B2.5 — Cross-session navigation + small polish

- Cross-sell tile in cart starts a NEW session today (loses cart). Need: tile click joins the existing session, persists the additional activity in-memory, returns to wizard for that activity.
- Session persistence — currently in-memory React; consider sessionStorage / Redis for hard-refresh recovery
- BMI office notes (`appendPrivateNote`) — pending v1 endpoint confirmation
- Reservation-timer expiry behavior — what happens when 10-min countdown hits zero?

### PR-B3 — Attractions (gel-blaster, laser-tag, duck-pin, shuffly)

**Branch:** `feat/booking-b3-attractions` off `feat/booking2`

**Scope:**
- Build a single AttractionItem step set: Date → Slot → Party → Review
- Per attraction, slot-based BMI availability + booking (reuses `data/bmi.ts`)
- Wire `data/square-catalog.ts` real impl (find product by `Booking Activity` attribute + center)
- Shuffly resolves Red/Blue side from `session.entryBrand` (FT vs HP)
- Confirmation reuses the v1 shared `/book/confirmation` page (compat path proven by PR-B2)
- v1 parity audit BEFORE declaring done (build a `v1_attraction_parity_checklist.md`)

**v1 reference:** `apps/web/app/book/[attraction]/page.tsx`

**Estimated:** 6-8 commits. BMI adapter exists; most effort is per-attraction UI + UX polish.

### PR-B4 — Race-pack credits

**Branch:** `feat/booking-b4-race-pack` off `feat/booking2`

**Scope:**
- Race-pack is a **credit purchase**, NOT a booking. See `tasks/future/race-pack-as-credit-purchase.md`.
- New `CreditPackItem` SessionItem variant — sits in cart with a price, charges via Square, but doesn't book any BMI heat
- After payment, calls Pandora `addDeposit` to grant the credits to the customer's racer ID
- Confirmation page shows credit balance + "use these for your next visit"
- Square's `Pack Slug` custom attribute on catalog variations identifies which pack was purchased

**v1 reference:** `apps/web/app/book/race-packs/page.tsx`

**Critical:** Square charges first, Pandora deposit second (atomicity is non-trivial — see `lib/bmi-deposit-retry.ts` for v1's retry pattern).

### PR-B5 — Bowling (FT Duck-pin + HP open + HP hourly)

**Branch:** `feat/booking-b5-bowling` off `feat/booking2`

**Scope:**
- **New adapter:** `data/conq.ts` — Conq / QAMF API integration (HeadPinz reservation backend)
- BowlingItem step set: Variant (open / hourly) → Date → Time → Lanes → Party → Review
- Open bowling is walk-in style (no time slot); hourly is per-lane reservation
- v1 already handles bowling under `app/book/bowling/` and `/api/bowling/v2/reserve/route.ts` — read that route first (it has cold-start retry + marketing opt-in we may want)
- Marketing opt-in via `features/marketing` — PR-B2 deferred; revisit in B5

**v1 reference:** `apps/web/app/book/bowling/`, `apps/web/app/api/bowling/v2/`

### PR-B6 — Kids Bowl Free (KBF)

**Branch:** `feat/booking-b6-kbf` off `feat/booking2`

**Scope:**
- **New adapter:** `data/kbf.ts` — KBF identity (lookup → 6-digit code → roster) + pass redemption
- KbfItem step set: Identity → Slot → Bowlers → Add-ons → Review
- `session.kbfIdentity` is auto-initialized when first KbfItem added, cleared when last KbfItem removed (already wired in reducer)
- Identity verifies ONCE per session; subsequent KbfItems reuse the verified pass
- **COPPA + PII guard:** NO session replay on `/hp/kids-bowl-free/*` or `/api/kbf/*` routes
- v1 reference: `apps/web/app/hp/kids-bowl-free/`, Neon tables `kbf_passes`, `kbf_pass_members`

### Follow-up PRs (not on the critical path)

- **Race video features** — POV Pandora session linking (8s post-confirm), POV viewer page, video purchase flow (see `tasks/future/custom-viewpoint-viewer.md`)
- **Marketing audience enrollment** — at confirmation, enroll into Square marketing audiences (race + bowling both)
- **Activity config layer** — runtime catalog (Neon table + admin UI) replacing the static `activities-catalog.ts` (see `tasks/future/activity-config-layer.md`)
- **Session persistence** — sessionStorage / Redis recovery on hard refresh
- **Gift card multi-tender** for v2 — race v2 ships without GC; revisit once payment flows are stable (see `tasks/future/gift-card-multi-tender-payments.md`)

---

## 9. Conventions for new code

| What | Where |
|---|---|
| New activity-specific UI | `src/components/features/booking/steps/<activity>/` |
| New activity service | `src/features/booking/service/<activity>.ts` |
| New vendor adapter | `src/features/booking/data/<vendor>.ts` |
| Shared UI primitives | `src/components/ui/` (hand-rolled — NO Shadcn) |
| Cross-feature hooks | `src/hooks/` |
| Generic utilities | `src/lib/` |
| State types + reducer | `src/features/booking/state/` |
| Routes | `apps/web/app/book/<activity>/v2/page.tsx` (App Router) |
| Tests | colocated `.test.ts` next to source |

### Patterns

- **`useReducer`** for the wizard state (not Zustand / Redux)
- **React Query** for vendor data fetching via `bookingKeys` factory
- **Real APIs only** — no mock mode for new features (`feedback_no_mock_mode.md`)
- **Strict v1 parity** for visuals + behavior (`feedback_v1_strict_parity_attraction_flow.md`)
- **Read v1 source in full** before writing the v2 equivalent (operating principle #1)
- **State derived from session on mount** — step components MUST initialize useState from session.party / session.items, NOT default to empty. Otherwise back-nav loses state.
- **Heat / slot booking on Next** (not on click) — picks are local, BMI booking happens at step advance
- **Confirmation via compat path** — v2 redirects to v1's `/book/confirmation` page; writes Redis + booking-record so v1's SMS / email / sales_log fan-out fires automatically
- **Per-line racer attribution** — for any cart line that maps to a BMI heat, look up the assigned PartyMember and display their name (see `CheckoutStep.tsx:heatRacers`)

---

## 10. Hard rules (from CLAUDE.md)

1. **NEVER use `Number()` or `JSON.stringify()` on BMI personId / billId / orderId.** Use `@ft/db.stringifyWithRawIds` or raw-text JSON injection. BMI IDs exceed `Number.MAX_SAFE_INTEGER`.
2. **NEVER add a new top-level page using `headers()` to switch on host** without updating `SHARED_TOP_LEVEL_ROUTES` in middleware. HeadPinz visitors will 404.
3. **NEVER install Shadcn/ui** or any other component-library kit.
4. **NEVER introduce an ORM** (Prisma / Drizzle / Kysely). Raw SQL via `@neondatabase/serverless`.
5. **NEVER record session replay on KBF routes** or admin routes (COPPA + PII).
6. **NEVER skip git hooks** (`--no-verify`, `--no-gpg-sign`).
7. **NEVER edit v1 files** during v2 work.
8. **NEVER guess at a live site's CSS/layout** — inspect actual HTML + computed styles first.
9. **ALWAYS audit v1 parity** before declaring a v2 activity done.
10. **ALWAYS pair displayed price with charge-time re-eval** when Statsig dynamic-config pricing is in play.

---

## 11. Critical reading order (for a fresh contributor)

1. `CLAUDE.md` — § 7 Operating Principles + Project-specific hard rules
2. This doc (`tasks/handoff-booking-v2.md`) — top to bottom
3. `tasks/handoff-pr-b2.md` — racing-specific (if working on racing or referencing it)
4. Memory files at `C:\Users\Alex.Trepasso\.claude\projects\c--git-Tools-Website-FT\memory\`:
   - `MEMORY.md` — index (auto-loaded)
   - `booking_v2_architecture.md` — locked decisions detail
   - `booking_v2_entry_context.md` — EntryContext shell
   - `booking_v2_square_attributes.md` — custom attribute schema
   - `booking_v2_promo_integration.md` — discount-codes integration
   - `feedback_v1_strict_parity_attraction_flow.md` — read v1 source, don't approximate
   - `feedback_no_mock_mode.md` — real APIs only
   - `feedback_v2_parity_with_v1.md` — every v1 feature exists in v2
   - `v1_race_parity_checklist.md` — comprehensive race behavior list
5. `tasks/restructure-plan.md` — § Phase 2 (booking v2 plan)
6. `tasks/restructure-status.md` — current phase + PR landed status
7. `tasks/lessons.md` — accumulated gotchas (BMI ID precision, husky corruption, etc.)
8. `apps/web/CLAUDE.md` — Next.js 16 warnings
9. `tasks/pr-b2-parity-matrix-2026-05-24.md` — concrete example of how to audit parity

For each new activity (B3, B5, B6):
- Read `app/book/<activity>/page.tsx` IN FULL before writing the v2 equivalent
- Build a parity checklist matching the structure of `v1_race_parity_checklist.md`
- Confirm scope decisions with Alex before starting (e.g. "is bowling marketing opt-in in scope?")

---

## 12. Environment

| What | Source |
|---|---|
| `.env.local` | 1Password vault "FastTrax Dev" → copy to `apps/web/.env.local` |
| Dev DB | `DATABASE_URL` = Neon shared dev |
| Dev Redis | `KV_REST_API_URL` + `KV_REST_API_TOKEN` = Upstash shared dev |
| Square sandbox | `SQUARE_ACCESS_TOKEN`, `SQUARE_LOCATION_ID_FT`, `SQUARE_LOCATION_ID_HP`, `SQUARE_LOCATION_ID_NAPLES`, `NEXT_PUBLIC_SQUARE_APPLICATION_ID`, `NEXT_PUBLIC_SQUARE_LOCATION_ID_*` |
| BMI | `BMI_API_BASE`, `BMI_CLIENT_KEY_FASTTRAX`, `BMI_CLIENT_KEY_HEADPINZ`, `BMI_CLIENT_KEY_NAPLES`, `BMI_SUBSCRIPTION_KEY`, `BMI_USERNAME`, `BMI_PASSWORD` |
| Pandora | `PANDORA_API_BASE`, `PANDORA_API_TOKEN` |
| SMS-Timing | (uses encrypted client ID baked into proxy; SMS_ACCESS_TOKEN optional) |
| Voxtelesys | (SMS infra — v1 lib, no v2 changes) |
| SendGrid | (Email infra — v1 lib, no v2 changes) |
| Feature flags | `NEXT_PUBLIC_ROOKIE_PACK_ENABLED=true`, `NEXT_PUBLIC_ULTIMATE_QUALIFIER_ENABLED=true` (both default ON; flip to "false" to disable) |

Brand switching (dev): `http://localhost:3000?brand=fasttrax` or `?brand=headpinz` sets a cookie + redirects clean.

```powershell
# Boot
npm install                                          # at repo root
npm run dev -w fasttrax-web                          # → http://localhost:3000

# Verify
npx turbo run typecheck test --filter=fasttrax-web   # expect 313/313 passing
npx turbo run build --filter=fasttrax-web            # ~1-2 min, must be clean
```

---

## 13. GitHub workflow

| Action | Command |
|---|---|
| Push commits | `git push origin <branch>` (pre-commit runs prettier via Husky + lint-staged) |
| Open draft PR | New PR from `feat/booking-bX-*` → base `feat/booking2`, mark Draft |
| Update PR | Each new commit pushed auto-updates the PR |
| CI checks | Auto-run on push: `format:check`, `typecheck`, `lint` (continue-on-error), `test`, `build`. All required-green except `lint`. |
| Flip Draft → Ready | After v1 parity audit + manual end-to-end + CI green |
| Merge | `feat/booking-bX-*` → `feat/booking2` via **Squash and merge**. `feat/booking2` → `main` happens at a later cutover with all v2 PRs bundled. Do NOT merge to main without Alex. |

Hard rules:
- Never `git push --force` to a pushed branch
- Never skip hooks (`--no-verify`, etc.)
- Never `git rebase -i` (interactive — not supported in this environment)

---

## 14. Memory system

Auto-loaded by every Claude session in this repo:

- Index: `C:\Users\Alex.Trepasso\.claude\projects\c--git-Tools-Website-FT\memory\MEMORY.md`
- Booking v2: `booking_v2_architecture.md`, `booking_v2_entry_context.md`, `booking_v2_square_attributes.md`, `booking_v2_promo_integration.md`
- Feedback / rules: `feedback_v2_parity_with_v1.md`, `feedback_v1_strict_parity_attraction_flow.md`, `feedback_v2_styling_parity.md`, `feedback_verify_dont_assume.md`, `feedback_lean_commit_messages.md`, `feedback_no_mock_mode.md`, `feedback_operating_principles.md`
- Reference: `v1_race_parity_checklist.md` (build similar for attractions / bowling / kbf in their PRs)
- Catalog: `booking_v1_catalog_reference.md`

When you make a non-obvious decision, save it as a memory file so future sessions inherit it. Memory files are append-only context — the index loads automatically; individual files load when referenced or relevant.

---

## 15. When in doubt, ask Alex

Stop and ask before:
- Force-pushing or rewriting pushed history
- Changing any locked architectural decision (§ 2)
- Editing v1 files (`apps/web/app/book/<activity>/page.tsx`, `apps/web/lib/race-*`, `apps/web/lib/packages.ts`, `apps/web/lib/sales-log.ts`)
- Modifying shared proxy routes (`/api/bmi`, `/api/sms`, `/api/square/pay`, `/api/booking-store`, etc.)
- Adding new env vars
- Installing new dependencies (especially component kits or ORMs)
- Recording session replay on a route that touches PII / minors

Contact:
- Slack: `@alex` (async, ~1-4h)
- Email: `alex@headpinz.com`

---

## 16. Glossary

- **BMI** — Backoffice booking system (FastTrax + HeadPinz). 17-digit IDs requiring raw-text injection via `@ft/db.stringifyWithRawIds`.
- **Conq / QAMF** — Bowling reservation backend (HeadPinz only).
- **Pandora** — In-house BMA system (waivers, race deposits, video sessions).
- **KBF** — Kids Bowl Free. HeadPinz-only. Identity gate + Neon tables.
- **Square** — Payment + catalog. Source of truth for finance in v2.
- **SMS-Timing** — Race timing system; powers BMI dayplanner. Proxy at `/api/sms`.
- **Vox / Voxtelesys** — Primary SMS provider. Twilio failover.
- **SendGrid** — Confirmation emails.
- **`@ft/db`** — Workspace package with `stringifyWithRawIds` + `withIdempotency`. Lives at `packages/db/`.
- **EntryContext** — Typed shell for prefilled session data.
- **SessionItem** — Cart's item union (Race / Attraction / Bowling / KBF; +CreditPack in PR-B4).
- **`entryBrand`** — `fasttrax | headpinz`, captured once at session creation.
- **Center** — Physical complex: `fort-myers | naples`. Cart constraint.
- **Express lane** — Bypass for verified returning racers (skip Guest Services).
- **Rookie Pack** — Promotional code (`RACEAPP`) for first-time racers (Nemo's appetizer).
- **Ultimate Qualifier** — Premium Package bundling Starter + Intermediate races with disclaimers.
- **booking-store / booking-record** — v2's Redis (24h) + Postgres (90d) booking persistence; v1 confirmation page reads them.
- **sales_log** — Postgres analytics table; populated by `/api/notifications/booking-confirmation`'s `logSale()` call.
- **clickwrap_acceptances** — Legal waiver evidence row written on payment confirm.

---

Good luck. Push small commits, verify end-to-end before declaring done, audit v1 parity row-by-row before flipping any PR to Ready.
