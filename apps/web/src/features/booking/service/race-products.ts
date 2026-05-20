/**
 * Static race product registry — what v2 race v2 knows about FastTrax race
 * BMI products.
 *
 * Ported from v1 `apps/web/app/book/race/data.ts` (RACE_PRODUCTS + helpers).
 * v1 keeps the catalog in code rather than fetching BMI's GET /page so:
 *   - BMI race pages can be private (hidden from BMI's own booking widget).
 *   - The customer-facing wizard renders instantly without a vendor call.
 *   - Tier qualifications, junior/adult split, per-track variants live in
 *     one obvious file.
 *
 * v2 reads from here in the race product step; the BMI adapter still uses
 * `bookHeat({ productId })` so this registry just owns the productId-to-
 * tier-and-track resolution.
 *
 * **Race-pack credit products are NOT here** — those live in PR-B4 (see
 * `tasks/future/race-pack-as-credit-purchase.md`). The 3-pack day-of
 * products below ARE here because they're combo bookings (3 heats on
 * one bill), not credit grants.
 *
 * Keep this file in lockstep with v1 `app/book/race/data.ts` until that
 * file is retired. When BMI product IDs change there, mirror here.
 */
import type { Schedule } from "./race-pricing";

export type RaceTier = "starter" | "intermediate" | "pro";
export type RaceCategory = "adult" | "junior";
export type RacerType = "new" | "existing";
export type PackType = "none" | "sell" | "combo";

/** A single race product the customer can book. */
export interface RaceProduct {
  schedule: Schedule;
  racerType: RacerType;
  productId: string;
  pageId: string;
  name: string;
  tier: RaceTier;
  category: RaceCategory;
  /** "Red" | "Blue" | "Mega" or null for multi-track packs. */
  track: string | null;
  price: number;
  /** "combo" = book N heats on one bill via BMI booking/book (multi-heat
   *  3-pack day-of products). "sell" = credit-pack purchase (DEFERRED to
   *  PR-B4; filtered out of the wizard for now). */
  packType?: PackType;
  /** How many heats the customer must pick (combo packs only). */
  raceCount?: number;
  /** Mixed-track packs (e.g. weekday Int 3-Pack: Red + Blue): map each
   *  track label to the BMI product that books heats on that track. The
   *  parent entry's productId/pageId still drives the UI card. */
  trackProducts?: Record<string, { productId: string; pageId: string }>;
}

const RACE_PRODUCTS: RaceProduct[] = [
  // ════════════════════════════════════════════════════════════════════════
  // NEW RACERS
  // ════════════════════════════════════════════════════════════════════════

  // ── Weekday (Mon/Wed/Thu) — Page 24961568: Starter ──
  {
    schedule: "weekday",
    racerType: "new",
    productId: "24960859",
    pageId: "24961568",
    name: "Starter Race Red",
    tier: "starter",
    category: "adult",
    track: "Red",
    price: 20.99,
  },
  {
    schedule: "weekday",
    racerType: "new",
    productId: "24960393",
    pageId: "24961568",
    name: "Starter Race Blue",
    tier: "starter",
    category: "adult",
    track: "Blue",
    price: 20.99,
  },
  {
    schedule: "weekday",
    racerType: "new",
    productId: "24960106",
    pageId: "24961568",
    name: "Junior Starter Race Blue",
    tier: "starter",
    category: "junior",
    track: "Blue",
    price: 15.99,
  },
  // ── Weekday — Page 25850629: Intermediate ──
  {
    schedule: "weekday",
    racerType: "new",
    productId: "24960650",
    pageId: "25850629",
    name: "Intermediate Race Red",
    tier: "intermediate",
    category: "adult",
    track: "Red",
    price: 20.99,
  },
  {
    schedule: "weekday",
    racerType: "new",
    productId: "24958077",
    pageId: "25850629",
    name: "Intermediate Race Blue",
    tier: "intermediate",
    category: "adult",
    track: "Blue",
    price: 20.99,
  },
  {
    schedule: "weekday",
    racerType: "new",
    productId: "24958587",
    pageId: "25850629",
    name: "Junior Intermediate Race Blue",
    tier: "intermediate",
    category: "junior",
    track: "Blue",
    price: 20.99,
  },
  // ── Weekday — Page 25850669: Pro ──
  {
    schedule: "weekday",
    racerType: "new",
    productId: "24963023",
    pageId: "25850669",
    name: "Pro Race Red",
    tier: "pro",
    category: "adult",
    track: "Red",
    price: 20.99,
  },
  {
    schedule: "weekday",
    racerType: "new",
    productId: "24963136",
    pageId: "25850669",
    name: "Pro Race Blue",
    tier: "pro",
    category: "adult",
    track: "Blue",
    price: 20.99,
  },
  {
    schedule: "weekday",
    racerType: "new",
    productId: "24963258",
    pageId: "25850669",
    name: "Junior Pro Blue",
    tier: "pro",
    category: "junior",
    track: "Blue",
    price: 20.99,
  },

  // ── Weekend (Fri/Sat/Sun) — Page 24871574: Starter ──
  {
    schedule: "weekend",
    racerType: "new",
    productId: "24953280",
    pageId: "24871574",
    name: "Starter Race Red",
    tier: "starter",
    category: "adult",
    track: "Red",
    price: 26.99,
  },
  {
    schedule: "weekend",
    racerType: "new",
    productId: "24952964",
    pageId: "24871574",
    name: "Starter Race Blue",
    tier: "starter",
    category: "adult",
    track: "Blue",
    price: 26.99,
  },
  {
    schedule: "weekend",
    racerType: "new",
    productId: "24953399",
    pageId: "24871574",
    name: "Junior Starter Race Blue",
    tier: "starter",
    category: "junior",
    track: "Blue",
    price: 19.99,
  },
  // ── Weekend — Page 25850598: Intermediate ──
  {
    schedule: "weekend",
    racerType: "new",
    productId: "24964317",
    pageId: "25850598",
    name: "Intermediate Race Red",
    tier: "intermediate",
    category: "adult",
    track: "Red",
    price: 26.99,
  },
  {
    schedule: "weekend",
    racerType: "new",
    productId: "24952410",
    pageId: "25850598",
    name: "Intermediate Race Blue",
    tier: "intermediate",
    category: "adult",
    track: "Blue",
    price: 26.99,
  },
  {
    schedule: "weekend",
    racerType: "new",
    productId: "24954302",
    pageId: "25850598",
    name: "Junior Intermediate Race Blue",
    tier: "intermediate",
    category: "junior",
    track: "Blue",
    price: 20.99,
  },

  // ── Mega Tuesday — Page 24966930: Starter ──
  {
    schedule: "mega",
    racerType: "new",
    productId: "24965505",
    pageId: "24966930",
    name: "Starter Race Mega",
    tier: "starter",
    category: "adult",
    track: "Mega",
    price: 20.99,
  },
  // ── Mega — Page 25850647: Intermediate ──
  {
    schedule: "mega",
    racerType: "new",
    productId: "24965707",
    pageId: "25850647",
    name: "Intermediate Race Mega",
    tier: "intermediate",
    category: "adult",
    track: "Mega",
    price: 20.99,
  },
  {
    schedule: "mega",
    racerType: "new",
    productId: "24966320",
    pageId: "25850647",
    name: "Junior Intermediate Race Mega",
    tier: "intermediate",
    category: "junior",
    track: "Mega",
    price: 20.99,
  },
  // ── Mega — Page 25850658: Pro ──
  {
    schedule: "mega",
    racerType: "new",
    productId: "24965768",
    pageId: "25850658",
    name: "Pro Race Mega",
    tier: "pro",
    category: "adult",
    track: "Mega",
    price: 20.99,
  },
  {
    schedule: "mega",
    racerType: "new",
    productId: "24966863",
    pageId: "25850658",
    name: "Junior Pro Race Mega",
    tier: "pro",
    category: "junior",
    track: "Mega",
    price: 20.99,
  },

  // ════════════════════════════════════════════════════════════════════════
  // RETURNING RACERS — Page 43734751
  // ════════════════════════════════════════════════════════════════════════

  // ── Weekday ──
  {
    schedule: "weekday",
    racerType: "existing",
    productId: "43734325",
    pageId: "43734751",
    name: "Starter Race Blue",
    tier: "starter",
    category: "adult",
    track: "Blue",
    price: 20.99,
  },
  {
    schedule: "weekday",
    racerType: "existing",
    productId: "43734615",
    pageId: "43734751",
    name: "Starter Race Red",
    tier: "starter",
    category: "adult",
    track: "Red",
    price: 20.99,
  },
  {
    schedule: "weekday",
    racerType: "existing",
    productId: "43726976",
    pageId: "43734751",
    name: "Intermediate Race Blue",
    tier: "intermediate",
    category: "adult",
    track: "Blue",
    price: 20.99,
  },
  {
    schedule: "weekday",
    racerType: "existing",
    productId: "43727363",
    pageId: "43734751",
    name: "Intermediate Race Red",
    tier: "intermediate",
    category: "adult",
    track: "Red",
    price: 20.99,
  },
  {
    schedule: "weekday",
    racerType: "existing",
    productId: "43733371",
    pageId: "43734751",
    name: "Pro Race Blue",
    tier: "pro",
    category: "adult",
    track: "Blue",
    price: 20.99,
  },
  {
    schedule: "weekday",
    racerType: "existing",
    productId: "43733839",
    pageId: "43734751",
    name: "Pro Race Red",
    tier: "pro",
    category: "adult",
    track: "Red",
    price: 20.99,
  },
  {
    schedule: "weekday",
    racerType: "existing",
    productId: "43733263",
    pageId: "43734751",
    name: "Junior Starter Race Blue",
    tier: "starter",
    category: "junior",
    track: "Blue",
    price: 15.99,
  },
  {
    schedule: "weekday",
    racerType: "existing",
    productId: "43732159",
    pageId: "43734751",
    name: "Junior Intermediate Race Blue",
    tier: "intermediate",
    category: "junior",
    track: "Blue",
    price: 15.99,
  },
  {
    schedule: "weekday",
    racerType: "existing",
    productId: "43732593",
    pageId: "43734751",
    name: "Junior Pro Blue",
    tier: "pro",
    category: "junior",
    track: "Blue",
    price: 15.99,
  },

  // ── Weekend (no Pro on weekends) ──
  {
    schedule: "weekend",
    racerType: "existing",
    productId: "43734229",
    pageId: "43734751",
    name: "Starter Race Blue",
    tier: "starter",
    category: "adult",
    track: "Blue",
    price: 26.99,
  },
  {
    schedule: "weekend",
    racerType: "existing",
    productId: "43734485",
    pageId: "43734751",
    name: "Starter Race Red",
    tier: "starter",
    category: "adult",
    track: "Red",
    price: 26.99,
  },
  {
    schedule: "weekend",
    racerType: "existing",
    productId: "43726940",
    pageId: "43734751",
    name: "Intermediate Race Blue",
    tier: "intermediate",
    category: "adult",
    track: "Blue",
    price: 26.99,
  },
  {
    schedule: "weekend",
    racerType: "existing",
    productId: "43727216",
    pageId: "43734751",
    name: "Intermediate Race Red",
    tier: "intermediate",
    category: "adult",
    track: "Red",
    price: 26.99,
  },
  {
    schedule: "weekend",
    racerType: "existing",
    productId: "43733133",
    pageId: "43734751",
    name: "Junior Starter Race Blue",
    tier: "starter",
    category: "junior",
    track: "Blue",
    price: 19.99,
  },
  {
    schedule: "weekend",
    racerType: "existing",
    productId: "43729633",
    pageId: "43734751",
    name: "Junior Intermediate Race Blue",
    tier: "intermediate",
    category: "junior",
    track: "Blue",
    price: 20.99,
  },

  // ── Mega Tuesday ──
  {
    schedule: "mega",
    racerType: "existing",
    productId: "43734407",
    pageId: "43734751",
    name: "Starter Race Mega",
    tier: "starter",
    category: "adult",
    track: "Mega",
    price: 20.99,
  },
  {
    schedule: "mega",
    racerType: "existing",
    productId: "43727015",
    pageId: "43734751",
    name: "Intermediate Race Mega",
    tier: "intermediate",
    category: "adult",
    track: "Mega",
    price: 20.99,
  },
  {
    schedule: "mega",
    racerType: "existing",
    productId: "43733733",
    pageId: "43734751",
    name: "Pro Race Mega",
    tier: "pro",
    category: "adult",
    track: "Mega",
    price: 20.99,
  },
  {
    schedule: "mega",
    racerType: "existing",
    productId: "43732358",
    pageId: "43734751",
    name: "Junior Intermediate Race Mega",
    tier: "intermediate",
    category: "junior",
    track: "Mega",
    price: 20.99,
  },
  {
    schedule: "mega",
    racerType: "existing",
    productId: "43732675",
    pageId: "43734751",
    name: "Junior Pro Race Mega",
    tier: "pro",
    category: "junior",
    track: "Mega",
    price: 20.99,
  },

  // ════════════════════════════════════════════════════════════════════════
  // PACK WORKAROUND — sell single-race products 3 times.
  //
  // BMI broke race-pack credit assignment on page 42960253 in April 2026.
  // v1's workaround: each entry below is a SINGLE-RACE product priced at
  // pack_price / 3. The wizard gates 3 heat selections per pack and fires
  // booking/book three times against one orderId — 3 separate bill lines
  // at $pack/3 each.
  //
  // packType: "combo" plus raceCount: 3 tells the v2 step components to
  // require 3 heat picks before advancing. Mirrors v1 `ComboPackPicker`.
  //
  // `price` here is the customer-facing pack TOTAL. BMI-side per-heat
  // price drives actual bill-line amounts.
  // ════════════════════════════════════════════════════════════════════════
  {
    schedule: "mega",
    racerType: "existing",
    productId: "45094787",
    pageId: "44286218",
    name: "Pro Mega 3-Pack",
    tier: "pro",
    category: "adult",
    track: "Mega",
    price: 49.98,
    packType: "combo",
    raceCount: 3,
  },
  {
    schedule: "mega",
    racerType: "existing",
    productId: "45094734",
    pageId: "44286218",
    name: "Intermediate Mega 3-Pack",
    tier: "intermediate",
    category: "adult",
    track: "Mega",
    price: 49.98,
    packType: "combo",
    raceCount: 3,
  },

  // Weekday mixed-track 3-packs (Mon/Wed/Thu) — heats can mix Red + Blue.
  // Each selected heat books against the product matching its track.
  {
    schedule: "weekday",
    racerType: "existing",
    productId: "45094857",
    pageId: "25850629",
    name: "Intermediate Weekday 3-Pack",
    tier: "intermediate",
    category: "adult",
    track: null,
    price: 49.98,
    packType: "combo",
    raceCount: 3,
    trackProducts: {
      Red: { productId: "45094857", pageId: "25850629" },
      Blue: { productId: "45094906", pageId: "25850629" },
    },
  },
  {
    schedule: "weekday",
    racerType: "existing",
    productId: "45094954",
    pageId: "25850669",
    name: "Pro Weekday 3-Pack",
    tier: "pro",
    category: "adult",
    track: null,
    price: 49.98,
    packType: "combo",
    raceCount: 3,
    trackProducts: {
      Red: { productId: "45094954", pageId: "25850669" },
      Blue: { productId: "45095003", pageId: "25850669" },
    },
  },

  // Weekend mixed-track Intermediate 3-Pack (Fri/Sat/Sun). No Pro on weekends.
  {
    schedule: "weekend",
    racerType: "existing",
    productId: "45095096",
    pageId: "25850598",
    name: "Intermediate Weekend 3-Pack",
    tier: "intermediate",
    category: "adult",
    track: null,
    price: 59.98,
    packType: "combo",
    raceCount: 3,
    trackProducts: {
      Red: { productId: "45095096", pageId: "25850598" },
      Blue: { productId: "45095051", pageId: "25850598" },
    },
  },
];

// ────────────────────────── lookup + filter helpers ──────────────────────

/** Look up a race product by its BMI productId. Returns null when unknown. */
export function getRaceProductById(
  productId: string | number | null | undefined,
): RaceProduct | null {
  if (productId == null) return null;
  const pid = String(productId);
  return RACE_PRODUCTS.find((p) => p.productId === pid) ?? null;
}

/**
 * All race products for a given (schedule, racerType) pair. The wizard's
 * Product step calls this after the customer picks date + experience,
 * then further filters by adult/junior counts and qualification.
 */
export function productsForSchedule(
  schedule: import("./race-pricing").Schedule,
  racerType: RacerType,
): RaceProduct[] {
  return RACE_PRODUCTS.filter((p) => p.schedule === schedule && p.racerType === racerType);
}

/** Context for filterProducts — what the wizard knows about the party. */
export interface ProductFilterContext {
  racerType: RacerType;
  adultCount: number;
  juniorCount: number;
  /** Membership name strings from BMI. Used to gate Intermediate / Pro for returning racers. */
  memberships?: string[];
}

/**
 * Apply party / qualification filters to a list of products. Ports v1's
 * `filterProducts` logic verbatim:
 *
 *   - Hide credit-pack products (packType === "sell"). Combos stay.
 *   - Hide adult products when no adults; junior products when no juniors.
 *   - New racers see Starter only.
 *   - Returning racers see tiers up to their highest qualification (from
 *     membership names containing "pro" / "intermediate").
 */
export function filterProducts(products: RaceProduct[], ctx: ProductFilterContext): RaceProduct[] {
  const mems = (ctx.memberships ?? []).map((m) => m.toLowerCase());
  const hasPro = mems.some((m) => m.includes("pro"));
  const hasIntermediate = mems.some((m) => m.includes("intermediate"));

  return products.filter((p) => {
    if (p.packType === "sell") return false;
    if (p.category === "adult" && ctx.adultCount === 0) return false;
    if (p.category === "junior" && ctx.juniorCount === 0) return false;

    if (ctx.racerType === "new") {
      return p.tier === "starter";
    }
    if (hasPro) return true;
    if (hasIntermediate) return p.tier === "starter" || p.tier === "intermediate";
    return p.tier === "starter";
  });
}

/**
 * Highest-qualified tier from a list of BMI membership name strings.
 * Mirror of v1 `getRacerTier`. Used by both filter logic above and the
 * UI's tier badge display.
 */
export function tierFromMemberships(memberships: string[]): "Starter" | "Intermediate" | "Pro" {
  const mems = memberships.map((m) => m.toLowerCase());
  if (mems.some((m) => m.includes("pro"))) return "Pro";
  if (mems.some((m) => m.includes("intermediate"))) return "Intermediate";
  return "Starter";
}

/** Substrings used by `filterProducts` + the membership widget to decide
 *  which BMI memberships matter. Ports v1 `RELEVANT_MEMBERSHIP_KEYWORDS`. */
export const RELEVANT_MEMBERSHIP_KEYWORDS = [
  "license fee",
  "intermediate",
  "pro",
  "turbo pass",
  "employee pass",
  "race credit",
];

export function isRelevantMembership(name: string): boolean {
  const lower = name.toLowerCase();
  return RELEVANT_MEMBERSHIP_KEYWORDS.some((kw) => lower.includes(kw));
}

/** Read-only view of the full catalog — for admin / debug surfaces only. */
export function _allRaceProducts(): readonly RaceProduct[] {
  return RACE_PRODUCTS;
}
