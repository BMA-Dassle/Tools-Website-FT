/**
 * Centralized booking-package registry.
 *
 * One source of truth for every "package" the race-booking flow can
 * sell — Rookie Pack, Ultimate Qualifier, and any future bundle. The
 * product picker, heat picker, cart sync, review hero card, and
 * confirmation page all read from here so adding a new package is a
 * data change, not a UI refactor.
 *
 * Core pieces a package describes:
 *   - which races it bundles (with cross-component heat-gap rules
 *     for things like "Intermediate must be ≥ 60 min after Starter
 *     ends — or 30 if it stays on the same track")
 *   - whether it includes the FastTrax license, POV, and/or a free
 *     appetizer code
 *   - eligibility (racerType, schedule, category)
 *   - pricing — explicit total, or fall back to sum-of-components
 *
 * Intentionally stateless data — every consumer pulls a definition
 * by id (`getPackage`) and reads only the fields it cares about.
 */
import { etOffsetForLocalDate, withinRecurringDayRule, type RecurringDayRule } from "./et-time";
import { isMegaDay } from "~/features/racing/mega-calendar";
import type { MessageKey } from "~/features/kiosk/i18n";

// ── Shared component prices ─────────────────────────────────────────────────
// Stays here so PovUpsell, OrderSummary, the cart sync, and the
// auto-sum helper agree on a single number.

export const LICENSE_PRICE = 4.99;
export const POV_PRICE = 4.99;
// "Retail" anchors for savings comparisons. POV at the counter is
// $2 more per racer than the prepay-online price; the appetizer
// carries a real menu value at Nemo's. Used by the picker card +
// review hero card to show "you save $X".
export const POV_CHECKIN_PRICE = 7;
// $15 menu retail at Nemo's — counted toward the package savings line for any
// bundle carrying an `appetizerCode`. DORMANT since 2026-08-12: no package
// carries one, so this adds nothing to any savings figure today. Kept with the
// gated code paths so re-enabling the offer stays a registry data change.
export const APPETIZER_RETAIL_VALUE = 15;

// ── Types ───────────────────────────────────────────────────────────────────

export type PackageId =
  | "rookie-pack-mega"
  | "rookie-pack-weekday"
  | "rookie-pack-weekday-junior"
  | "rookie-pack-weekend"
  | "rookie-pack-weekend-junior"
  | "ultimate-qualifier-mega"
  | "ultimate-qualifier-weekday"
  | "ultimate-qualifier-weekday-junior"
  | "ultimate-qualifier-weekend"
  | "ultimate-qualifier-weekend-junior"
  // BOGO races — every Wednesday from 2026-08-19 (a one-off 2026-08-12 → EOD
  // 2026-08-13 flash sale before that). These ids must stay in the union even if
  // the promo is ever retired: `getPackageIgnoreFlag` resolves them on the
  // confirmation page for bookings already made, so removing them breaks those
  // pages retroactively.
  | "bogo-weekday"
  | "bogo-weekday-junior"
  | "rookie-pack"; // legacy alias kept for confirmation-page back-compat
export type Schedule = "weekday" | "weekend" | "mega";

/** Per-track product configuration — used inside `PackageRaceComponent.tracks`
 *  for components that span multiple tracks (e.g. weekday Ultimate
 *  Qualifier Starter spans Red + Blue). The heat picker fetches each
 *  track's productId, tags every proposal with its track, and lets the
 *  customer pick any combination at heat-selection time. */
export interface PackageTrackOption {
  track: "Red" | "Blue" | "Mega";
  productId: string;
  pageId: string;
  /** Per-unit price fallback for this track. The picker / cart pull
   *  the authoritative live price from BMI's `/availability` endpoint
   *  at render time — this is just the seed used before that fetch
   *  resolves and the cold-start fallback when BMI is unreachable. */
  price: number;
}

/** Race / qualification tiers. Declared here rather than imported so the
 *  registry stays dependency-free (race-products mirrors the same union). */
export type PackageTier = "starter" | "intermediate" | "pro";

export interface PackageRaceComponent {
  /** 1-indexed sequence — drives the order in PackageHeatPicker. */
  sequence: number;
  /** Stable cross-component reference name (e.g. "starter",
   *  "intermediate"). Used by `minMinutesAfterEndOf` and the heat
   *  picker's "what's the previous heat I picked" lookup. */
  ref: string;
  /** Display label (cart, review, hero card). For multi-track
   *  components the customer-facing label should be track-agnostic
   *  (e.g. "Starter Race") so the heat picker's track badge carries
   *  the track distinction. */
  label: string;
  tier: "starter" | "intermediate" | "pro";
  /** Tracks this component spans. ONE entry → single-track component
   *  (e.g. Mega-only or junior Blue-only). MULTIPLE entries → the
   *  heat picker shows all tracks merged in one grid with track
   *  badges, mirroring the race-pack mixed-track UX. The customer
   *  picks any heat from any track for this component (the gap rule
   *  for downstream components anchors on whichever track they
   *  picked). */
  tracks: PackageTrackOption[];
  /** Heat-gap rule against an earlier component's STOP time.
   *  e.g. `{ ref: "starter", minutes: 60 }` means "this heat must
   *  start ≥ 60 min after the starter heat ends".
   *
   *  `sameTrackMinutes` relaxes the rule when the candidate heat is on
   *  the SAME track as the referenced pick — there's no walk to the
   *  other track, so the buffer only has to cover the qualify / POV
   *  review turnaround (owner 2026-08-04: Ultimate
   *  Qualifier same-track drops 60 → 30). Omit it and `minutes` applies
   *  regardless of track. Resolved by `packageGapMinutesFor` in
   *  `heat-conflict.ts` / `features/booking/service/conflict.ts`. */
  minMinutesAfterEndOf?: { ref: string; minutes: number; sameTrackMinutes?: number };
}

/** First track entry on a component — convenience for callers that
 *  only need the default product (cart preview, registry helpers).
 *  When the component has multiple tracks the LIVE pick at heat-
 *  selection time takes precedence — this is just the seed used
 *  before any pick exists. */
export function primaryTrack(component: PackageRaceComponent): PackageTrackOption {
  return component.tracks[0];
}

export interface PackageDefinition {
  id: PackageId;
  /** Display name (cart line, hero card, picker). */
  name: string;
  /** One-liner shown as the picker-card subtitle. */
  shortDescription: string;
  /** Full marketing copy — picker card body, info modal. */
  longDescription: string;
  /** Env-flag-aware feature gate. */
  enabled: boolean;
  /**
   * Limited-time bundle: not OFFERED after this ET wall-clock instant
   * ("YYYY-MM-DDTHH:mm:ss", no offset — the ET offset is derived per date).
   * Omitted = always offered, which is every standing package.
   *
   * Checked per-request in `eligiblePackages`, NOT baked into `enabled`:
   * `enabled` is a module-load constant, so a long-lived serverless instance
   * that booted before the deadline would keep offering an expired bundle.
   *
   * Deliberately NOT checked in `getPackage`. That looks like the safer place
   * until you read the charge path: `raceItemChargeLines` does
   * `const pkg = getPackage(pkgId); if (!pkg) continue;`, which DROPS the
   * category's heats from the Square lines while BMI still books them at $0.
   * Expiring a package there would hand out FREE races to anyone mid-checkout
   * at the deadline, rather than refusing them. Gating the OFFER is the
   * fail-safe direction; the residual risk is a forged session id pricing at
   * the sale rate after the sale, which costs the sale discount, not the race.
   */
  bookableUntil?: string;
  /** Start of the same window. Omitted = "already open". Paired with
   *  `bookableUntil` because an end-only bound reads as active for all of
   *  history before the deadline. */
  bookableFrom?: string;
  /**
   * RECURRING day-of-week restriction on the RACE DATE — "this bundle only
   * exists for Wednesday races, from 2026-08-19" (BOGO, owner 2026-08-19).
   * Omitted = any day the `schedules` allow, which is every standing package.
   *
   * Distinct from `schedules` on purpose: a `Schedule` is a PRICING TIER
   * (weekday / weekend / mega — Tuesday is "mega", not "weekday"), shared with
   * product pricing and heat grids. A weekly promo needs to name single days
   * without minting a pricing tier per day, and `raceDays` narrows WITHIN
   * whatever `schedules` already allows rather than replacing it.
   *
   * Distinct from `bookableFrom`/`bookableUntil` too, and that distinction is
   * the whole point: those bound the PURCHASE instant, this bounds the RACE day.
   * "BOGO Wednesdays" has to reach a guest booking on Tuesday for a Wednesday
   * race, and must NOT reach a Wednesday walk-up booking Thursday — the exact
   * opposite of what a purchase window does. Its own `from` is therefore the
   * right floor for a recurring bundle, and `bookableFrom` is left off rather
   * than set to the same date: two floors on two different clocks is exactly the
   * drift one field prevents.
   */
  raceDays?: RecurringDayRule;
  /**
   * Short marketing flag rendered on the picker card, e.g. "FLASH SALE" — the
   * one thing that makes a limited-time bundle read differently from the
   * standing ones at a glance, on both the web picker and the kiosk pay-mode
   * screen. Omitted on every standing package.
   *
   * Kept as DATA rather than a UI heuristic keyed off the package id, for the
   * same reason `recommended` is: moving or retiring the flag is a registry
   * edit, not a component change. Guest-facing, so the kiosk renders it through
   * the i18n catalog (EN + ES) rather than printing this string raw.
   */
  badge?: string;
  /** Eligibility — `"any"` matches both new and existing racers. */
  racerType: "new" | "existing" | "any";
  /** When this package is bookable. Empty array means never. */
  schedules: Schedule[];
  /** Category restriction. `"any"` matches both. */
  category: "adult" | "junior" | "any";

  /** Race components the package bundles. EMPTY array means the
   *  package wraps whatever Starter race the user separately picks
   *  on the product picker (Rookie Pack today). NON-EMPTY means the
   *  package OWNS its race selections — the picker advances straight
   *  into PackageHeatPicker bypassing the standalone race cards. */
  races: PackageRaceComponent[];
  /** Auto-add the FastTrax license at checkout (or treat as already
   *  included if the racer's flow was going to add one anyway). */
  includesLicense: boolean;
  /** Auto-add POV cameras (one per racer) at checkout. */
  includesPov: boolean;
  /** Nemo's appetizer promo code. DORMANT since 2026-08-12: NO package carries
   *  one. The Rookie Pack dropped its appetizer 2026-08-04 and the Ultimate
   *  Qualifier dropped its own 2026-08-12 (owner, web + kiosk). Everything
   *  downstream — the picker checklist, the cart row, the kiosk pay-mode
   *  "incl." chip, the confirmation block and the email call-out — is gated on
   *  this field, so setting it here is the ONLY thing that turns the offer back
   *  on, and clearing it is the only thing that turns it off. Nothing renders
   *  an appetizer without it; there is deliberately no hardcoded fallback. */
  appetizerCode?: string;
  /** Per-package qualifier for the appetizer offer, e.g. "1 per group" or
   *  "1 per 3 purchases". Only meaningful alongside `appetizerCode`. */
  appetizerNote?: string;
  /** Menu items the appetizer code is valid for — per package, since the
   *  eligible list has differed between bundles. */
  appetizerItems?: string[];

  /** Per-racer bundle total. Optional — if omitted, the auto-sum
   *  helper computes it from `races` + license/POV booleans. */
  price?: number;
  /** Comparison "retail" total for "you save $X" display. Optional. */
  retailPrice?: number;

  /** Stable key for cart-sync line entries. */
  cartLineKey: string;

  /** Display order on the picker — lower numbers render first.
   *  Lets us promote a package to the top without reorganizing the
   *  registry array. Defaults to 100 when omitted; 10 = featured /
   *  premium, 20 = secondary, etc. Plain races render below all
   *  packages regardless of value here. */
  displayOrder?: number;

  /** THE house recommendation for this category — the kiosk's pay-mode screen
   *  gives it the hero card and the "FastTrax recommended" ribbon, and every
   *  other bundle renders as a secondary row beneath it (owner 2026-08-03: "the
   *  Ultimate Qualifier is the FastTrax recommended experience"). Data, not a
   *  UI heuristic, so moving the ribbon is a registry edit. At most one per
   *  category should carry it; the first match wins. */
  recommended?: boolean;

  /** Offer this bundle only while the category's racers are qualified at or
   *  BELOW this tier. The Ultimate Qualifier's whole point is earning the
   *  Intermediate unlock, so it is pointless once someone already holds it —
   *  but it is very much for a returning racer who has only ever run Starter
   *  (owner 2026-08-04: "these combos really shouldn't be filtered by new
   *  racer... if everyone is still only starter you should present them").
   *  Omitted = no qualification ceiling. */
  maxQualifiedTier?: PackageTier;

  /** Optional disclaimer modal shown when the user picks the package
   *  card. Every ack must be ticked before they can continue. Used by
   *  Ultimate Qualifier to make clear the Intermediate race is
   *  conditional on qualifying.
   *
   *  Copy is CATALOG KEYS, not literals. This modal renders on the kiosk,
   *  where a hardcoded English string is a rule violation and, more to the
   *  point, means a Spanish-speaking parent ticks three boxes they cannot
   *  read. `useT()` falls back to English off-kiosk, so web is unaffected.
   *  Same split as race-warnings.ts, and `RaceWarningModal` renders both.
   *
   *  `billMemo` stays a literal: it is staff-facing (BMI Booking app "Memo
   *  and image" tab), English-only by design, and never shown to a guest. */
  disclaimers?: {
    titleKey: MessageKey;
    bodyKey: MessageKey;
    ackKeys: readonly MessageKey[];
    continueKey: MessageKey;
    billMemo: string;
  };
}

// ── Registry ────────────────────────────────────────────────────────────────

// Default ON unless explicitly disabled. The original rookie-pack
// path (PovUpsell chooser) used `=== "1"` strict opt-in because it
// was staged behind a feature flag during rollout. Now that
// Rookie Pack lives on the picker as a first-class card alongside
// Ultimate Qualifier, default it ON so a missing env var doesn't
// silently hide the package on production.
const ROOKIE_PACK_ENABLED =
  (process.env.NEXT_PUBLIC_ROOKIE_PACK_ENABLED || "true").toLowerCase() !== "false";
const ULTIMATE_QUALIFIER_ENABLED =
  (process.env.NEXT_PUBLIC_ULTIMATE_QUALIFIER_ENABLED || "true").toLowerCase() !== "false";

// Shared Ultimate Qualifier copy — the per-track / per-schedule
// variants only differ in their race component productIds, so the
// long description, disclaimer body, and bill memo are factored out
// here. Update once and every variant inherits it.
const UQ_LONG =
  "This is the premier FastTrax experience. Think you have what it takes to level up? This isn't for the faint of heart. You'll qualify in one of our Starter races, and if you level up, your Intermediate race will be waiting for you — scheduled 30 minutes later on the same track, or an hour later if you switch tracks. While you wait, you can review the included POV video to get better before you line up again. This ultimate pack also includes your license.";

const UQ_DISCLAIMERS: PackageDefinition["disclaimers"] = {
  titleKey: "packageDisclaimer.uq.title",
  bodyKey: "packageDisclaimer.uq.body",
  ackKeys: [
    "packageDisclaimer.uq.ack.conditional",
    "packageDisclaimer.uq.ack.noRefund",
    "packageDisclaimer.uq.ack.accept",
  ],
  continueKey: "packageDisclaimer.continue",
  billMemo:
    "** ULTIMATE QUALIFIER ** Customer is a NEW racer — has NOT yet qualified for Intermediate. STAFF: verify level-up before assigning kart to the Intermediate race. If customer did not qualify: offer additional Starter (if available) OR issue race credit. NO cash refunds — customer acknowledged disclaimer at booking.",
};

/**
 * When BOGO runs: Wednesday RACES, from 2026-08-19 (owner). It ran 2026-08-12 →
 * EOD 2026-08-13 as a one-off flash sale on a `bookableUntil` purchase window
 * before that.
 *
 * ⚠ MUST stay equal to `BOGO_SALE_RULE` in features/booking/data/packs.ts, which
 * gates the CREDIT-PACK half of the same advertised promo. `lib/` cannot import
 * from `features/` (the same constraint that made the old `bookableUntil` ==
 * `BOGO_SALE_ENDS_AT` pin necessary), so a test in bogo-sale.test.ts is the only
 * thing keeping them equal.
 */
const BOGO_RACE_DAYS: RecurringDayRule = { days: [3], from: "2026-08-19" };

const BOGO_LONG =
  "Buy one race, get one free. You'll book two heats back-to-back: your Starter race, then an Intermediate race once you level up. Two races for the price of one — every Wednesday.";

/**
 * BOGO carries the SAME conditional-Intermediate risk as the Ultimate Qualifier
 * — a new racer's second heat is reserved on the assumption they qualify in
 * their Starter — so it gets its own acknowledgment block rather than shipping
 * without one. Cloning UQ_DISCLAIMERS verbatim would have shown a guest the
 * words "Ultimate Qualifier" on a BOGO booking and promised a license and POV
 * this bundle does not include.
 *
 * The no-cash-refund term reads differently here, and the copy says so plainly:
 * at $20.99 a racer who doesn't level up has paid the ordinary single-race price
 * for the Starter they ran. Nothing was lost — so the remedy (another Starter,
 * or credit) is a genuine make-good rather than a consolation for a bundle they
 * only half-received. That framing is the honest one AND the one that survives a
 * chargeback dispute.
 */
const BOGO_DISCLAIMERS: PackageDefinition["disclaimers"] = {
  titleKey: "packageDisclaimer.bogo.title",
  bodyKey: "packageDisclaimer.bogo.body",
  ackKeys: [
    "packageDisclaimer.bogo.ack.conditional",
    "packageDisclaimer.bogo.ack.noRefund",
    "packageDisclaimer.bogo.ack.noExtras",
    "packageDisclaimer.bogo.ack.accept",
  ],
  continueKey: "packageDisclaimer.continue",
  billMemo:
    "** BOGO RACES (WEDNESDAY DEAL) ** Customer is a NEW racer — has NOT yet qualified for Intermediate. Paid ONE race price for TWO heats. NO license, NO POV, NO appetizer included — do not comp these. STAFF: verify level-up before assigning kart to the Intermediate race. If customer did not qualify: offer additional Starter (if available) OR issue race credit. NO cash refunds — customer acknowledged disclaimer at booking.",
};

// No appetizer since 2026-08-04 (owner). The Ultimate Qualifier dropped its
// own 2026-08-12 — no package includes one now.
const ROOKIE_LONG =
  "Your first race plus everything you need to remember it: FastTrax license and ViewPoint POV camera footage of your run.";

const PACKAGES: PackageDefinition[] = [
  // ── Rookie Pack — Mega (Tuesday) ──────────────────────────────────────────
  // Per-schedule variants so the picker can render a single card with
  // a definitive Starter race component (vs. the old `races: []` form
  // that needed extra plumbing to combine with a separately-picked
  // race). Pricing auto-sums from the components.
  {
    id: "rookie-pack-mega",
    maxQualifiedTier: "starter",
    name: "Rookie Pack",
    shortDescription: "Starter Mega + License + POV",
    longDescription: ROOKIE_LONG,
    enabled: ROOKIE_PACK_ENABLED,
    racerType: "new",
    schedules: ["mega"],
    // Adult-only — there's no Junior Starter Race Mega product in
    // BMI's catalog (juniors at Mega are existing-racer-only via
    // Junior Intermediate/Pro Mega). Was previously `category: "any"`
    // which let juniors pick this pack and silently book under the
    // adult Mega Starter SKU.
    category: "adult",
    races: [
      {
        sequence: 1,
        ref: "starter",
        label: "Starter Race Mega",
        tier: "starter",
        tracks: [{ track: "Mega", productId: "24965505", pageId: "24966930", price: 20.99 }],
      },
    ],
    includesLicense: true,
    includesPov: true,
    cartLineKey: "rookie-pack",
    displayOrder: 20,
  },
  // ── Rookie Pack — Weekday Adult (Mon/Wed/Thu) ─────────────────────────────
  // Adult variant only — spans BOTH tracks (Red + Blue), heat picker
  // shows them merged with track badges. The matching junior variant
  // is below. Was previously `category: "any"` with adult-only product
  // ids — meaning juniors who picked this pack got silently booked
  // under the adult Starter SKU (wrong kart category at the front
  // desk).
  {
    id: "rookie-pack-weekday",
    maxQualifiedTier: "starter",
    name: "Rookie Pack",
    shortDescription: "Starter Race + License + POV",
    longDescription: ROOKIE_LONG,
    enabled: ROOKIE_PACK_ENABLED,
    racerType: "new",
    schedules: ["weekday"],
    category: "adult",
    races: [
      {
        sequence: 1,
        ref: "starter",
        label: "Starter Race",
        tier: "starter",
        tracks: [
          { track: "Red", productId: "24960859", pageId: "24961568", price: 20.99 },
          { track: "Blue", productId: "24960393", pageId: "24961568", price: 20.99 },
        ],
      },
    ],
    includesLicense: true,
    includesPov: true,
    cartLineKey: "rookie-pack",
    displayOrder: 20,
  },
  // ── Rookie Pack — Weekday Junior (Mon/Wed/Thu) ────────────────────────────
  // Junior counterpart to the adult variant above. BMI only has a
  // Junior Starter Race BLUE product (no Red junior starter exists),
  // so the heat picker renders Blue-only. Junior weekday Starter is
  // $15.99 (vs. $20.99 adult).
  {
    id: "rookie-pack-weekday-junior",
    maxQualifiedTier: "starter",
    name: "Rookie Pack",
    shortDescription: "Junior Starter Blue + License + POV",
    longDescription: ROOKIE_LONG,
    enabled: ROOKIE_PACK_ENABLED,
    racerType: "new",
    schedules: ["weekday"],
    category: "junior",
    races: [
      {
        sequence: 1,
        ref: "starter",
        label: "Junior Starter Race Blue",
        tier: "starter",
        tracks: [
          // Existing Junior Starter Race Blue (weekday).
          { track: "Blue", productId: "24960106", pageId: "24961568", price: 15.99 },
        ],
      },
    ],
    includesLicense: true,
    includesPov: true,
    cartLineKey: "rookie-pack-weekday-junior",
    displayOrder: 20,
  },
  // ── Rookie Pack — Weekend Adult (Fri/Sat/Sun) ─────────────────────────────
  // Adult variant — Red + Blue. Junior counterpart below. Same split
  // rationale as the weekday entries: was `category: "any"` with
  // adult-only product ids and silently booked juniors under adult
  // SKUs.
  {
    id: "rookie-pack-weekend",
    maxQualifiedTier: "starter",
    name: "Rookie Pack",
    shortDescription: "Starter Race + License + POV",
    longDescription: ROOKIE_LONG,
    enabled: ROOKIE_PACK_ENABLED,
    racerType: "new",
    schedules: ["weekend"],
    category: "adult",
    races: [
      {
        sequence: 1,
        ref: "starter",
        label: "Starter Race",
        tier: "starter",
        tracks: [
          { track: "Red", productId: "24953280", pageId: "24871574", price: 26.99 },
          { track: "Blue", productId: "24952964", pageId: "24871574", price: 26.99 },
        ],
      },
    ],
    includesLicense: true,
    includesPov: true,
    cartLineKey: "rookie-pack",
    displayOrder: 20,
  },
  // ── Rookie Pack — Weekend Junior (Fri/Sat/Sun) ────────────────────────────
  // Junior counterpart — Blue Track only (no Red junior product).
  // Junior weekend Starter is $19.99.
  {
    id: "rookie-pack-weekend-junior",
    maxQualifiedTier: "starter",
    name: "Rookie Pack",
    shortDescription: "Junior Starter Blue + License + POV",
    longDescription: ROOKIE_LONG,
    enabled: ROOKIE_PACK_ENABLED,
    racerType: "new",
    schedules: ["weekend"],
    category: "junior",
    races: [
      {
        sequence: 1,
        ref: "starter",
        label: "Junior Starter Race Blue",
        tier: "starter",
        tracks: [
          // Existing Junior Starter Race Blue (weekend).
          { track: "Blue", productId: "24953399", pageId: "24871574", price: 19.99 },
        ],
      },
    ],
    includesLicense: true,
    includesPov: true,
    cartLineKey: "rookie-pack-weekend-junior",
    displayOrder: 20,
  },
  // ── Legacy alias — `rookie-pack` ──────────────────────────────────────────
  // Keeps `getPackageIgnoreFlag("rookie-pack")` returning a working
  // entry for OLD bookings whose booking record still has
  // `package: "rookie-pack"` from the pre-split deploy. Disabled so
  // it never renders on the picker. New bookings write one of the
  // per-schedule ids above instead.
  {
    id: "rookie-pack",
    maxQualifiedTier: "starter",
    name: "Rookie Pack",
    shortDescription: "Starter race + license + POV",
    longDescription: ROOKIE_LONG,
    enabled: false,
    racerType: "new",
    schedules: ["weekday", "weekend", "mega"],
    category: "any",
    races: [],
    includesLicense: true,
    includesPov: true,
    price: LICENSE_PRICE + POV_PRICE,
    cartLineKey: "rookie-pack",
  },

  // ── Ultimate Qualifier (Mega) ─────────────────────────────────────────────
  // Premier package for Mega Tuesdays. Books two heats — Starter
  // Mega first, then Intermediate Mega after the Starter ends, with
  // enough of a gap to qualify and watch the included POV video.
  // Both components are Mega-only, so the same-track relaxation
  // always applies here: 30 min, not 60.
  //
  // Intermediate productId 45810775 is a NEW BMI SKU minted for this
  // package only — separate from the standalone Intermediate Race
  // Mega 24965707 in `app/book/race/data.ts`. Pricing on the new SKU
  // TBD; until confirmed, the auto-sum pricing helper falls back to
  // standalone Intermediate price ($20.99). Update the `price` here
  // (or on the `45810775` race component) once finalized.
  //
  // pageId for 45810775: best guess is the existing Intermediate Mega
  // page (25850647). Verify with a /api/bmi?endpoint=availability
  // probe before launch and update if BMI moved it elsewhere.
  {
    id: "ultimate-qualifier-mega",
    maxQualifiedTier: "starter",
    recommended: true,
    name: "Ultimate Qualifier",
    shortDescription: "Starter Mega + Intermediate Mega + license + POV",
    longDescription: UQ_LONG,
    enabled: ULTIMATE_QUALIFIER_ENABLED,
    // First-time racers only. A returning racer who's already
    // qualified Intermediate doesn't need the qualifier-+-buffer
    // bundle; they book Intermediate directly.
    racerType: "new",
    schedules: ["mega"],
    category: "adult",
    races: [
      {
        sequence: 1,
        ref: "starter",
        label: "Starter Race Mega",
        tier: "starter",
        tracks: [
          // Existing Starter Race Mega (new-racer).
          { track: "Mega", productId: "24965505", pageId: "24966930", price: 20.99 },
        ],
      },
      {
        sequence: 2,
        ref: "intermediate",
        label: "Intermediate Race Mega",
        tier: "intermediate",
        tracks: [
          // NEW — Ultimate-Qualifier-only Intermediate Mega. Verify
          // pageId before launch — see the comment above.
          { track: "Mega", productId: "45810775", pageId: "25850647", price: 20.99 },
        ],
        // Mega is single-track, so the same-track number is the ONLY one that
        // can ever apply. 30, same as the Red/Blue variants — briefly 20 on
        // 2026-08-04, reverted the same day (owner). Measured from the
        // Starter's STOP, so a 10:10 heat ending 10:17 opens 10:47, not 10:40.
        minMinutesAfterEndOf: { ref: "starter", minutes: 60, sameTrackMinutes: 30 },
      },
    ],
    includesLicense: true,
    includesPov: true,
    // No explicit `price` — let the auto-sum helper compute it from
    // the components above + license + POV. Update once finalized.
    cartLineKey: "ultimate-qualifier-mega",
    displayOrder: 10,
    disclaimers: UQ_DISCLAIMERS,
  },

  // ── Ultimate Qualifier — Weekday (Adult, Red + Blue) ──────────────────────
  // ONE entry that spans both tracks. Heat picker fetches Red AND
  // Blue heats for each component (Starter, Intermediate) and shows
  // them in a single merged grid with track badges, mirroring the
  // race-pack mixed-track UX. The customer can mix tracks too — pick
  // a Red Starter and a Blue Intermediate if that's what fits time-
  // wise (gap rule still anchors on whichever Starter STOP they
  // landed on). New BMI Intermediate SKUs 45810802 (Red) and 45811366
  // (Blue) are package-only — distinct from the standalone Intermediate
  // products in RACE_PRODUCTS so they don't clutter the regular picker.
  // pageId guess: weekday Intermediate page (25850629). Verify before
  // launch — see the Mega-variant comment for the probe pattern.
  {
    id: "ultimate-qualifier-weekday",
    maxQualifiedTier: "starter",
    recommended: true,
    name: "Ultimate Qualifier",
    shortDescription: "Starter + Intermediate + License + POV",
    longDescription: UQ_LONG,
    enabled: ULTIMATE_QUALIFIER_ENABLED,
    racerType: "new",
    schedules: ["weekday"],
    category: "adult",
    races: [
      {
        sequence: 1,
        ref: "starter",
        label: "Starter Race",
        tier: "starter",
        tracks: [
          { track: "Red", productId: "24960859", pageId: "24961568", price: 20.99 },
          { track: "Blue", productId: "24960393", pageId: "24961568", price: 20.99 },
        ],
      },
      {
        sequence: 2,
        ref: "intermediate",
        label: "Intermediate Race",
        tier: "intermediate",
        tracks: [
          { track: "Red", productId: "45810802", pageId: "25850629", price: 20.99 },
          { track: "Blue", productId: "45811366", pageId: "25850629", price: 20.99 },
        ],
        minMinutesAfterEndOf: { ref: "starter", minutes: 60, sameTrackMinutes: 30 },
      },
    ],
    includesLicense: true,
    includesPov: true,
    cartLineKey: "ultimate-qualifier-weekday",
    displayOrder: 10,
    disclaimers: UQ_DISCLAIMERS,
  },

  // ── Ultimate Qualifier — Weekday Junior (Blue) ────────────────────────────
  // Juniors race Blue Track only on weekdays — one variant per schedule, no
  // Red counterpart. Pulls the existing Junior Starter Race Blue (24960106)
  // on page 24961568, paired with the new package-only Junior Intermediate
  // SKU 45811531 on the existing weekday Intermediate page (25850629). Verify
  // the pageId before launch — see the Mega-variant comment for the probe
  // pattern. Junior weekday Starter is $15.99 (vs. $20.99 adult); standalone
  // Junior Intermediate weekday is $20.99 — used as the registry fallback
  // when the live BMI fetch hasn't resolved yet.
  {
    id: "ultimate-qualifier-weekday-junior",
    maxQualifiedTier: "starter",
    recommended: true,
    name: "Ultimate Qualifier",
    shortDescription: "Junior Starter Blue + Junior Intermediate Blue + License + POV",
    longDescription: UQ_LONG,
    enabled: ULTIMATE_QUALIFIER_ENABLED,
    racerType: "new",
    schedules: ["weekday"],
    category: "junior",
    races: [
      {
        sequence: 1,
        ref: "starter",
        label: "Junior Starter Race Blue",
        tier: "starter",
        tracks: [
          // Existing Junior Starter Race Blue (weekday).
          { track: "Blue", productId: "24960106", pageId: "24961568", price: 15.99 },
        ],
      },
      {
        sequence: 2,
        ref: "intermediate",
        label: "Junior Intermediate Race Blue",
        tier: "intermediate",
        tracks: [
          // NEW — Ultimate-Qualifier-only Junior Intermediate Blue (weekday).
          { track: "Blue", productId: "45811531", pageId: "25850629", price: 20.99 },
        ],
        minMinutesAfterEndOf: { ref: "starter", minutes: 60, sameTrackMinutes: 30 },
      },
    ],
    includesLicense: true,
    includesPov: true,
    cartLineKey: "ultimate-qualifier-weekday-junior",
    displayOrder: 10,
    disclaimers: UQ_DISCLAIMERS,
  },

  // ── BOGO Races — Wednesdays (Adult, Red + Blue) ───────────────────────────
  // EVERY WEDNESDAY from 2026-08-19 (owner). Ran 2026-08-12 → EOD 2026-08-13 as
  // a one-off flash sale before that. Two races for the price of one, for NEW
  // racers. Structurally the Ultimate Qualifier — the same Starter +
  // Intermediate components, the same package-only Intermediate SKUs, the same
  // gap rule — but stripped of the license, POV and appetizer, and priced at a
  // single race instead of the auto-summed bundle.
  //
  // Returning racers get the equivalent offer as a 2-race CREDIT pack
  // (features/booking/data/packs.ts BOGO_SALE_SLUGS) rather than this package,
  // because they may already hold the Intermediate qualification this bundle is
  // built to earn — `maxQualifiedTier: "starter"` is what keeps the two from
  // ever being offered to the same racer.
  //
  // `schedules: ["weekday"]` STAYS: it is the pricing tier these component SKUs
  // belong to, and `raceDays` narrows within it. Dropping it would let the
  // weekday-priced products be offered against a weekend heat grid.
  //
  // ⚠ `raceDays` MUST stay equal to BOGO_SALE_RULE in
  // features/booking/data/packs.ts — the two halves of one advertised promo must
  // run on the same days from the same date. A test pins them equal; it is not a
  // stylistic nit.
  {
    id: "bogo-weekday",
    maxQualifiedTier: "starter",
    name: "BOGO Races",
    shortDescription: "Two races for the price of one — Starter + Intermediate",
    longDescription: BOGO_LONG,
    enabled: true,
    // No bookableFrom/Until: `raceDays` carries the promo's own start floor, on
    // the RACE clock this bundle is actually gated by. See the field's docs.
    raceDays: BOGO_RACE_DAYS,
    badge: "WEDNESDAYS",
    racerType: "new",
    schedules: ["weekday"],
    category: "adult",
    races: [
      {
        sequence: 1,
        ref: "starter",
        label: "Starter Race",
        tier: "starter",
        tracks: [
          { track: "Red", productId: "24960859", pageId: "24961568", price: 20.99 },
          { track: "Blue", productId: "24960393", pageId: "24961568", price: 20.99 },
        ],
      },
      {
        sequence: 2,
        ref: "intermediate",
        label: "Intermediate Race",
        tier: "intermediate",
        tracks: [
          { track: "Red", productId: "45810802", pageId: "25850629", price: 20.99 },
          { track: "Blue", productId: "45811366", pageId: "25850629", price: 20.99 },
        ],
        minMinutesAfterEndOf: { ref: "starter", minutes: 60, sameTrackMinutes: 30 },
      },
    ],
    includesLicense: false,
    includesPov: false,
    // EXPLICIT price — the auto-sum helper would total the two components to
    // $41.98. That total is the `retailPrice` here, i.e. exactly what the guest
    // is saving, which is the whole pitch.
    price: 20.99,
    retailPrice: 41.98,
    cartLineKey: "bogo-weekday",
    // Above the Ultimate Qualifier's 10 so the sale leads the picker. UQ keeps
    // `recommended` (the ribbon) — see the junior variant's note.
    displayOrder: 5,
    disclaimers: BOGO_DISCLAIMERS,
  },

  // ── BOGO Races — Wednesdays Junior (Blue) ─────────────────────────────────
  // Juniors race Blue only on weekdays, same as the UQ junior variant. Priced
  // off the JUNIOR single-race rate ($15.99, vs $20.99 adult) so each tier gets
  // a true buy-one-get-one rather than one flat price that shortchanges juniors.
  //
  // Retail is 2 × the junior single-race rate ($15.99), so the saving reads as
  // exactly half the two-race total — the price of the free race, which is what
  // "buy one get one" means and what every other BOGO SKU shows (owner).
  //
  // Note this UNDERSTATES the true value: the junior Intermediate weekday SKU
  // actually lists at $20.99 (see the UQ junior note above), so the real retail
  // is $36.98 and the guest saves $20.99. Understating a discount is safe;
  // overstating one is the thing this page must never do. Taking the smaller,
  // consistent number is deliberate on both counts.
  //
  // No `recommended` on either BOGO variant — the Ultimate Qualifier is the
  // house recommendation and at most one package per category should carry the
  // ribbon ("the first match wins"). Taking it for a weekly promo is a marketing
  // call, not a technical one; `displayOrder: 5` already puts BOGO on top.
  {
    id: "bogo-weekday-junior",
    maxQualifiedTier: "starter",
    name: "BOGO Races",
    shortDescription: "Two junior races for the price of one — Starter + Intermediate",
    longDescription: BOGO_LONG,
    enabled: true,
    raceDays: BOGO_RACE_DAYS,
    badge: "WEDNESDAYS",
    racerType: "new",
    schedules: ["weekday"],
    category: "junior",
    races: [
      {
        sequence: 1,
        ref: "starter",
        label: "Junior Starter Race Blue",
        tier: "starter",
        tracks: [{ track: "Blue", productId: "24960106", pageId: "24961568", price: 15.99 }],
      },
      {
        sequence: 2,
        ref: "intermediate",
        label: "Junior Intermediate Race Blue",
        tier: "intermediate",
        tracks: [{ track: "Blue", productId: "45811531", pageId: "25850629", price: 20.99 }],
        minMinutesAfterEndOf: { ref: "starter", minutes: 60, sameTrackMinutes: 30 },
      },
    ],
    includesLicense: false,
    includesPov: false,
    price: 15.99,
    retailPrice: 31.98,
    cartLineKey: "bogo-weekday-junior",
    displayOrder: 5,
    disclaimers: BOGO_DISCLAIMERS,
  },

  // ── Ultimate Qualifier — Weekend (Adult, Red + Blue) ──────────────────────
  // Weekend Starter / Intermediate pricing is $26.99 (vs. $20.99 weekday).
  // Heat picker spans both tracks in one merged grid — same UX as the
  // weekday variant above. New package-only weekend Intermediate SKUs:
  // 45811390 (Red) and 45811415 (Blue). pageId guess: weekend
  // Intermediate page (25850598). Verify before launch.
  {
    id: "ultimate-qualifier-weekend",
    maxQualifiedTier: "starter",
    recommended: true,
    name: "Ultimate Qualifier",
    shortDescription: "Starter + Intermediate + License + POV",
    longDescription: UQ_LONG,
    enabled: ULTIMATE_QUALIFIER_ENABLED,
    racerType: "new",
    schedules: ["weekend"],
    category: "adult",
    races: [
      {
        sequence: 1,
        ref: "starter",
        label: "Starter Race",
        tier: "starter",
        tracks: [
          { track: "Red", productId: "24953280", pageId: "24871574", price: 26.99 },
          { track: "Blue", productId: "24952964", pageId: "24871574", price: 26.99 },
        ],
      },
      {
        sequence: 2,
        ref: "intermediate",
        label: "Intermediate Race",
        tier: "intermediate",
        tracks: [
          { track: "Red", productId: "45811390", pageId: "25850598", price: 26.99 },
          { track: "Blue", productId: "45811415", pageId: "25850598", price: 26.99 },
        ],
        minMinutesAfterEndOf: { ref: "starter", minutes: 60, sameTrackMinutes: 30 },
      },
    ],
    includesLicense: true,
    includesPov: true,
    cartLineKey: "ultimate-qualifier-weekend",
    displayOrder: 10,
    disclaimers: UQ_DISCLAIMERS,
  },

  // ── Ultimate Qualifier — Weekend Junior (Blue) ────────────────────────────
  // Weekend junior counterpart to the weekday-junior variant above. Junior
  // Starter Blue weekend is $19.99 (vs. $26.99 adult). Standalone Junior
  // Intermediate Blue weekend is $20.99 — registry fallback only; the picker
  // pulls live BMI prices at render time. New package-only Junior
  // Intermediate weekend SKU 45811475 lives on the existing weekend
  // Intermediate page (25850598) — verify before launch.
  {
    id: "ultimate-qualifier-weekend-junior",
    maxQualifiedTier: "starter",
    recommended: true,
    name: "Ultimate Qualifier",
    shortDescription: "Junior Starter Blue + Junior Intermediate Blue + License + POV",
    longDescription: UQ_LONG,
    enabled: ULTIMATE_QUALIFIER_ENABLED,
    racerType: "new",
    schedules: ["weekend"],
    category: "junior",
    races: [
      {
        sequence: 1,
        ref: "starter",
        label: "Junior Starter Race Blue",
        tier: "starter",
        tracks: [
          // Existing Junior Starter Race Blue (weekend).
          { track: "Blue", productId: "24953399", pageId: "24871574", price: 19.99 },
        ],
      },
      {
        sequence: 2,
        ref: "intermediate",
        label: "Junior Intermediate Race Blue",
        tier: "intermediate",
        tracks: [
          // NEW — Ultimate-Qualifier-only Junior Intermediate Blue (weekend).
          { track: "Blue", productId: "45811475", pageId: "25850598", price: 20.99 },
        ],
        minMinutesAfterEndOf: { ref: "starter", minutes: 60, sameTrackMinutes: 30 },
      },
    ],
    includesLicense: true,
    includesPov: true,
    cartLineKey: "ultimate-qualifier-weekend-junior",
    displayOrder: 10,
    disclaimers: UQ_DISCLAIMERS,
  },
];

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Lookup a package definition by id. Returns null when the id is
 *  unknown or the feature flag has it disabled — callers should
 *  treat both cases as "package unavailable". */
/** Read-only view of the full package registry — for tests / debug surfaces only. */
export function _allPackages(): readonly PackageDefinition[] {
  return PACKAGES;
}

export function getPackage(id: string | null | undefined): PackageDefinition | null {
  if (!id) return null;
  const pkg = PACKAGES.find((p) => p.id === id);
  if (!pkg || !pkg.enabled) return null;
  return pkg;
}

/** Same as `getPackage` but ignores the enabled flag. Useful on the
 *  confirmation page where we still need to render an old booking
 *  even if the package was later turned off. */
export function getPackageIgnoreFlag(id: string | null | undefined): PackageDefinition | null {
  if (!id) return null;
  return PACKAGES.find((p) => p.id === id) ?? null;
}

/**
 * Resolve a productId from any package's component tracks back to a
 * customer-friendly race name. We need this because BMI's bill/overview
 * API returns the wrong public-facing name on some package-only SKUs —
 * e.g. productId 45811415 (the weekend Intermediate Blue, package-only)
 * comes back as "Intermediate Race Mega" from BMI even though the kart
 * is actually Blue Track. The BMI admin tool shows the correct internal
 * name, but the public API ships a stale label that confuses customers
 * on confirmation pages and email receipts.
 *
 * We override BMI's name when we recognize the productId. Returns null
 * when the productId isn't part of any package — caller should fall
 * back to BMI's own name in that case (regular standalone race
 * bookings are reliable).
 */
export function productDisplayNameFromPackages(
  productId: string | number | null | undefined,
): string | null {
  if (!productId) return null;
  const pid = String(productId);
  for (const pkg of PACKAGES) {
    for (const race of pkg.races) {
      const track = race.tracks.find((t) => String(t.productId) === pid);
      if (!track) continue;
      // Tier-cased: "starter" → "Starter", "intermediate" → "Intermediate", "pro" → "Pro".
      const tier = race.tier.charAt(0).toUpperCase() + race.tier.slice(1);
      // Junior packages carry that distinction in the rendered name so
      // a parent reviewing the receipt sees the right label.
      const juniorPrefix = pkg.category === "junior" ? "Junior " : "";
      return `${juniorPrefix}${tier} Race ${track.track}`;
    }
  }
  return null;
}

export interface EligibilityContext {
  racerType: "new" | "existing" | null | undefined;
  schedule: Schedule | null | undefined;
  category?: "adult" | "junior";
  /** The tier the category's racers already qualify for (the union — the most
   *  qualified racer wins), from `qualifiedTierForCategory`. Gates bundles that
   *  exist to EARN a qualification: pass "starter" for a group that has only
   *  ever run Starter, even when they are returning racers. Omitted = "starter"
   *  (nothing qualified), which keeps existing callers behaving as before. */
  qualifiedTier?: PackageTier;
  /**
   * The BOOKED race date (`YYYY-MM-DD`) — gates `raceDays`, the recurring
   * day-of-week rule behind "BOGO Wednesdays". Omitted or null means the caller
   * has no date yet, and a `raceDays` bundle falls back to today in ET (the
   * walk-up rail, where purchase day == race day).
   *
   * Every caller already derives `schedule` from this same date, so passing it is
   * free — but it is a SEPARATE field rather than replacing `schedule`, because a
   * `Schedule` buckets Tuesday as "mega" and cannot name a single weekday.
   */
  raceDate?: string | null;
  /** Evaluation instant for `bookableFrom`/`bookableUntil`, and the ET fallback
   *  for `raceDays` when no `raceDate` is given. Defaults to now; inject in tests
   *  so window boundaries are assertable without a clock. */
  now?: Date;
}

const QUAL_RANK: Record<PackageTier, number> = { starter: 0, intermediate: 1, pro: 2 };

/**
 * Is a limited-time bundle still offered at `now`? ET wall-clock via
 * `etOffsetForLocalDate` — never a hardcoded offset (that is the Dec-19
 * 6pm→5pm bug). THROWS on a malformed `bookableUntil`: an Invalid Date
 * compares false against everything, so a typo would silently read as
 * "already over" and the bundle would never appear at all.
 */
function withinBookableWindow(pkg: PackageDefinition, now: Date): boolean {
  const bound = (raw: string, field: string): number => {
    const d = new Date(`${raw}${etOffsetForLocalDate(raw)}`);
    if (Number.isNaN(d.getTime())) {
      throw new Error(`package ${field} is not a valid date: ${raw}`);
    }
    return d.getTime();
  };
  if (pkg.bookableFrom && now.getTime() < bound(pkg.bookableFrom, "bookableFrom")) return false;
  if (pkg.bookableUntil && now.getTime() > bound(pkg.bookableUntil, "bookableUntil")) return false;
  return true;
}

/**
 * Does a bundle's recurring `raceDays` rule admit a race on `raceDate`? True for
 * every bundle without the field (all the standing ones), so this is safe to call
 * unconditionally. A null/undefined `raceDate` falls back to today in ET.
 *
 * The day arithmetic lives in `withinRecurringDayRule` and is shared with the
 * CREDIT-PACK half of the same promo (features/booking/data/packs.ts), so the ET
 * fallback, the local `YYYY-MM-DD` parse and the `from` floor cannot drift
 * between the two registries.
 *
 * Exported because it is also the invalidation rule when a guest CHANGES their
 * race date mid-booking (features/booking/state/machine.ts): a bundle picked for
 * a Wednesday must not survive a move to Thursday still priced at the deal.
 */
export function packageFitsRaceDate(
  pkg: PackageDefinition,
  raceDate: string | null | undefined,
  now: Date = new Date(),
): boolean {
  return !pkg.raceDays || withinRecurringDayRule(pkg.raceDays, raceDate, now);
}

/** Filters the registry to packages bookable in the current context.
 *  Used by the product picker to render its "packages" row. Sorted
 *  by `displayOrder` ascending so featured packages float to the
 *  top of the picker. Ties fall back to registry order. */
export function eligiblePackages(ctx: EligibilityContext): PackageDefinition[] {
  return PACKAGES.filter((p) => {
    if (!p.enabled) return false;
    if ((p.bookableFrom || p.bookableUntil) && !withinBookableWindow(p, ctx.now ?? new Date())) {
      return false;
    }
    if (!packageFitsRaceDate(p, ctx.raceDate, ctx.now ?? new Date())) return false;
    if (p.racerType !== "any" && ctx.racerType && p.racerType !== ctx.racerType) return false;
    if (
      p.maxQualifiedTier &&
      QUAL_RANK[ctx.qualifiedTier ?? "starter"] > QUAL_RANK[p.maxQualifiedTier]
    ) {
      return false;
    }
    if (ctx.schedule && !p.schedules.includes(ctx.schedule)) return false;
    if (p.category !== "any" && ctx.category && p.category !== ctx.category) return false;
    return true;
  }).sort((a, b) => (a.displayOrder ?? 100) - (b.displayOrder ?? 100));
}

/** Per-racer total for a package. When the package didn't pin an
 *  explicit `price`, sums:
 *   - each race component's primary-track price
 *   - $4.99 license if `includesLicense`
 *   - $5 POV per racer if `includesPov`
 *  Appetizer code is treated as $0 (free promo).
 *
 *  For multi-track components the primary track's price is used as
 *  the seed — Red and Blue currently price identically per schedule
 *  so the customer-visible total stays correct regardless of which
 *  track they pick at heat-selection time.
 */
export function packagePerRacerPrice(pkg: PackageDefinition): number {
  if (typeof pkg.price === "number") return pkg.price;
  let sum = pkg.races.reduce((acc, r) => acc + (primaryTrack(r)?.price || 0), 0);
  if (pkg.includesLicense) sum += LICENSE_PRICE;
  if (pkg.includesPov) sum += POV_PRICE;
  return sum;
}

/** Total price for a group of N racers. Heats are shared across
 *  racers (multi-racer "all share heats" pattern) but every racer
 *  needs their own license + POV, so this is straightforward
 *  per-racer-times-N math. */
export function packageBundleTotal(pkg: PackageDefinition, racerCount: number): number {
  return packagePerRacerPrice(pkg) * Math.max(1, racerCount);
}

/** What the bundle's contents would have cost if bought separately
 *  at retail — drives the "💰 Save $X" line on the picker card.
 *  Compared against `packageBundleTotal` to compute savings. */
export function packageRetailTotal(pkg: PackageDefinition, racerCount: number): number {
  const racers = Math.max(1, racerCount);
  let total = pkg.races.reduce((acc, r) => acc + (primaryTrack(r)?.price || 0), 0) * racers;
  if (pkg.includesLicense) total += LICENSE_PRICE * racers;
  // POV at retail check-in price — $2 more per racer than online.
  if (pkg.includesPov) total += POV_CHECKIN_PRICE * racers;
  // Appetizer is "one per group" so a flat retail value, not × N.
  if (pkg.appetizerCode) total += APPETIZER_RETAIL_VALUE;
  return total;
}

/** Convenience: how much the customer saves vs. piecing the bundle
 *  together at retail. Returns 0 when retail ≤ bundle (e.g. a
 *  package configured at parity, no savings to claim). */
export function packageSavings(pkg: PackageDefinition, racerCount: number): number {
  const retail = packageRetailTotal(pkg, racerCount);
  const total = packageBundleTotal(pkg, racerCount);
  return Math.max(0, retail - total);
}

/** Lowest per-racer price (dollars) across ENABLED variants of a package family
 *  (id prefix, e.g. "ultimate-qualifier"). Powers the kiosk/marketing
 *  "From $X/person" teaser. Pass `schedules` to scope the floor to a day
 *  tier — e.g. ["weekday", "mega"] = Mon–Thu (Mega Tuesday counts as
 *  weekday), ["weekend"] = Fri–Sun; a variant matches when it runs on ANY
 *  of the given schedules. null when no enabled variant matches. */
export function packageFamilyFromPrice(
  familyPrefix: string,
  schedules?: Schedule[],
): number | null {
  const prices = PACKAGES.filter(
    (p) =>
      p.enabled &&
      p.id.startsWith(familyPrefix) &&
      (!schedules || p.schedules.some((s) => schedules.includes(s))),
  ).map(packagePerRacerPrice);
  return prices.length ? Math.min(...prices) : null;
}

/** Pull the gap rule for a component, if any. */
export function packageHeatGapMinutes(
  component: PackageRaceComponent,
): { ref: string; minutes: number; sameTrackMinutes?: number } | null {
  return component.minMinutesAfterEndOf ?? null;
}

/**
 * The LOOSEST gap this component's rule can ever resolve to — the same-track
 * relaxation where there is one, else the base. 0 when the component has no
 * gap rule.
 *
 * Card gates and the kiosk availability tile use this to answer "could ANY
 * pairing fit today?" without redoing the per-track math. It must be derived,
 * not hardcoded: those gates carried a literal 30 until Mega dropped to 20
 * (owner 2026-08-04), at which point a fixed floor would have greyed out a
 * package the heat picker was still willing to book.
 */
export function packageLoosestGapMinutes(component: PackageRaceComponent): number {
  const rule = component.minMinutesAfterEndOf;
  if (!rule) return 0;
  return Math.min(rule.minutes, rule.sameTrackMinutes ?? rule.minutes);
}

/** Derive the current schedule slot from a date. A Mega day = "mega",
 *  Fri/Sat/Sun = "weekend", everything else = "weekday". The v2 twin lives
 *  at `~/features/booking/service/race-pricing`; both defer to
 *  `mega-calendar` for which days are Mega, so the two cannot drift on the
 *  one question that has actually changed.
 *
 *  Important: when given a `YYYY-MM-DD` string we parse it as LOCAL
 *  time, not UTC. `new Date("2026-04-28")` resolves to UTC midnight
 *  which shifts back into Monday for any negative-offset timezone
 *  (US/ET, etc.) and then `getDay()` returns the wrong weekday —
 *  the symptom that hid the Ultimate Qualifier card from the picker
 *  for an entire Tuesday. */
export function scheduleForDate(d: Date | string): Schedule {
  if (isMegaDay(d)) return "mega";
  let day: number;
  if (typeof d === "string") {
    const datePart = d.split("T")[0];
    const m = datePart.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) {
      // Local-time construction — sidesteps the UTC parse trap.
      day = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getDay();
    } else {
      day = new Date(d).getDay();
    }
  } else {
    day = d.getDay();
  }
  if (day === 0 || day === 5 || day === 6) return "weekend";
  return "weekday";
}
