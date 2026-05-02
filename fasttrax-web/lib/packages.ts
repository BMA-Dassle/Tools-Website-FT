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
 *     ends")
 *   - whether it includes the FastTrax license, POV, and/or a free
 *     appetizer code
 *   - eligibility (racerType, schedule, category)
 *   - pricing — explicit total, or fall back to sum-of-components
 *
 * Intentionally stateless data — every consumer pulls a definition
 * by id (`getPackage`) and reads only the fields it cares about.
 */

// ── Shared component prices ─────────────────────────────────────────────────
// Stays here so PovUpsell, OrderSummary, the cart sync, and the
// auto-sum helper agree on a single number.

export const LICENSE_PRICE = 4.99;
export const POV_PRICE = 5;
// "Retail" anchors for savings comparisons. POV at the counter is
// $2 more per racer than the prepay-online price; the appetizer
// carries a real menu value at Nemo's. Used by the picker card +
// review hero card to show "you save $X".
export const POV_CHECKIN_PRICE = 7;
// $15 menu retail at Nemo's — counts toward the package savings
// line so customers see the full bundle value vs. piecing the
// gear together at the counter + ordering an app separately.
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
   *  start ≥ 60 min after the starter heat ends". */
  minMinutesAfterEndOf?: { ref: string; minutes: number };
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
  /** Free-appetizer redeem code shown on the confirmation page.
   *  Same for Rookie Pack and Ultimate Qualifier today (RACEAPP);
   *  the field exists so future packages can diverge. */
  appetizerCode?: string;

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

  /** Optional disclaimer modal shown when the user picks the package
   *  card. All `acks` checkboxes must be ticked before they can
   *  continue. Used by Ultimate Qualifier to make clear the
   *  Intermediate race is conditional on qualifying.
   *
   *  `billMemo` is appended to the BMI bill after heats book so
   *  ops staff sees the acknowledgment trail + any handling rules
   *  (e.g. "verify level-up before assigning to Intermediate"). */
  disclaimers?: {
    title: string;
    body: string;
    acks: string[];
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
  "This is the premier FastTrax experience. Think you have what it takes to level up? This isn't for the faint of heart. You'll qualify in one of our Starter races, and if you level up, your Intermediate race will be waiting for you — scheduled an hour later. While you wait, you can review the included POV video to get better and enjoy a free appetizer at Nemo's upstairs (one per group, dine-in only). This ultimate pack also includes your license.";

const UQ_DISCLAIMERS: PackageDefinition["disclaimers"] = {
  title: "Heads Up — Ultimate Qualifier",
  body:
    "Your Intermediate race in this package is reserved on the assumption you qualify in your Starter heat. About 75% of new racers level up on their first try. If you don't qualify, no problem — but please read carefully before continuing:",
  acks: [
    "I understand the Intermediate race is reserved only if I qualify (level up) in my Starter race",
    "If I don't qualify, FastTrax will offer me another Starter race (if available) OR race credit toward a future visit — no cash refunds for this package",
    "I have read and accept these terms",
  ],
  billMemo:
    "** ULTIMATE QUALIFIER ** Customer is a NEW racer — has NOT yet qualified for Intermediate. STAFF: verify level-up before assigning kart to the Intermediate race. If customer did not qualify: offer additional Starter (if available) OR issue race credit. NO cash refunds — customer acknowledged disclaimer at booking.",
};

const ROOKIE_LONG = "Your first race plus everything you need to remember it: FastTrax license, ViewPoint POV camera footage, and a free appetizer at Nemo's upstairs (one per group, dine-in only).";

const PACKAGES: PackageDefinition[] = [
  // ── Rookie Pack — Mega (Tuesday) ──────────────────────────────────────────
  // Per-schedule variants so the picker can render a single card with
  // a definitive Starter race component (vs. the old `races: []` form
  // that needed extra plumbing to combine with a separately-picked
  // race). Pricing auto-sums from the components.
  {
    id: "rookie-pack-mega",
    name: "Rookie Pack",
    shortDescription: "Starter Mega + License + POV + free appetizer",
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
        tracks: [
          { track: "Mega", productId: "24965505", pageId: "24966930", price: 20.99 },
        ],
      },
    ],
    includesLicense: true,
    includesPov: true,
    appetizerCode: "RACEAPP",
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
    name: "Rookie Pack",
    shortDescription: "Starter Race + License + POV + free appetizer",
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
          { track: "Red",  productId: "24960859", pageId: "24961568", price: 20.99 },
          { track: "Blue", productId: "24960393", pageId: "24961568", price: 20.99 },
        ],
      },
    ],
    includesLicense: true,
    includesPov: true,
    appetizerCode: "RACEAPP",
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
    name: "Rookie Pack",
    shortDescription: "Junior Starter Blue + License + POV + free appetizer",
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
    appetizerCode: "RACEAPP",
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
    name: "Rookie Pack",
    shortDescription: "Starter Race + License + POV + free appetizer",
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
          { track: "Red",  productId: "24953280", pageId: "24871574", price: 26.99 },
          { track: "Blue", productId: "24952964", pageId: "24871574", price: 26.99 },
        ],
      },
    ],
    includesLicense: true,
    includesPov: true,
    appetizerCode: "RACEAPP",
    cartLineKey: "rookie-pack",
    displayOrder: 20,
  },
  // ── Rookie Pack — Weekend Junior (Fri/Sat/Sun) ────────────────────────────
  // Junior counterpart — Blue Track only (no Red junior product).
  // Junior weekend Starter is $19.99.
  {
    id: "rookie-pack-weekend-junior",
    name: "Rookie Pack",
    shortDescription: "Junior Starter Blue + License + POV + free appetizer",
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
    appetizerCode: "RACEAPP",
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
    name: "Rookie Pack",
    shortDescription: "Starter race + license + POV + free appetizer",
    longDescription: ROOKIE_LONG,
    enabled: false,
    racerType: "new",
    schedules: ["weekday", "weekend", "mega"],
    category: "any",
    races: [],
    includesLicense: true,
    includesPov: true,
    appetizerCode: "RACEAPP",
    price: LICENSE_PRICE + POV_PRICE,
    cartLineKey: "rookie-pack",
  },

  // ── Ultimate Qualifier (Mega) ─────────────────────────────────────────────
  // Premier package for Mega Tuesdays. Books two heats — Starter
  // Mega first, then Intermediate Mega ≥ 60 min after the Starter
  // ends so the racer has time to qualify, watch the included POV
  // video, and grab their free appetizer.
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
    name: "Ultimate Qualifier",
    shortDescription:
      "Starter Mega + Intermediate Mega + license + POV + free appetizer",
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
        minMinutesAfterEndOf: { ref: "starter", minutes: 60 },
      },
    ],
    includesLicense: true,
    includesPov: true,
    appetizerCode: "RACEAPP",
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
    name: "Ultimate Qualifier",
    shortDescription:
      "Starter + Intermediate + License + POV + free appetizer",
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
          { track: "Red",  productId: "24960859", pageId: "24961568", price: 20.99 },
          { track: "Blue", productId: "24960393", pageId: "24961568", price: 20.99 },
        ],
      },
      {
        sequence: 2,
        ref: "intermediate",
        label: "Intermediate Race",
        tier: "intermediate",
        tracks: [
          { track: "Red",  productId: "45810802", pageId: "25850629", price: 20.99 },
          { track: "Blue", productId: "45811366", pageId: "25850629", price: 20.99 },
        ],
        minMinutesAfterEndOf: { ref: "starter", minutes: 60 },
      },
    ],
    includesLicense: true,
    includesPov: true,
    appetizerCode: "RACEAPP",
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
    name: "Ultimate Qualifier",
    shortDescription:
      "Junior Starter Blue + Junior Intermediate Blue + License + POV + free appetizer",
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
        minMinutesAfterEndOf: { ref: "starter", minutes: 60 },
      },
    ],
    includesLicense: true,
    includesPov: true,
    appetizerCode: "RACEAPP",
    cartLineKey: "ultimate-qualifier-weekday-junior",
    displayOrder: 10,
    disclaimers: UQ_DISCLAIMERS,
  },

  // ── Ultimate Qualifier — Weekend (Adult, Red + Blue) ──────────────────────
  // Weekend Starter / Intermediate pricing is $26.99 (vs. $20.99 weekday).
  // Heat picker spans both tracks in one merged grid — same UX as the
  // weekday variant above. New package-only weekend Intermediate SKUs:
  // 45811390 (Red) and 45811415 (Blue). pageId guess: weekend
  // Intermediate page (25850598). Verify before launch.
  {
    id: "ultimate-qualifier-weekend",
    name: "Ultimate Qualifier",
    shortDescription:
      "Starter + Intermediate + License + POV + free appetizer",
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
          { track: "Red",  productId: "24953280", pageId: "24871574", price: 26.99 },
          { track: "Blue", productId: "24952964", pageId: "24871574", price: 26.99 },
        ],
      },
      {
        sequence: 2,
        ref: "intermediate",
        label: "Intermediate Race",
        tier: "intermediate",
        tracks: [
          { track: "Red",  productId: "45811390", pageId: "25850598", price: 26.99 },
          { track: "Blue", productId: "45811415", pageId: "25850598", price: 26.99 },
        ],
        minMinutesAfterEndOf: { ref: "starter", minutes: 60 },
      },
    ],
    includesLicense: true,
    includesPov: true,
    appetizerCode: "RACEAPP",
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
    name: "Ultimate Qualifier",
    shortDescription:
      "Junior Starter Blue + Junior Intermediate Blue + License + POV + free appetizer",
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
        minMinutesAfterEndOf: { ref: "starter", minutes: 60 },
      },
    ],
    includesLicense: true,
    includesPov: true,
    appetizerCode: "RACEAPP",
    cartLineKey: "ultimate-qualifier-weekend-junior",
    displayOrder: 10,
    disclaimers: UQ_DISCLAIMERS,
  },
];

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Lookup a package definition by id. Returns null when the id is
 *  unknown or the feature flag has it disabled — callers should
 *  treat both cases as "package unavailable". */
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
}

/** Filters the registry to packages bookable in the current context.
 *  Used by the product picker to render its "packages" row. Sorted
 *  by `displayOrder` ascending so featured packages float to the
 *  top of the picker. Ties fall back to registry order. */
export function eligiblePackages(ctx: EligibilityContext): PackageDefinition[] {
  return PACKAGES.filter((p) => {
    if (!p.enabled) return false;
    if (p.racerType !== "any" && ctx.racerType && p.racerType !== ctx.racerType) return false;
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

/** Pull the gap rule for a component, if any. */
export function packageHeatGapMinutes(component: PackageRaceComponent): { ref: string; minutes: number } | null {
  return component.minMinutesAfterEndOf ?? null;
}

/** Derive the current schedule slot from a date. Tuesday = "mega",
 *  Mon/Wed/Thu = "weekday", Fri/Sat/Sun = "weekend". Mirrors the
 *  classification in `app/book/race/data.ts`.
 *
 *  Important: when given a `YYYY-MM-DD` string we parse it as LOCAL
 *  time, not UTC. `new Date("2026-04-28")` resolves to UTC midnight
 *  which shifts back into Monday for any negative-offset timezone
 *  (US/ET, etc.) and then `getDay()` returns the wrong weekday —
 *  the symptom that hid the Ultimate Qualifier card from the picker
 *  for an entire Tuesday. */
export function scheduleForDate(d: Date | string): Schedule {
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
  if (day === 2) return "mega";
  if (day === 0 || day === 5 || day === 6) return "weekend";
  return "weekday";
}
