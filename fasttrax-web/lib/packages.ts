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
  | "rookie-pack-weekend"
  | "ultimate-qualifier-mega"
  | "rookie-pack"; // legacy alias kept for confirmation-page back-compat
export type Schedule = "weekday" | "weekend" | "mega";

export interface PackageRaceComponent {
  /** 1-indexed sequence — drives the order in PackageHeatPicker. */
  sequence: number;
  /** Stable cross-component reference name (e.g. "starter",
   *  "intermediate"). Used by `minMinutesAfterEndOf` and the heat
   *  picker's "what's the previous heat I picked" lookup. */
  ref: string;
  /** BMI productId. */
  productId: string;
  /** BMI pageId the product is sold from. */
  pageId: string;
  /** Display label (cart, review, hero card). */
  label: string;
  tier: "starter" | "intermediate" | "pro";
  track: "Red" | "Blue" | "Mega";
  /** Per-unit price USED ONLY AS FALLBACK when the live BMI price
   *  fetch (in the picker / cart) hasn't returned yet or fails.
   *  The picker pulls the authoritative price from BMI's
   *  /availability endpoint at render time so the registry never
   *  drifts from BMI's catalog. */
  price: number;
  /** Heat-gap rule against an earlier component's STOP time.
   *  e.g. `{ ref: "starter", minutes: 60 }` means "this heat must
   *  start ≥ 60 min after the starter heat ends". */
  minMinutesAfterEndOf?: { ref: string; minutes: number };
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
    category: "any",
    races: [
      {
        sequence: 1,
        ref: "starter",
        productId: "24965505",
        pageId: "24966930",
        label: "Starter Race Mega",
        tier: "starter",
        track: "Mega",
        price: 20.99,
      },
    ],
    includesLicense: true,
    includesPov: true,
    appetizerCode: "RACEAPP",
    cartLineKey: "rookie-pack",
    displayOrder: 20,
  },
  // ── Rookie Pack — Weekday (Mon/Wed/Thu) ───────────────────────────────────
  // Defaults to Blue Track. Customers wanting Red Rookie Pack can pick
  // a regular Red starter and add the bundle at the POV step (existing
  // PovUpsell upgrade path still works there).
  {
    id: "rookie-pack-weekday",
    name: "Rookie Pack",
    shortDescription: "Starter Race Blue + License + POV + free appetizer",
    longDescription: ROOKIE_LONG,
    enabled: ROOKIE_PACK_ENABLED,
    racerType: "new",
    schedules: ["weekday"],
    category: "any",
    races: [
      {
        sequence: 1,
        ref: "starter",
        productId: "24960393",
        pageId: "24961568",
        label: "Starter Race Blue",
        tier: "starter",
        track: "Blue",
        price: 20.99,
      },
    ],
    includesLicense: true,
    includesPov: true,
    appetizerCode: "RACEAPP",
    cartLineKey: "rookie-pack",
    displayOrder: 20,
  },
  // ── Rookie Pack — Weekend (Fri/Sat/Sun) ───────────────────────────────────
  {
    id: "rookie-pack-weekend",
    name: "Rookie Pack",
    shortDescription: "Starter Race Blue + License + POV + free appetizer",
    longDescription: ROOKIE_LONG,
    enabled: ROOKIE_PACK_ENABLED,
    racerType: "new",
    schedules: ["weekend"],
    category: "any",
    races: [
      {
        sequence: 1,
        ref: "starter",
        productId: "24952964",
        pageId: "24871574",
        label: "Starter Race Blue",
        tier: "starter",
        track: "Blue",
        price: 26.99,
      },
    ],
    includesLicense: true,
    includesPov: true,
    appetizerCode: "RACEAPP",
    cartLineKey: "rookie-pack",
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
    longDescription:
      "This is the premier FastTrax experience. Think you have what it takes to level up? This isn't for the faint of heart. You'll qualify in one of our Starter races, and if you level up, your Intermediate race will be waiting for you — scheduled an hour later. While you wait, you can review the included POV video to get better and enjoy a free appetizer at Nemo's upstairs (one per group, dine-in only). This ultimate pack also includes your license.",
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
        productId: "24965505", // existing Starter Race Mega (new-racer)
        pageId: "24966930",
        label: "Starter Race Mega",
        tier: "starter",
        track: "Mega",
        price: 20.99,
      },
      {
        sequence: 2,
        ref: "intermediate",
        productId: "45810775", // NEW — Ultimate-Qualifier-only Intermediate Mega
        pageId: "25850647",     // verify before launch (see comment above)
        label: "Intermediate Race Mega",
        tier: "intermediate",
        track: "Mega",
        price: 20.99,
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
    disclaimers: {
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
    },
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
 *   - each race component's `price`
 *   - $4.99 license if `includesLicense`
 *   - $5 POV per racer if `includesPov`
 *  Appetizer code is treated as $0 (free promo).
 */
export function packagePerRacerPrice(pkg: PackageDefinition): number {
  if (typeof pkg.price === "number") return pkg.price;
  let sum = pkg.races.reduce((acc, r) => acc + (r.price || 0), 0);
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
  let total = pkg.races.reduce((acc, r) => acc + r.price, 0) * racers;
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
