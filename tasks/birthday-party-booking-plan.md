# HeadPinz Birthday Parties — Online Booking (PLAN)

**Status:** PLAN ONLY — no implementation on this branch. Branch `feat/party-catalog` carries this
write-up so a future session can pick it up at PR-P1.
**Source:** `HeadPinz_Party_FAQs_Flow_Timeline_1.pdf`, revision of 2026-08-06 (owner-supplied FAQs,
staff intake script, and two run-of-show timelines).
**Owner decisions captured:** data model, pricing model, arena inventory, and manage-surface scope
are all settled — see § 2.
**Grounded against:** the files linked throughout were read, not grepped. Where something is
inferred rather than verified, it says so.

---

## 1. Problem

A HeadPinz birthday party cannot be booked online. The two `/birthdays` marketing pages
([fort-myers](../apps/web/app/hp/fort-myers/birthdays/page.tsx),
[naples](../apps/web/app/hp/naples/birthdays/page.tsx)) publish a complete Bronze/Silver/VIP ×
2/4/6-lane price matrix, but "Book This Package" opens
[SalesLeadForm.tsx](../apps/web/components/SalesLeadForm.tsx) — a lead that goes to Pandora, a
planner's Teams chat, and BMI Office private notes. Every party is then quoted, contracted, and paid
by staff through the group-function rail (`app/contract/[shortId]/`).

Goal: self-serve booking — package → real availability → guest count → food → add-ons → birthday
child → contact → policies → 50% deposit → confirmed, with the balance auto-charged at T-72h and the
events team notified automatically.

Two things make this tractable and one makes it genuinely hard:

- **Tractable:** the QAMF lane rail is mature — hold → deposit gift card → day-of order → lane-open
  KDS → settle crons → ops board. And `bowling_square_products.deposit_pct` already drives
  fractional deposits; every row is merely *seeded* at `100` today
  ([seed-bowling-products.ts](../apps/web/scripts/seed-bowling-products.ts)).
- **Tractable:** the group-function rail proves the 50%/T-72h pattern in production, and
  [card-vault/service.ts:241](../apps/web/src/features/card-vault/service.ts) `chargeSavedCard` is
  documented as "modeled on the group-balance-charge cron's saved-card payment" — the reusable
  extraction already happened.
- **Hard:** a party consumes **two** resources (lanes *and* gel-blaster arena seats). No existing
  flow books both. `BowlingItem.attractionAddons` is declared at
  [state/types.ts:472](../apps/web/src/features/booking/state/types.ts), initialized `[]`, read once
  in [service/bowling.ts:332](../apps/web/src/features/booking/service/bowling.ts) — and **never
  populated by any step** (see the "Attractions step removed" comment at
  [state/steps.ts:279](../apps/web/src/features/booking/state/steps.ts)). Parties are its first real
  consumer.

---

## 2. Decisions locked (owner, 2026-08-06)

| Decision | Choice |
|---|---|
| Data model | `bowling_reservations` row, `product_kind='party'`, plus a new party balance rail |
| Pricing | **Per lane block** — keep the published prices; guest count only *suggests* the lane tier |
| Arena | **Reserve real** BMI gel-blaster / laser-tag seats at booking |
| Manage v1 | Read-only confirmation/status page; all changes by phone via admin reservation-edit |

### Why not `group_function_quotes`

It has no lane inventory and no real-time availability — the whole point of self-serve. Worse,
`bmi_reservation_id TEXT NOT NULL` and `hermes_center TEXT NOT NULL`
([group-function-db.ts:30-33](../apps/web/lib/group-function-db.ts)) would force synthetic values
into a table where **all 11 `group-*` crons select with no origin discriminator** —
`group-quote-dispatch`, `group-quote-sync`, `group-dayof-pay`, `group-dayof-close`,
`group-96hr-reminder`, `group-resign-reminder`, `group-7day-waiver`, `group-event-reminders`,
`group-balance-charge`, `group-balance-link-reconcile`, `group-square-settled-close` — and would
immediately start acting on party rows, trying to sync a BMI project that does not exist.

### Why per-lane-block pricing (and the FAQ contradiction it exposes)

The published matrix is exactly 2× and 3× the 2-lane price, i.e. priced per *pair* of lanes:

| Package | 2 lanes | 4 lanes | 6 lanes |
|---|---|---|---|
| Bronze | $349 | $698 | $1,047 |
| Silver | $429 | $858 | $1,287 |
| VIP | $649 | $1,298 | $1,949 |

The FAQ says "You'll be billed for the guaranteed count or actual attendance, whichever is higher" —
which only means something if price scales per guest. Under block pricing, 13 guests and 24 guests
both pay the 4-lane price, so that sentence is **not true as written**. It is inherited from the
group-event policy. Correct rule to publish instead: *the block covers up to 6 guests per lane; more
guests than your lanes hold means moving up a lane tier.* This FAQ answer must be rewritten as part
of PR-P8 — it is a factual defect in guest-facing copy, not a wording preference.

---

## 3. Architecture

One party = one `bowling_reservations` row.

```
bowling_reservations
  product_kind        = 'party'
  qamf_reservation_id   real 2/4/6-lane QAMF hold, PATCHed to Confirmed
  square_gift_card_id   eGift holding the 50% deposit, topped to 100% at T-72h
  dayof_order_id        full tax-inclusive Square order, left OPEN until lane-open
  booking_metadata.party = { packageSlug, guestCount, laneCount,
                             foodChoice, sodaChoices[], dietaryNote,
                             addOns[], tableclothColor, bringingOwnCake,
                             birthdayChild { name, age },
                             arenaSessions[], bmiProjectId }
  + balance_* columns (new, additive)
```

Money flow, unchanged from the proven bowling/GF pattern: deposit → internal eGift card holding
*exactly* the deposit cents → at T-72h load the remaining 50% onto the **same** card → at lane-open
the day-of order is paid in full from that card. No tax-rounding mismatch, and a cancellation refund
comes off a card whose balance is exact.

**Hard constraint — no rollback exists.** The deposit is *captured* inside
`createDepositAndCharge` (payOrder), and `rollbackDeposit` was deliberately removed 2026-06-07
([service/deposit.ts:879-885](../apps/web/src/features/booking/service/deposit.ts)):
`/payments/{id}/cancel` 4xx's and cannot reverse it. Recovery is **forward-only** via a durable
`confirm_pending` anchor row. Persist the anchor **before** any vendor confirm; never design a step
that assumes money can be un-charged.

---

## 4. PR breakdown

### PR-P1 — Party catalog (single source of truth)

The price matrix currently lives as **display strings** (`"$1,047"`) inside two 994-line
`"use client"` components. Verified by diff: the two files differ in **exactly 5 lines** — breadcrumb
URLs (L357-358), phone (L947/955), and `centerKey` (L980). `packages`, `foodOptions`, `addOns`,
`includedItems`, `faqs`, `valueProps`, and `galleryImages` are **byte-identical duplicates**. Every
price is therefore written twice, by hand, with nothing keeping them in sync — and nothing a booking
flow can read.

- **New** `apps/web/src/features/parties/catalog.ts`:
  - `PARTY_PACKAGES` — `slug` (`bronze`|`silver`|`vip`), `name`, `accent`, `badge`,
    `priceCentsByTier: Record<2|4|6, number>` **keyed per center** (FM and Naples are identical
    today; the override dimension must exist from day one), `partyMinutes`, `bowlingMinutes`,
    `gelBlasterSessionsPerGuest`, `tokensPerGuest`, `includes[]`, `sortOrder`.
  - Prices as **integer cents**; `formatUsd()` derives `"$1,047"`. A display string is never authored.
  - `requiresWaiver` — **derived**, not authored: `gelBlasterSessionsPerGuest > 0`. Bronze is
    `false` per the 2026-08-06 revision (see § 5).
  - `PARTY_FOOD_CHOICES`, `PARTY_ADD_ONS` (id + label + description; **no price** — see § 7),
    `PARTY_INCLUDED_ITEMS`, `PARTY_TABLECLOTH_COLORS = ["Black","Blue","Green","Red","White"]`,
    `GUESTS_PER_LANE = 6`, `PARTY_LANE_TIERS = [2,4,6]`.
  - `partyLaneTier(guests)` — `ceil(guests / 6)` rounded up into `[2,4,6]`, returning `null` above
    36 so callers route to Group Events instead of inventing an 8-lane tier. Note
    `bowlingLaneCount()` ([service/bowling-offer.ts:24](../apps/web/src/features/booking/service/bowling-offer.ts))
    is a bare `ceil(players/6)` with no 2/4/6 rounding — parties need their own resolver.
  - `PARTY_TIMELINES` — the two published run-of-show tables as data (offset minutes + label +
    owner). They drive the ambassador recap in the staff notification (PR-P7) and the **T+30 food
    fire offset** the day-of work needs, so they belong in code, not only in an SOP doc.
- Both `/birthdays` pages render from the catalog. **Keep** the inline SVG icon maps (keyed by
  food/add-on id) and the presentational `valueProps` / `galleryImages` arrays in the pages — this PR
  is about the data a booking flow needs, not a cosmetic rewrite. Zero visual change.
- **Neon seed** `scripts/seed-party-products.ts`, modeled on
  [seed-bowling-products.ts](../apps/web/scripts/seed-bowling-products.ts) (same manual `.env.local`
  loader, `neon()`, upsert shape, and the same **`is_active = FALSE` until ops links QAMF web offer
  ids** convention that script documents at its L9-13). Ship a `--dry-run` flag:
  - `bowling_square_products`, `product_kind='party'`, **`deposit_pct = 50`** — 3 packages × 3 lane
    tiers × 2 centers = 18 rows. The schema default is `100`
    ([seed-bowling-products.ts:299](../apps/web/scripts/seed-bowling-products.ts)), so this must be
    explicit and re-queried after seeding.
  - `product_kind='addon_party'` rows for the four add-ons, `is_active = false`, `price_cents = 0`.
    Ops activates via the existing `upsertBowlingSquareProduct` admin endpoint.
  - `bowling_experiences` + `bowling_experience_offers` per package/center carrying
    `duration_minutes` and the QAMF `web_offer_id` / `qamf_option_id`. **Duration is authoritative
    from our DB, never QAMF's `Minutes`** — `assertBookable` and `duration-feasibility` window-check
    against it.
  - "Extra Time" (+30 min) as `bowling_experience_duration_options` rows, not an inert line item — it
    genuinely lengthens the lane hold.
- **Square catalog:** one item per package, one variation per lane tier (9 variations), added to `SQ`
  in [square-catalog-map.ts:31](../apps/web/src/features/booking/data/square-catalog-map.ts) and
  mirrored in the seed's `CAT` table. A variably-priced variation **must** send `base_price_money` or
  Square 400s the order (the duckpin lesson —
  [service/bowling.ts:56-68](../apps/web/src/features/booking/service/bowling.ts)).

### PR-P2 — `"party"` activity plumbing

Adding `"party"` to the `Activity` union deliberately breaks compilation at every site that must be
taught about it. Work the compiler errors:

- [types.ts:17](../apps/web/src/features/booking/types.ts) `Activity`; `ActivitySchema` in
  `schemas.ts`.
- `PartyItem` in [state/types.ts](../apps/web/src/features/booking/state/types.ts) extending
  `BookingItemBase` + the lane-bearing `BowlingCommon` shape, plus `packageSlug`, `guestCount`,
  `foodChoice`, `sodaChoices`, `addOns`, `birthdayChild`, `tableclothColor`, `bringingOwnCake`,
  `policiesAcceptedAt`. Add to the `BookingItem` union and to the **exhaustive** `newItem()` switch
  (`case "bowling"` at ~`:802` is the template).
- [state/machine.ts](../apps/web/src/features/booking/state/machine.ts): party items are
  QAMF-vendored, so extend the `addItem` center-stamp, `setCenter`, `setBowlingHold`,
  `clearBowlingHold`, and `setBowlingQuote` predicates. Introduce an `isLaneItem(item)` helper rather
  than growing five more `kind === "bowling" || kind === "kbf"` disjunctions.
- `ReservationProductKind` at [bowling-db.ts:595](../apps/web/lib/bowling-db.ts) and `EditableKind`
  at [reservation-edit/guards.ts:143](../apps/web/src/features/reservation-edit/guards.ts).
  `product_kind` is free `TEXT`, so **no migration** — but audit the queries that enumerate kinds
  (`IN ('open','kbf')` at `:1232`/`:1293`, `IN ('race','attraction')` at `:2241`/`:2271`,
  `= 'kbf'` at `:2434`/`:2483`/`:2518`).
- `ActivityOffering` in
  [activities-catalog.ts](../apps/web/src/features/booking/activities-catalog.ts), `slugToActivity()`
  in `app/book/[attraction]/v2/page.tsx`, and exports in `features/booking/index.ts`.

**Three traps that fail SILENTLY — each must land in this PR:**

1. **[BookingFlow.tsx:332-341](../apps/web/src/components/features/booking/BookingFlow.tsx)** reads
   the hold for `<ReservationTimer>` from `kind === "bowling" || kind === "kbf"` only. Unwidened, a
   party's 10-minute QAMF *Temporary* hold expires with no timer and no extension.
2. **[CheckoutStep.tsx:696](../apps/web/src/components/features/booking/steps/checkout/CheckoutStep.tsx)**
   hardcodes `depositPct: 100` ("bowling is 100% online — no balance"). A 50%-deposit party must not
   inherit that path.
3. **`buildCombinedLineItems`** in
   [service/unified-reserve.ts](../apps/web/src/features/booking/service/unified-reserve.ts) walks
   `session.items` **by kind**. An unhandled party item is **charged $0**.

Also needs teaching: `CartView`, `MiniCartV2`, `service/checkout.ts`, `service/bookable.ts`,
`service/bowling-hours.ts` (`bowlingCartConflicts`), and
`src/features/kiosk/state/registry.ts` — `KIOSK_STEP_REGISTRY` is a `Record` over the same union and
will fail to compile even though parties are web-only in v1.

### PR-P3 — Wizard steps

The intake script maps onto **7 new** `StepDef`s; the rest already exist:

| Step | Implementation |
|---|---|
| Location | existing `CenterPickerModal`, forced when `session.center` is null |
| Package | **new** `PartyPackageStep` |
| Guest count → lanes | **new** `PartyGuestsStep` (incl. the "all guests 17 or under?" gate) |
| Date & time | **new** `PartyTimeStep` (PR-P4 — dual-resource) |
| Food + soda + dietary | **new** `PartyFoodStep` |
| Add-ons | **new** `PartyAddOnsStep` |
| Birthday child + tablecloth + cake | **new** `PartyChildStep` |
| Contact | existing `ContactStep`, verbatim |
| Policies | **new** `PartyPoliciesStep` (age, waiver, payment schedule, cancellation tiers, save-card consent) |
| Pay / review / confirm | existing `CheckoutStep` + `/book/confirmation/v2` |

Follow the `StepDef` contract at
[state/steps.ts:30-64](../apps/web/src/features/booking/state/steps.ts): `canAdvance` returns
`true | { reason }`, and a re-pick **clears downstream fields** (the `AttractionProductStep` pattern
at `:66-75`) so a package change cannot leave a stale lane hold or stale arena seats.

- **Ordering:** guests must precede time — the lane tier determines what availability to query. The
  source document lists the fields in a different order; the *labels* can follow the document but
  availability can only be queried once the guest count is known.
- `PartyFoodStep` is **one choice for the whole party**, not per-lane like
  [BowlingFoodStep.tsx](../apps/web/src/components/features/booking/steps/bowling/BowlingFoodStep.tsx)
  (which builds per-lane pizza modifiers), plus soda choices and a free-text dietary note for the
  kitchen.
- **Keep party steps out of `KIOSK_STEP_REGISTRY`.** Web-only in v1, so the EN+ES i18n hard rule
  (which governs guest-facing *kiosk* copy) does not apply. If parties ever reach the kiosk, every
  string must be keyed in the i18n catalog with Spanish **in the same commit** — including copy that
  lives in data, not just components.

### PR-P4 — Dual-resource availability (the hard part)

A slot is offerable only if **both** hold: N lanes free for the full party duration, **and** enough
arena `freeSpots` for the package's session demand inside the party window.

- **Lanes:** reuse `/api/bowling/v2/availability`. QAMF's availability search is **point-in-time**
  (`Filter.BookedAtRange` requires `StartAt === EndAt`,
  [qamf-bowling.ts:295](../apps/web/lib/qamf-bowling.ts)), so a 2–3 hour party needs the
  duration-feasibility path (`evaluateWindow` / `resolveOptionMinutes`), not a single probe.
- **Arena:** `bmiAdapter.getAvailability({ date, productId, pageId, quantity })` returns
  `proposals[].blocks[]` carrying **`capacity` and `freeSpots`**
  ([data/bmi.ts:47-57](../apps/web/src/features/booking/data/bmi.ts)) — asking BMI for N seats
  directly is supported. Gel blaster is `bookingMode: "per-person"`, `maxGroupSize: 16`, `pageIds`
  `{ headpinz: "24909729", naples: "7583597" }`
  ([attractions-data.ts:96](../apps/web/lib/attractions-data.ts)). Session demand =
  `guestCount × gelBlasterSessionsPerGuest`, split into blocks of ≤16. A 24-guest VIP party is 48
  seats ≈ 4 sessions.
- **New** `GET /api/booking/party/availability` intersects the two and returns only
  fully-satisfiable start times, **each carrying the chosen arena blocks** so the reserve step books
  exactly what was displayed.
- `PartyTimeStep` holds lanes on selection (the `BowlingTimeStep` pattern — `setBusy(true)` →
  `holdBowlingSlot({ previousHoldId })` → `dispatch setBowlingHold` → `onChange`), refreshing the
  grid on a 409 `slot_taken` and **never auto-picking** a replacement.

**Open: lane-hold duration.** The timeline serves food *at the lanes* at 0:30 and runs arcade time
to 1:30, so the lane area is occupied for the full 2h/3h even though bowling is only 1h/1.5h. The
recommendation is to hold lanes for the **full party duration** (never bump a party mid-event) and
carry `bowlingMinutes` separately for the ambassador. This is the more expensive choice on a busy
Saturday — needs GM sign-off.

### PR-P5 — Reserve + 50% deposit

**New** `POST /api/booking/party/reserve`, modeled on
[app/api/bowling/v2/reserve/route.ts](../apps/web/app/api/bowling/v2/reserve/route.ts). Ordering is
non-negotiable — QAMF holds lanes before money, and the anchor row precedes every vendor confirm:

1. Validate + Redis idempotency lock; deterministic `baseKey` so all Square idempotency keys replay.
2. **QAMF:** attach customer → patch title/notes → PATCH status `Confirmed`.
   `setReservationCustomer` **must** precede `setReservationStatus`, or the PATCH 2xx's *without
   changing status* ([qamf-bowling.ts:369-386](../apps/web/lib/qamf-bowling.ts)). Also:
   `BookedAt` needs seconds **and** ms zeroed or QAMF 400s (`normalizeBookedAt`, `:166`).
3. **BMI:** create person + bill, book the arena sessions → populate `attractionAddons`. Use
   `parseWithRawIds` / `stringifyWithRawIds` from `@ft/db` — **never** `JSON.parse` / `Number()` on
   the 17-digit orderId / billLineId. A `: string` annotation does not prevent the corruption. This
   step also yields the `projectId` the waiver link needs.
4. **Square day-of order:** party variation + add-ons + arena lines + ORDER-scope `LOCATION_TAX`.
5. `createDepositAndCharge({ ganPrefix, ganSuffix: qamfId, baseKey })`. The 50% comes from
   `deposit_pct` on the party rows via the weighted `overallDepositPct`, re-based on the
   **tax-inclusive** total. Use `giftCardSaleChunks()`
   ([deposit.ts:66](../apps/web/src/features/booking/service/deposit.ts)) — a 6-lane VIP at $1,949
   plus add-ons crosses Square's $2,000-per-card cap.
6. **Neon anchor** `status: 'confirm_pending'` → promote to `confirmed`. An anchor write failure must
   500 **before** any vendor confirm — never leave captured money without a row.
7. `captureCardFromDeposit({ …, permanentConsent: true })` — **mandatory.** The card-vault sweep
   disables a card ~72h after the reservation ends
   ([card-vault/data.ts:414](../apps/web/src/features/card-vault/data.ts)) unless permanent consent
   is set. A party booked two months out would otherwise have **no card at T-72h**. Requires explicit
   save-card consent copy in `PartyPoliciesStep`.

### PR-P6 — Balance rail (T-72h)

- Additive columns on `bowling_reservations` via the existing `ensureBowlingSchema()`
  `ALTER TABLE … ADD COLUMN IF NOT EXISTS` pattern: `balance_due_cents`, `balance_charged_at`,
  `balance_payment_id`, `balance_attempts`, `balance_decline_code`, `balance_decline_at`,
  `balance_link_url`.
- **One new cron** `/api/cron/party-balance-charge`, `*/15 * * * *`. `apps/web/vercel.json` already
  declares 51 cron entries — add exactly one. Select
  `product_kind='party' AND status='confirmed' AND balance_charged_at IS NULL
   AND booked_at - INTERVAL '72 hours' <= NOW() AND booked_at > NOW()`.
- Charge with `getChargeableCard()` → `chargeSavedCard()` → `loadBalanceOntoGiftCards()` (reused from
  the GF rail); lane-open then pays the day-of order from a now-100% card.
- **Fix the GF cron's bug rather than inherit it.** In
  [cron/group-balance-charge/route.ts](../apps/web/app/api/cron/group-balance-charge/route.ts) a
  decline flips status to `balance_link_sent`, which **permanently removes the row from its own
  `WHERE` clause**; `balance_charge_attempts` is incremented but never read as a cap, so **the card
  is never retried**. Here: keep the row selectable, retry on a backoff to a capped
  `balance_attempts`, and only then fall back to a payment link + dunning.
- Idempotency `party-bal-{neonId}-a{attempt}`. A captured-but-unloaded payment must write a
  persist-first marker and resume **forward**, never re-charge.

### PR-P7 — Comms, waiver, staff notify

- **Confirmation:** `emails/party-confirmation.html` + `/api/notifications/party-confirmation`,
  following the self-contained
  [bowling-confirmation](../apps/web/app/api/notifications/bowling-confirmation/route.ts) pattern
  (fire-and-forget from reserve). Transports are reusable as-is:
  [sendgrid.ts:59](../apps/web/lib/sendgrid.ts) `sendEmail`,
  [sms-retry.ts:326](../apps/web/lib/sms-retry.ts) `voxSend` (Vox → Twilio failover). The GF
  `notify*` builders are all `GroupFunctionQuote`-bound and are **not** usable here.
- **Reminders** (7-day, T-72h balance notice, day-before): the declarative `ReminderRule` engine in
  [group-event-rules.ts](../apps/web/lib/group-event-rules.ts) is a good shape, but its evaluator
  selects `group_function_quotes` only. Rather than a new ledger table, dedup on additive
  `*_sent_at` columns — the native bowling pattern (`pre_arrival_sent_at`, `lane_ready_sent_at`).
  Fold the sends into the `party-balance-charge` run so no second cron is needed. Respect
  `withinQuietHours()` (9am–8pm ET) for SMS.
- **Waiver — now package-dependent.** Per the 2026-08-06 revision a waiver is required only for
  guests "participating in Racing or Laser Tag/Gel Blaster", so **Bronze needs none**. Mint via
  `mintWaiverLinkOrLongUrl()` ([waiver-short-link.ts](../apps/web/lib/waiver-short-link.ts)) keyed on
  the BMI `projectId` from PR-P5 step 3, giving a `/w/{code}` short link plus the organizer roster
  ([features/waiver/roster.ts](../apps/web/src/features/waiver/roster.ts)). The GF rail already
  models this conditionality as `hasWaiverRequiredActivities(line_items)`
  ([bmi-office-actions.ts](../apps/web/lib/bmi-office-actions.ts)) — reuse the idea.
  ⚠ **Verify:** `roster-preload.ts` deliberately excludes *group functions* from rosters. A party is a
  reservation, not a quote, so it should qualify — but this is inferred, not tested. Probe it against
  a real booking before relying on it.
- **Staff notify** (the document's "notifies the venue's events team with the full party recap"):
  `staffRecipientsForCenter()`
  ([staff-recipients.ts:57](../apps/web/src/lib/constants/staff-recipients.ts)) for email +
  `sendAdaptiveCardToChannel()` ([teams-bot.ts](../apps/web/lib/teams-bot.ts)) for a Teams card
  carrying package, date, lanes, guest count, food + soda + dietary note, add-ons, tablecloth color,
  own-cake flag, birthday child + age, and the arena session times. Informational
  (`Action.OpenUrl`), **not** interactive — the `bot-action` verbs are hardcoded to `sales_lead_*`.
  A plain v2 booking notifies staff **nothing** today, so this is new code; model it on
  [world-cup/notify.server.ts:24](../apps/web/src/features/world-cup/notify.server.ts).

### PR-P8 — Cutover, status page, admin board, content

Per the project's mandated v2 cutover pattern — deploy alongside, ops signs off, then redirect, then
delete:

1. Ship the wizard at `/book/party/v2` while the `/birthdays` CTA still opens the lead form. Ops
   books real parties through the preview deployment.
2. Flip the marketing CTA to `/book/party/v2?package=vip&location=fort-myers`. **Keep** the lead form
   for adult birthdays, 20+ guests, and >6 lanes → route to Group Events.
3. Remove the kids-birthday lead path in a third PR.

Kill switch only: `PARTY_BOOKING` defaults **ON** (`!== "false"`). No opt-in gate — per project rule
a merged feature is on; anything not ready to be on stays on a branch and is tested via its preview
deployment.

- **Status page** `/book/party/[code]` — read-only: package, date, lanes, guest count, food, add-ons,
  balance amount + auto-charge date, waiver link (Silver/VIP only), and "Add guests? Call us." It
  lives under `/book`, which `middleware.ts` already excludes from the HeadPinz `/hp` rewrite — **no
  `isSharedTopLevelRoute` edit needed.** Any *other* new top-level path would need one, plus the
  trailing-slash discipline documented there (`startsWith("/x/")`, never `startsWith("/x")`).
- **Admin board** — 7 mechanical touch points:
  1. `KIND_BADGE.party` in
     [reservations-admin/constants.ts:73](../apps/web/src/features/reservations-admin/constants.ts);
  2. the hardcoded `(["kbf","open","race","attraction"] as const)` chip array in `FilterBar.tsx`;
  3. the two-way `r.productKind === "kbf" ? "KBF" : "Open"` ternary in `BoardTable.tsx` (~L172,
     L193-200) **and** `BoardCardList.tsx` — **a party silently renders as "Open" until this is
     fixed**;
  4. a confirmation-URL branch in the admin route's short-code backfill;
  5. `center-scope.ts` / `belongsOnHeadpinzFmBoard`;
  6. label player count as "guests", not "bowlers";
  7. decide party rows vs the existing `GroupEventsSection` lane.
  Party rows use the **Square location id** namespace in `center_code`, matching bowling (race and
  attraction rows store a slug — see `tasks/future/center-code-normalization.md`).
- **Content:** publish the document's FAQ, but **rewrite the guaranteed-count answer** (§ 2), and
  order the checkout as review → pay → confirmed, which is what `CheckoutStep` does.

---

## 5. Source document reconciliation (revision 2026-08-06)

Changes from the prior revision that affect the build:

- **Waiver is no longer universal** — required only for guests "participating in Racing or Laser
  Tag/Gel Blaster". **Bronze needs no waiver.** `requiresWaiver` becomes derived per package.
- **Bronze includes zero gel blaster sessions** — stated explicitly ("Silver = 1 session,
  VIP = 2 sessions, Bronze = none").
- **Soda is now a choice**, not just "unlimited soda"; "sodas out on the table" is step 0:00 in both
  timelines. New captured field.
- **Tablecloth color is a fixed enum:** Black, Blue, Green, Red, White. Not free text.
- **New captured field:** "Will you be bringing your own cake or cupcakes?"
- **Food now serves at 0:30** — 30 minutes after party start, *during* bowling — in both timelines.
  The prior revision served it after bowling wrapped (1:10 / 1:40). This lands squarely on the day-of
  KDS gap: party food must fire **mid-party**, and lane-open is the wrong trigger.
- **Removed** from the document: the 12-step booking-flow narrative, the T-30…T-10 prep table, the
  "After Guests Leave" list, the training-rollout notes, "LED glow lighting" from the
  included-in-every-package list, and the gifts step from both timelines.
- **Added:** a staff intake script, which is effectively the field list for the wizard — including an
  explicit "Are all guests 17 or under?" gate routing adult-hosted parties to Group Events.

### Published timelines (as data for `PARTY_TIMELINES`)

**Bronze / Silver — 2-hour party, 1-hour bowling**

| Offset | What |
|---|---|
| 0:00 | Check-in, shoe rental, seated at lanes; sodas on the table |
| 0:10 | Bowling begins |
| 0:30 | Food served at the lanes |
| 0:40 | *Silver only:* scheduled gel blaster session |
| 1:10 | Bowling wraps |
| 1:30 | Arcade / game zone time |
| 1:45 | Cake |
| 2:00 | Party ends |

**VIP — 3-hour party, 1.5-hour bowling**

| Offset | What |
|---|---|
| 0:00 | Check-in, seated in VIP section; sodas on the table |
| 0:10 | Bowling begins |
| 0:30 | Food served |
| 0:45 | Gel blaster session 1 |
| 1:15 | Back to bowling / lounge |
| 1:40 | Bowling wraps |
| 2:00 | Gel blaster session 2 |
| 2:30 | Arcade / game zone time |
| 2:45 | Cake |
| 3:00 | Party ends |

### Two things NOT silently acted on

- The document drops "LED glow lighting" from the included list, but it is **still live** on both
  `/birthdays` pages (`includedItems`, "LED glow lighting atmosphere"). PR-P1 is a zero-visual-change
  refactor, so the page keeps rendering it. Removing a live marketing claim is a content decision,
  not a refactor.
- **The revision contradicts itself on gel blaster timing.** The VIP timeline puts session 1 at
  **0:45** — bowling runs 0:10–1:40, so mid-bowling — while the accompanying note from Jasmine says
  the first session is "the first 15 minutes **after** the bowling ends," with the second ~30 minutes
  later. These cannot both be right, and the answer determines which arena window PR-P4 must reserve.

---

## 6. Day-of execution — automatable vs SOP

The timeline tables are training material. They belong in `docs/sop/headpinz-birthday-parties.md`,
and the source document itself asks for GM validation before they become an SOP — keep that as an
explicit gate rather than shipping them as fact.

| Timeline item | Status |
|---|---|
| Lanes blocked | **Free** — the QAMF `Confirmed` reservation |
| Food to kitchen at T+30 | **Needs extension.** [bowling-lane-open.ts](../apps/web/lib/bowling-lane-open.ts) routes to KDS by adding a SHIPMENT fulfillment + `"Lane N \|"` note prefixes, but its `KITCHEN_CATALOG_IDS` / `KITCHEN_NAME_RE` allowlists are hardcoded to Pizza Bowl items. Party food ids must be added, **and the fire must be scheduled at T+30, not at lane-open** |
| Game cards loaded with tokens | **Real work.** `loadCard()` ([game-cards/service/load-card.ts](../apps/web/src/features/game-cards/service/load-card.ts)) enforces "FREE LOADS ARE STILL FORBIDDEN" — every load needs a paid or voucher-claimed transactions-log row. A party package needs a new authorization kind (`party_package`) whose paid proof is the party's own day-of order |
| Shoes | Included in the package; surfaces on the day-of order via `syncShoeKdsLineItems` |
| Ambassador assigned + briefed | **Out of scope.** "Ambassador" is marketing prose — no entity, no roster, no scheduling anywhere in the repo. v1 delivers the recap email + Teams card; assignment stays manual |
| Settlement | **Free** — `reservation-status-close` → `completeCheckedInOrders()`, required because Square→QuickBooks only pulls COMPLETED orders |

---

## 7. Open items

**Two block go-live** (neither blocks the build):

1. **Add-on prices do not exist** anywhere in the repo. All four — Extra Laser Tag, Arcade Boost,
   Party Favor Bags, Extra Time — are name + description only in both `/birthdays` pages. Rows ship
   `is_active = false`; the add-ons step cannot render until ops sets prices.
2. **Gel blaster / laser tag pricing conflict.** The HP group-events page prices them at
   **$150 / $200 per arena session (up to 15 guests)**
   (`app/hp/fort-myers/group-events/page.tsx:161-165`), while
   [attractions-data.ts](../apps/web/lib/attractions-data.ts) prices them at **$10–$12 per person**
   (`price: 12` gel blaster, `price: 10` laser tag). The packages say "sessions per guest." One
   authority must win before "Extra Laser Tag" can be priced.

**Needs an owner / GM call:**

3. **Lane-hold duration** — full party duration (recommended) vs bowling duration only. Real Saturday
   capacity cost.
4. **Gel blaster session timing** — the document's internal contradiction (§ 5).
5. **Naples vs Fort Myers prices** are identical today. The catalog carries the per-center override
   dimension from day one; confirm they should stay in lockstep.
6. **Guest minimum.** The lead form enforces 12 for `birthday-kid`
   ([SalesLeadForm.tsx:276](../apps/web/components/SalesLeadForm.tsx)), which matches a 2-lane
   minimum at 6 guests/lane. Confirm the online flow enforces the same floor.
7. **"LED glow lighting"** — keep or drop from the live included-items list (§ 5).
8. **Timeline tables** need GM/ambassador validation before becoming an SOP.

---

## 8. Verification (when PR-P1 is built)

1. **Price parity is the whole point.** Both `/birthdays` pages must render the identical nine prices
   they render today: Bronze $349/$698/$1,047, Silver $429/$858/$1,287, VIP $649/$1,298/$1,949 — in
   the existing card order (VIP renders **second**, badged "MOST POPULAR"). A snapshot test over
   `PARTY_PACKAGES` locks the cents so a future edit cannot silently move a published price.
2. **Unit tests** (`src/features/parties/catalog.test.ts`): `partyLaneTier()` boundaries
   (1→2, 6→2, 7→2, 12→2, 13→4, 24→4, 25→6, 36→6, 37→null); every package's 4-lane price is exactly
   2× and 6-lane exactly 3× the 2-lane price — this encodes the per-lane-block model so a per-guest
   edit fails loudly; `formatUsd()` renders the published strings.
3. `npx turbo run typecheck` + the react-hooks eslint pass (both pages are `"use client"`).
4. `npm run dev -w fasttrax-web`, then visually diff `/fort-myers/birthdays` and `/naples/birthdays`
   against production: prices, package order, badge, food + add-on cards, included-items list.
   Confirm the Naples phone `(239) 455-3755` and FM `(239) 302-2155` survive, and that both
   `SalesLeadForm` `centerKey`s are unchanged — the lead form is still the live CTA at PR-P1.
5. **Seed script `--dry-run` first.** Verify 18 party rows at `deposit_pct = 50` plus the
   `addon_party` rows at `is_active = false`, *then* run for real against a branch/preview database —
   never production — and re-query to confirm `deposit_pct` is 50 and not the schema default of 100.
6. One `npx turbo run build` at the end, a11y gate green.

Later PRs additionally require a **live smoke with a real card** before anything is called done: QAMF
shows a Confirmed N-lane reservation for the full party duration; BMI shows the arena seats; the
day-of Square order is OPEN with correct tax; the eGift balance equals exactly 50%; one `confirmed`
party row with populated `booking_metadata.party`; `reservation_saved_cards` has
`permanent_consent = true`; confirmation email + SMS arrive; the Teams card and staff email land with
the full recap; the waiver link resolves (Silver/VIP) and the roster shows the signer. Then force a
balance decline with a Square test card and confirm it **retries** to the attempt cap before falling
back to a payment link — the specific bug the GF cron has.
