# World Cup VIP Bowling — build spec (branch `feat/world-cup`)

**Status:** approved by owner 2026-07-03. This branch is built by an autonomous cloud session
from THIS spec. Code + tests + pushed commits only — see "Builder scope" below for hard limits.
Local follow-ups (Square/QAMF ops ids, prod seed run, Vercel flags, live smoke) happen after.

## What we're selling

Limited-time bookable experience on `headpinz.com/book/v2`: a lane in the **semi-private 8-lane
VIP section** for a **2.5-hour window starting at each remaining 2026 World Cup match kickoff**,
match on the **NeoVerse LED video walls**, **chips & salsa included**, **shoe rental extra**
($5/pair), at **normal VIP pricing**: **$112.50/lane Mon–Thu, $137.50/lane Fri–Sun**
(= 1.5-hr + 1-hr VIP rates). Both HeadPinz centers are built; **launch = Fort Myers only**
(Naples LED wall unverified — its flag ships OFF). Feature fully self-hides after the July 19
final. Tournament is knockout-stage NOW — ship-fast beats general.

## Owner decisions (locked 2026-07-03)

1. Window **2.5 h** from kickoff (150-min QAMF Time option; new option ids from ops — placeholders).
2. **All remaining matches** sellable; past kickoffs auto-hide.
3. Marketing = **/book/v2 tile + site-wide popup**; NO /world-cup page; NO middleware changes.
4. **Per-center kill switches** honored by tile, picker, AND server reserve (fail-closed).
5. **Popup must not appear before 2026-07-05 00:00 ET** (USA250 popup runs through 7/4 and
   self-expires at that exact instant). The tile is NOT delayed.
6. Launch config: FM flag on, `NEXT_PUBLIC_WORLD_CUP_VIP_NAPLES_ENABLED=false`.
7. Branch `feat/world-cup` off latest `main`; one PR, one purpose.

## Fixture data (single source of truth — 16 matches, all ET, all kickoffs on the hour)

| id | round | dateEt | kickoffHourEt | teams (null → "Teams TBD") |
|---|---|---|---|---|
| r16-1 | Round of 16 | 2026-07-04 | 13 | Canada vs Morocco |
| r16-2 | Round of 16 | 2026-07-04 | 17 | Paraguay vs France |
| r16-3 | Round of 16 | 2026-07-05 | 16 | Brazil vs Norway |
| r16-4 | Round of 16 | 2026-07-05 | 20 | England vs Mexico |
| r16-5 | Round of 16 | 2026-07-06 | 15 | Portugal vs Spain |
| r16-6 | Round of 16 | 2026-07-06 | 20 | USA vs Belgium |
| r16-7 | Round of 16 | 2026-07-07 | 12 | null |
| r16-8 | Round of 16 | 2026-07-07 | 16 | null |
| qf-1 | Quarterfinal | 2026-07-09 | 16 | null |
| qf-2 | Quarterfinal | 2026-07-10 | 15 | null |
| qf-3 | Quarterfinal | 2026-07-11 | 17 | null |
| qf-4 | Quarterfinal | 2026-07-11 | 21 | null |
| sf-1 | Semifinal | 2026-07-14 | 15 | null |
| sf-2 | Semifinal | 2026-07-15 | 15 | null |
| 3rd-1 | Third Place | 2026-07-18 | 17 | null |
| final | Final | 2026-07-19 | 15 | null |

Constants: `WORLD_CUP_WINDOW_MINUTES = 150` · `WORLD_CUP_POPUP_STARTS_AT_MS =
Date.parse("2026-07-05T00:00:00-04:00")` · `WORLD_CUP_ENDS_AT_MS =
Date.parse("2026-07-19T17:30:00-04:00")` (final kickoff + window). Team labels are edited in
config as rounds resolve — design so that is the ONLY maintenance. Hours check done: every
window fits both centers (Sun–Thu close 12 AM, Fri–Sat 2 AM; latest window ends 11:30 PM Sat 7/11).

## Verified architecture you build on (all claims source-verified 2026-07-03)

- Bowling experiences are **Neon DB rows** (`bowling_experiences` / `bowling_experience_offers` /
  `bowling_experience_items` / `bowling_experience_duration_options` / `bowling_square_products`,
  types + queries in `apps/web/lib/bowling-db.ts`), surfaced by `GET /api/bowling/v2/experiences`.
- `buildLineItems` (`apps/web/src/components/features/booking/steps/bowling/BowlingOfferStep.tsx`
  ~230–259): primary item (sortOrder 0) qty = `qty × laneCount × durationMultiplier` for
  `kind:"hourly"`; **non-primary items × laneCount**; `laneCount = ceil(playerCount/6)`.
  Option precedence (line ~288): `durationOpt?.qamfOptionId ?? exp.qamfOptionId ?? slot.optionId`.
  An hourly experience with ZERO duration-option rows renders no duration picker and books with
  the offer row's `qamf_option_id` — this is the required fixed-duration pattern
  (lessons.md "Open Pkg Duration Bug": NEVER rely on `slot.optionId`).
- **v2 checkout reserves through `unifiedReserve`** (`apps/web/src/features/booking/service/unified-reserve.ts`)
  via `POST /api/booking/v2/reserve-all` — deposit charge happens BEFORE the bowling QAMF loop, so
  pre-charge validation belongs there (credit-validation precedent ~line 529).
  `/api/bowling/v2/reserve` is a secondary reachable path — guard it too (belt-and-suspenders).
- `insertBowlingReservation` already accepts `bookingMetadata` (bowling-db.ts ~912/945) —
  unified-reserve just doesn't pass it yet. Neon line labels come from client
  `item.lineItems[].label` (unified-reserve ~1030); the confirmation email's experience label is
  the **first non-shoe Neon line label** (`app/api/notifications/bowling-confirmation/route.ts`
  ~247–254) — putting the match name on the primary line label reaches the email automatically.
- QAMF title/notes: "VIP Exp." title-prefix precedent unified-reserve ~1065–1067; final PATCH
  ~1119 sends Title+Notes together (required — a Title-only PATCH wipes Notes).
- Availability: `GET /api/bowling/v2/availability` targeted mode takes `hour`+`minute`
  (`windowMinutes` min 15), floors today's probes at now+15 min, and filters to the DB-known
  offer ids for that date's day-of-week. Hold: `POST /api/bowling/v2/reserve/hold`
  (`comboBowlingPatch`/`selectSlot` in `~/features/combos/combo-booking.ts` ~413–500 is the
  proven kickoff-pinned pattern to mirror).
- Chips & salsa `LHZXWYO72N5QFX4CGYKRVPZX` is a seeded $0 product at both centers AND already in
  `KITCHEN_CATALOG_IDS` (`apps/web/lib/bowling-lane-open.ts`) → routes to the kitchen at lane-open.
- Shoes: `SHOES_INCLUDED_SLUGS` (`BowlingShoesStep.tsx` ~219) — world-cup slugs stay **OUT** →
  paid $5/pair step appears; the reserve staff note automatically reads "SHOES NOT INCLUDED".
- Flags house pattern: `process.env.NEXT_PUBLIC_COMBO_RACE_BOWL_ENABLED !== "false"`
  (combo-specials.ts ~180). Statsig does not exist yet.
- Popup precedent: `apps/web/components/Usa250PromoPopup.tsx` (hydration-safe, sessionStorage
  dismissal, live self-expiry timer), mounted on `app/page.tsx`, `app/hp/page.tsx`,
  `app/hp/fort-myers/page.tsx`, `app/hp/naples/page.tsx`.
- Centers: `CenterCode "fort-myers" | "naples"` → QAMF 9172/3148, Square location/center_code
  `TXBSQN0FEKQ11` / `PPTR5G2N0QXF7`; taxes FM Lee 6.5% / Naples Collier 6.0% (order-scope).
- **Seed trap:** do NOT copy `upsertOffer` from `scripts/seed-bowling-experiences.ts` — it
  conflicts on a DROPPED constraint `(center_code, qamf_web_offer_id)`. Model offer upserts on
  `upsertBowlingExperienceOffer` (bowling-db.ts ~2687): conflict target `(experience_id, center_code)`.
  Multiple experiences legally share one web offer (fun-4-all shares 155/119 with vip-mon-thur).

## Design — files to CREATE

### 1. `apps/web/src/features/world-cup/fixtures.ts`
`WorldCupFixture { id; round; dateEt; kickoffHourEt; teams: string | null }` + the 16-row table
above + constants + pure helpers (client- and server-importable, no deps):
`fixtureLabel(f)` ("USA vs Belgium" ?? "Quarterfinal — Teams TBD", plus day/time formatting) ·
`weekendBand(dateEt): "mon-thur" | "fri-sun"` (dow 5/6/0 → fri-sun) ·
`worldCupSlugForDate(dateEt)` → `world-cup-vip-mon-thur | world-cup-vip-fri-sun` ·
`upcomingFixtures(nowMs)` (cutoff = kickoff − 15 min; availability can't probe closer than now+15) ·
`findFixture(id)` · `fixtureMatchesBookedAt(fixture, bookedAtIso)` (exact ET date + hour, minute 0 —
mirror the ET-minutes handling in `availability-client.ts`) · `worldCupWindowActive(nowMs)` ·
`worldCupPopupActive(nowMs)`.

### 2. `apps/web/src/features/world-cup/flags.ts`
```
MASTER = NEXT_PUBLIC_WORLD_CUP_VIP_ENABLED !== "false"
FM     = NEXT_PUBLIC_WORLD_CUP_VIP_FM_ENABLED !== "false"
NAPLES = NEXT_PUBLIC_WORLD_CUP_VIP_NAPLES_ENABLED !== "false"
worldCupCenterEnabled(center) — master && per-center; null/unknown center → false
worldCupEnabledCenters(): CenterCode[]
```
This ONE helper gates: tile, popup, BookingFlow seeding, WorldCupMatchStep, and BOTH server
guards. `NEXT_PUBLIC_*` is inlined client-side and readable server-side — flip = Vercel env +
redeploy (accepted, same as combo kill switch).

### 3. `apps/web/src/features/world-cup/service.ts`
`isWorldCupBowlingItem(item)` (slug prefix `world-cup-`; plus catalog-id check when the dedicated
catalog ids are configured) · `validateWorldCupBooking({ center, bookedAt })` → throws typed
`WorldCupReservationError` unless center enabled AND `bookedAt` exactly matches a fixture kickoff
AND kickoff is in the future; returns the fixture · `worldCupQamfTitle(fixture, guestName, players)`
(`World Cup {name} ({n}p)` — "VIP Exp." precedent) · `worldCupQamfBanner(fixture)`
(`*** WORLD CUP: USA vs Belgium — Mon 7/6 8:00 PM (2.5-hr window) ***`). Validation is
config-driven (server's own fixture file is the authority), fail-closed.

### 4. `apps/web/src/features/world-cup/index.ts` — barrel.

### 5. `apps/web/src/components/features/booking/steps/bowling/WorldCupMatchStep.tsx`
Replaces Slots+Tier+Offer for world-cup items (see registry change below). Behavior:
- Center from `item.qamfCenterId ?? qamfCenterIdForCode(session.center)`; if
  `!worldCupCenterEnabled` → friendly "not available at this location right now" notice, blocked.
- Fetch experiences once, keep the two `world-cup-*` rows; band prices from `items[0].priceCents`
  (DB-authoritative). Render `upcomingFixtures(now)` as date-grouped cards: round badge,
  `teams ?? "Teams TBD"`, kickoff, `$/lane` for the band, lane summary
  ("3 lanes · $412.50 + tax"). `@tabler/icons-react` only (NO emoji), gold/VIP styling per
  BowlingTierStep, mobile-first single column ("bowling center", never "alley").
- On tap (mirror `selectSlot` + `comboBowlingPatch` — do NOT reuse BowlingOfferStep's
  earliest-in-hour/widening/VIP-upsell logic):
  1. Targeted probe at the exact kickoff (`hour`, `minute=0`, `windowMinutes=15`); require a slot
     whose `bookedAt` ET-equals kickoff for `exp.qamfWebOfferId`; if `availableTimeOptionIds` is
     non-empty it must include `exp.qamfOptionId`. No exact slot → card shows "Sold out" — NEVER
     offer a shifted time.
  2. `POST /api/bowling/v2/reserve/hold` with `optionId: exp.qamfOptionId` (150-min; never
     `slot.optionId`), `optionType "Time"`, `service "BookForLater"`.
  3. Dispatch `setBowlingHold` + patch item: `date, hour, minute 0, bookedAt, tier "vip",
     experienceId/Slug, webOfferId, optionId, optionType, durationMinutes 150,
     durationMultiplier 1, laneCount, lineItems, rawItems [], hasBookingFee true,
     worldCupMatchId: fixture.id`. lineItems: every experience item × laneCount; PRIMARY line
     label = `` `${ei.label} — ${fixtureLabel(fixture)}` `` (rides Neon → email/receipt; price/catalog
     id stay product-sourced).
- Probe on tap only (no board-wide pre-probe — ~48 QAMF calls). `canAdvance` same as OfferStep
  (`webOfferId && bookedAt && qamfReservationId`).

### 6. `apps/web/src/components/features/world-cup/WorldCupVipPopup.tsx`
Clone `Usa250PromoPopup` lifecycle exactly (nothing pre-hydration; sessionStorage key
`world-cup-vip-2026`; live show/hide timers). Visible only when `worldCupPopupActive(Date.now())`
AND `worldCupEnabledCenters().length > 0`. Art: `/promo/world-cup/neoverse-vip.jpg` (committed on
this branch — the real VIP-lanes-with-match photo; generate an optimized web-size variant if
easy, else serve as-is like USA250's PNG). Copy direction: "World Cup VIP Bowling — watch every
knockout match on our massive NeoVerse LED walls · 2.5-hour VIP lane from kickoff · chips & salsa
included · shoes extra". CTA default `/book/bowling/v2?experience=world-cup&location=fort-myers`.
Tabler icons, a11y per the USA250 component (`modalBackdropProps`, aria, focus close).

### 7. `apps/web/scripts/seed-world-cup-vip.ts`
Idempotent standalone seed (pattern: seed-bowling-experiences.ts but with the CORRECT offer
conflict target — see trap above). Hard-fail with a clear message if ANY placeholder is unset.
Inputs (constants or env — builder's choice, documented in the header):
```
WC_CAT_MON_THUR  = Square variation id "World Cup VIP Match Window / Mon-Thur $112.50"  (TBD ops)
WC_CAT_FRI_SUN   = Square variation id "World Cup VIP Match Window / Fri-Sun  $137.50"  (TBD ops)
QAMF: DONE — dedicated offers + 150-min option ids all in the seed (live-tested 7/3):
  FM Mon-Thur 175/opt 1397 · FM Fri-Sun 174/opt 1389 (VERIFIED: kickoff-time holds → VIP lane →
  deleted) · Naples Mon-Thur 141/opt 1125 · Fri-Sun 139/opt 1109 (offers enabled but holds 409
  "LanesNotAvailable" — Conqueror lane mapping missing; fix + re-verify before Naples flag-on).
```
Writes (upserts): 4× `bowling_square_products` (both centers × both variations, product_kind
'hourly', price 11250/13750, deposit_pct 100); 2× `bowling_experiences`
(`world-cup-vip-mon-thur` days {1,2,3,4} sort 60 / `world-cup-vip-fri-sun` days {5,6,0} sort 61 —
both label "World Cup VIP Bowling", kind 'hourly', is_vip TRUE, is_active TRUE, description
"Watch the match on the NeoVerse LED video walls from the semi-private VIP suite — a 2.5-hour
lane starting at kickoff, chips & salsa included. Shoes not included."); 4×
`bowling_experience_offers` (`ON CONFLICT (experience_id, center_code)`); per-experience items
(delete-then-insert): `[{WC_CAT_*, qty 1, sortOrder 0}, {CHIPS_SALSA
LHZXWYO72N5QFX4CGYKRVPZX, qty 1, labelOverride "VIP Chips & Salsa", sortOrder 1}]`.
**Deliberately NO duration-option rows** (fixed 150-min via offer-row option id — load-bearing).
Print the post-tournament kill SQL in the closing log.
**FALLBACK MODE (documented in header, selectable by a constant):** if Square catalog ops is
blocked, seed items instead as the two existing VIP rate products
(Mon–Thu: `BESYYLCKLOVD7YE4GYJU24HR` $67.50 primary + `PI67DZQJVGR5EIXEWLB2ELOJ` $45 secondary;
Fri–Sun: `UFD6XVXU6GKCIRCLRUFLSKMJ` $82.50 + `OSOZ7RJ6WW7G4CEFL55U7LXF` $55) + chips — same
per-lane math (verified against buildLineItems: primary ×lanes×1, secondary ×lanes), two-line
receipt, no new Square objects. Owner picks mode at seed time.

## Design — files to MODIFY

1. `apps/web/src/features/booking/state/types.ts` — `BowlingItem`: add `isWorldCup: boolean` +
   `worldCupMatchId: string | null`; default `false`/`null` in `newItem`. (Additive — old
   persisted sessions hydrate `undefined` → falsy. Never read raw sessionStorage.)
2. `entry-context.ts` + `parse-entry-context.ts` — `worldCup?: true`, parsed from
   `?experience=world-cup` ONLY (unknown values stay ignored); extend `parse-entry-context.test.ts`.
3. `BookingFlow.tsx` seeding effect (~195, combo-spread precedent ~136–140): when
   `activity==="bowling" && entry.worldCup && worldCupCenterEnabled(center) &&
   worldCupWindowActive(now)` seed `{ ...newItem("bowling"), variant:"hourly", tier:"vip",
   isWorldCup:true }`; otherwise fall through to a plain bowling item (stale links degrade
   gracefully). Discriminate `alreadyInCart` on `isWorldCup` both ways. NEVER release vendor
   holds from seed effects (teardown-intent lesson).
4. `steps.ts` — insert `WorldCupMatchStep` after `BowlingPlayersStep`; wrap `BowlingSlotsStep`,
   `BowlingTierStep`, `BowlingOfferStep` in a `hiddenForWorldCup()` combinator mirroring
   `hiddenInCombo` (compose with it). Contact/Players/Shoes untouched; Food already self-hides
   (pizza-bowl slug gate). KBF registry untouched.
5. `BowlingTierStep.tsx` + `BowlingOfferStep.tsx` — unconditional one-line filter in the
   experiences-fetch: drop `slug.startsWith("world-cup-")` (the rows must never surface in the
   stock wizard where any-hour booking would be wrong).
6. `unified-reserve.ts` — (a) pre-charge guard beside the credit validation (~529): for each
   bowling item with `isWorldCupBowlingItem`, run `validateWorldCupBooking`; also require
   `item.optionId != null`; typed error → 409 in `app/api/booking/v2/reserve-all/route.ts`
   (one `instanceof` branch). (b) bowling loop: pass
   `bookingMetadata: { worldCup: { matchId, round, label, kickoffEt } }` (server re-derives
   round/label via `findFixture` — never trust client labels for metadata) to
   `insertBowlingReservation`. (c) staff visibility: title via `worldCupQamfTitle`, unshift
   `worldCupQamfBanner(fixture)` onto the notes parts (final PATCH already sends Title+Notes
   together — keep it that way).
7. `app/api/bowling/v2/reserve/route.ts` — same guard after products load (~415), keyed off
   world-cup slug/catalog ids; pass the same bookingMetadata to its `insertBowlingReservation`
   (~1257). Secondary path, cheap belt-and-suspenders.
8. `app/book/v2/page.tsx` — compute enabled centers ∩ current center; when brand is HeadPinz AND
   `worldCupWindowActive` AND non-empty, pass `worldCup: { href:
   "/book/bowling/v2?experience=world-cup&location=<center ?? first-enabled>" }` to PromoLanding.
   Launch behavior: tile on headpinz.com/book/v2 (center null → FM) and ?location=fort-myers;
   NO tile for ?location=naples (flag off); no tile on FastTrax-brand landing.
9. `PromoLanding.tsx` — `worldCup?: { href } | null` prop + inline `WorldCupCard` between combos
   and the attraction grid: premium double-width (`sm:col-span-2`), gold accent, hero
   `/promo/world-cup/neoverse-vip.jpg`, "World Cup VIP Bowling", bullets (2.5-hr window from
   kickoff · NeoVerse LED walls · chips & salsa included · shoes extra), "$112.50/lane Mon–Thu ·
   $137.50/lane Fri–Sun", CTA "Pick Your Match". Tabler icons only.
10. Popup mounts — add `<WorldCupVipPopup />` beside `<Usa250PromoPopup />` on `app/page.tsx`,
    `app/hp/page.tsx`, `app/hp/fort-myers/page.tsx`, `app/hp/naples/page.tsx` (FM-targeted
    default href at launch). Date gates make USA250 overlap impossible.
11. Tests — `fixtures.test.ts` (16 rows, band mapping incl. Sunday→fri-sun, cutoff math, window +
    popup gates, `fixtureMatchesBookedAt` against QAMF-style ISO offsets), `service.test.ts`
    (validation accept/reject: disabled center, wrong hour, past kickoff, valid), entry-context
    parse, step-visibility (worldCup item hides Slots/Tier/Offer + shows match step; normal item
    unchanged), line-item math for BOTH seed modes (dedicated item + fallback bundle) × lanes ×
    bands = $112.50/$137.50 per lane.

## Builder scope (cloud session) — HARD LIMITS

- Work ONLY on branch `feat/world-cup`. Implement this spec; read the verified files before
  editing them; mirror existing idioms/comment density. Plain additive changes to the normal
  bowling flow only (the wrappers/filters above) — the stock wizard must behave identically.
- Run before each push: vitest (`npm run test -w fasttrax-web` or turbo test), typecheck
  (`npx turbo run typecheck`), build (`npx turbo run build`). Never `--no-verify`. Logical commits.
- **DO NOT:** run any seed against any database; call QAMF/Square/Neon/BMI; add dependencies or
  component kits (no Shadcn); touch middleware.ts, pricing/quote/deposit/lane-open code, combo
  registry, KBF flow, or unrelated files; use emoji in UI (use `@tabler/icons-react`); write
  "bowling alley" anywhere (always "bowling center"); read `process.env` in new client code
  outside the flags module.
- The seed script ships as CODE with loud placeholders — running it is a local human step.
- Finish = branch pushed green + a PR-description file `tasks/world-cup-pr-body.md` (title,
  summary, test evidence, the ops/seed/flag follow-ups checklist) — the PR itself is opened
  from the pushed branch by the owner/local session (no gh CLI locally).

## Local follow-ups (NOT the cloud builder's job)

1. Square ops: create catalog item "World Cup VIP Match Window (2.5 Hrs)" with Mon–Thur $112.50 /
   Fri–Sun $137.50 variations, present at all locations, same category/tax setup as
   `BESYYLCKLOVD7YE4GYJU24HR` → 2 variation ids. (Or choose seed FALLBACK MODE: zero Square ops.)
2. QAMF ops: COMPLETE for Fort Myers (live-verified 7/3 — offers 175/174 with 150-min options
   1397/1389 create kickoff-time holds on a VIP lane; test holds deleted). Naples REMAINS:
   offers 141/139 (options 1125/1109, already seeded) 409 "LanesNotAvailable" on every hold —
   attach the offers to the VIP lane group/schedule in Conqueror, then re-verify one hold
   before flipping `NEXT_PUBLIC_WORLD_CUP_VIP_NAPLES_ENABLED`.
3. Run `seed-world-cup-vip.ts` against prod Neon; verify via
   `GET /api/bowling/v2/experiences?centerCode=TXBSQN0FEKQ11` (2 rows, offer option ids set,
   durationOptions empty).
4. Vercel env `NEXT_PUBLIC_WORLD_CUP_VIP_NAPLES_ENABLED=false` BEFORE merge; merge + deploy.
5. Live smoke FM (one real end-to-end booking, then refund/void per usual): match picker correct
   band prices + past matches hidden → hold lands at kickoff exactly, 150 min, VIP lane →
   Conqueror shows Title "World Cup …" + banner + SHOES NOT INCLUDED → Square day-of order lines
   (× lanes) + chips $0 + shoes + fee; deposit = eGift card = tax-inclusive total → Neon
   `booking_metadata.worldCup` present → confirmation email shows the match. Negative: Naples
   fully dark (no tile, no step, doctored reserve-all replay 409s pre-charge); popup absent
   before 7/5; normal bowling wizard unchanged; quote guard intact.
6. Naples later: verify wall → ops ids → re-run seed → flip env → redeploy → Naples smoke.
7. Post-final (7/19 17:30 ET): everything self-hides; then
   `UPDATE bowling_experiences SET is_active=FALSE WHERE slug LIKE 'world-cup-%'` + cleanup PR.
8. As rounds resolve: edit `teams` labels in fixtures.ts (config-only commit).

## Known risks (accepted)

- Conqueror may not allow adding options to live offers → fallback new web offers (designed in).
- If QAMF availability omits the new option id while it's genuinely bookable, cards read
  sold-out — launch smoke catches it; mitigation = drop the `availableTimeOptionIds` gate (the
  hold attempt is the true arbiter).
- Admin reschedule tooling can move a booking off-kickoff (staff action) — out of scope.
- 8 VIP lanes are shared inventory with normal VIP bookings — sellouts are real and correct.
