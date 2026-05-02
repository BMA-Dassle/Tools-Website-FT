// ── Core types ───────────────────────────────────────────────────────────────

export type RaceTier = "starter" | "intermediate" | "pro";
export type RaceCategory = "adult" | "junior";
export type RacerType = "new" | "existing";

// ── Membership helpers (centralized) ────────────────────────────────────────

/** Substrings to match when filtering BMI memberships for display / qualification checks */
export const RELEVANT_MEMBERSHIP_KEYWORDS = ["license fee", "intermediate", "pro", "turbo pass", "employee pass", "race credit"];

/** Check if a membership name matches any relevant keyword */
export function isRelevantMembership(name: string): boolean {
  const lower = name.toLowerCase();
  return RELEVANT_MEMBERSHIP_KEYWORDS.some(kw => lower.includes(kw));
}

/** Determine a racer's highest qualification tier from their membership names */
export function getRacerTier(memberships: string[]): "Starter" | "Intermediate" | "Pro" {
  const mems = memberships.map(m => m.toLowerCase());
  if (mems.some(m => m.includes("pro"))) return "Pro";
  if (mems.some(m => m.includes("intermediate"))) return "Intermediate";
  return "Starter";
}

// ── BMI Public API types ────────────────────────────────────────────────────

export interface BmiPrice {
  amount: number;
  kind: number;       // 0 = price, 1 = return
  shortName: string;
  depositKind: number; // 0 = money, 1 = point, 2 = credit
}

export interface BmiProduct {
  id: number;
  name: string;
  info: string;
  hasPicture: boolean;
  isCombo: boolean;
  minAge: number | null;
  maxAge: number | null;
  isMembersOnly: boolean;
  minAmount: number;
  maxAmount: number;
  resourceKind: string | null;
  kind: number;        // ProductKind enum: 1=Normal, 2=Entry, 7=Combo
  bookingMode: number; // 0=Individual, 1=PerSlot
  productGroup: string;
  prices: BmiPrice[];
  resources: { id: number; xRef: string | null; kind: string }[];
  dynamicGroups: unknown;
  xRef: string | null;
  // Fields from /products endpoint (not on page endpoint)
  sessionGroup?: string;
  durationSec?: number;
  message?: string;
}

export interface BmiPage {
  id: number;
  name: string;
  kind: number;
  products: BmiProduct[];
}

export interface BmiBlock {
  name: string;
  showSessionTimes?: boolean;
  capacity: number;
  freeSpots: number;
  resourceId: number;
  prices: BmiPrice[];
  bookingMode?: number;
  start: string;
  stop: string;
}

export interface BmiProposalBlock {
  productLineIds: number[];
  block: BmiBlock;
}

export interface BmiProposal {
  blocks: BmiProposalBlock[];
  productLineId: number | null;
}

export interface BmiAvailabilityDay {
  date: string;
  status: number; // 0 = Available, 1 = FullyBooked
}

/** Response from POST /availability */
export interface BmiAvailabilityResponse {
  proposals: BmiProposal[];
}

/** Response from POST /booking/book */
export interface BmiBookResponse {
  schedules: { start: string; name: string; quantity: number; resourceId: number }[];
  orderId: number;
  prices: BmiPrice[];
  success: boolean;
  errorMessage: string | null;
  parentBillLineId?: number;
  projectId?: number;
}

/** Response from POST /booking/sell */
export interface BmiSellResponse {
  orderId: number;
  orderItemId?: number;
  prices: BmiPrice[];
  modifiers?: BmiModifierPage[];
  supplements?: unknown[];
  success: boolean;
  errorMessage: string | null;
}

export interface BmiModifierPage {
  pageId: number;
  minAmount: number;
  maxAmount: number;
  perPerson: boolean;
  products: BmiProduct[];
}

/** A scheduled race within a pack booking */
export interface PackSchedule {
  start: string;
  stop: string;
  name: string;
  trackName?: string;
}

// ── Tax ─────────────────────────────────────────────────────────────────────

export const FL_TAX_RATE = 0.065;

export function calculateTax(subtotal: number): number {
  return Math.round(subtotal * FL_TAX_RATE * 100) / 100;
}

export function calculateTotal(subtotal: number): number {
  return Math.round((subtotal + calculateTax(subtotal)) * 100) / 100;
}

// ── Price lookup ────────────────────────────────────────────────────────────
// BMI Public API product listings don't include prices (prices: null).
// Real prices come from dayplanner blocks at heat selection time.
// Return 0 when no API price is available — UI should hide $0 prices.

function lookupPrice(apiPrice: number): number {
  return apiPrice > 0 ? apiPrice : 0;
}

// ── Static race product registry ────────────────────────────────────────────
// All race products hardcoded so we don't depend on BMI's GET /page endpoint.
// This allows pages to be private in BMI (hidden from BMI's native booking).
// Dayplanner + booking/book still work for private page products.

type Schedule = "weekday" | "weekend" | "mega";

interface StaticRaceProduct {
  schedule: Schedule;
  racerType: RacerType; // "new" or "existing"
  productId: string;
  pageId: string;
  name: string;
  tier: RaceTier;
  category: RaceCategory;
  track: string | null;
  price: number;
  /** Pack type — "combo" books N heats on one bill via booking/book. "sell" uses credits (currently broken). */
  packType?: PackType;
  /** Number of races included in a pack (only meaningful when packType !== "none") */
  raceCount?: number;
  /**
   * For MIXED-track packs (e.g., weekday Intermediate 3-Pack where
   * heats can be any combo of Red + Blue): map each track to the BMI
   * product that books heats on that track.
   *
   * When this is set, ComboPackPicker fetches dayplanner for each
   * entry (union of time slots across tracks) and books each selected
   * heat using the product that matches its track.
   *
   * `track` should be null on the parent entry (since it spans tracks),
   * and `productId`/`pageId` on the parent should point to the primary
   * entry used for the UI card — typically the first track.
   */
  trackProducts?: Record<string, { productId: string; pageId: string }>;
}

const RACE_PRODUCTS: StaticRaceProduct[] = [
  // ════════════════════════════════════════════════════════════════════════
  // NEW RACERS
  // ════════════════════════════════════════════════════════════════════════

  // ── Weekday (Mon, Wed, Thu) — Page 24961568: Starter ──
  { schedule: "weekday", racerType: "new", productId: "24960859", pageId: "24961568", name: "Starter Race Red", tier: "starter", category: "adult", track: "Red", price: 20.99 },
  { schedule: "weekday", racerType: "new", productId: "24960393", pageId: "24961568", name: "Starter Race Blue", tier: "starter", category: "adult", track: "Blue", price: 20.99 },
  { schedule: "weekday", racerType: "new", productId: "24960106", pageId: "24961568", name: "Junior Starter Race Blue", tier: "starter", category: "junior", track: "Blue", price: 15.99 },
  // ── Weekday — Page 25850629: Intermediate ──
  { schedule: "weekday", racerType: "new", productId: "24960650", pageId: "25850629", name: "Intermediate Race Red", tier: "intermediate", category: "adult", track: "Red", price: 20.99 },
  { schedule: "weekday", racerType: "new", productId: "24958077", pageId: "25850629", name: "Intermediate Race Blue", tier: "intermediate", category: "adult", track: "Blue", price: 20.99 },
  { schedule: "weekday", racerType: "new", productId: "24958587", pageId: "25850629", name: "Junior Intermediate Race Blue", tier: "intermediate", category: "junior", track: "Blue", price: 20.99 },
  // ── Weekday — Page 25850669: Pro ──
  { schedule: "weekday", racerType: "new", productId: "24963023", pageId: "25850669", name: "Pro Race Red", tier: "pro", category: "adult", track: "Red", price: 20.99 },
  { schedule: "weekday", racerType: "new", productId: "24963136", pageId: "25850669", name: "Pro Race Blue", tier: "pro", category: "adult", track: "Blue", price: 20.99 },
  { schedule: "weekday", racerType: "new", productId: "24963258", pageId: "25850669", name: "Junior Pro Blue", tier: "pro", category: "junior", track: "Blue", price: 20.99 },

  // ── Weekend (Fri, Sat, Sun) — Page 24871574: Starter ──
  { schedule: "weekend", racerType: "new", productId: "24953280", pageId: "24871574", name: "Starter Race Red", tier: "starter", category: "adult", track: "Red", price: 26.99 },
  { schedule: "weekend", racerType: "new", productId: "24952964", pageId: "24871574", name: "Starter Race Blue", tier: "starter", category: "adult", track: "Blue", price: 26.99 },
  { schedule: "weekend", racerType: "new", productId: "24953399", pageId: "24871574", name: "Junior Starter Race Blue", tier: "starter", category: "junior", track: "Blue", price: 19.99 },
  // ── Weekend — Page 25850598: Intermediate ──
  { schedule: "weekend", racerType: "new", productId: "24964317", pageId: "25850598", name: "Intermediate Race Red", tier: "intermediate", category: "adult", track: "Red", price: 26.99 },
  { schedule: "weekend", racerType: "new", productId: "24952410", pageId: "25850598", name: "Intermediate Race Blue", tier: "intermediate", category: "adult", track: "Blue", price: 26.99 },
  { schedule: "weekend", racerType: "new", productId: "24954302", pageId: "25850598", name: "Junior Intermediate Race Blue", tier: "intermediate", category: "junior", track: "Blue", price: 20.99 },

  // ── Mega (Tuesday) — Page 24966930: Starter ──
  { schedule: "mega", racerType: "new", productId: "24965505", pageId: "24966930", name: "Starter Race Mega", tier: "starter", category: "adult", track: "Mega", price: 20.99 },
  // ── Mega — Page 25850647: Intermediate ──
  { schedule: "mega", racerType: "new", productId: "24965707", pageId: "25850647", name: "Intermediate Race Mega", tier: "intermediate", category: "adult", track: "Mega", price: 20.99 },
  { schedule: "mega", racerType: "new", productId: "24966320", pageId: "25850647", name: "Junior Intermediate Race Mega", tier: "intermediate", category: "junior", track: "Mega", price: 20.99 },
  // ── Mega — Page 25850658: Pro ──
  { schedule: "mega", racerType: "new", productId: "24965768", pageId: "25850658", name: "Pro Race Mega", tier: "pro", category: "adult", track: "Mega", price: 20.99 },
  { schedule: "mega", racerType: "new", productId: "24966863", pageId: "25850658", name: "Junior Pro Race Mega", tier: "pro", category: "junior", track: "Mega", price: 20.99 },

  // ════════════════════════════════════════════════════════════════════════
  // RETURNING RACERS — Page 43734751
  // ════════════════════════════════════════════════════════════════════════

  // ── Weekday (Mon, Wed, Thu) ──
  { schedule: "weekday", racerType: "existing", productId: "43734325", pageId: "43734751", name: "Starter Race Blue", tier: "starter", category: "adult", track: "Blue", price: 20.99 },
  { schedule: "weekday", racerType: "existing", productId: "43734615", pageId: "43734751", name: "Starter Race Red", tier: "starter", category: "adult", track: "Red", price: 20.99 },
  { schedule: "weekday", racerType: "existing", productId: "43726976", pageId: "43734751", name: "Intermediate Race Blue", tier: "intermediate", category: "adult", track: "Blue", price: 20.99 },
  { schedule: "weekday", racerType: "existing", productId: "43727363", pageId: "43734751", name: "Intermediate Race Red", tier: "intermediate", category: "adult", track: "Red", price: 20.99 },
  { schedule: "weekday", racerType: "existing", productId: "43733371", pageId: "43734751", name: "Pro Race Blue", tier: "pro", category: "adult", track: "Blue", price: 20.99 },
  { schedule: "weekday", racerType: "existing", productId: "43733839", pageId: "43734751", name: "Pro Race Red", tier: "pro", category: "adult", track: "Red", price: 20.99 },
  { schedule: "weekday", racerType: "existing", productId: "43733263", pageId: "43734751", name: "Junior Starter Race Blue", tier: "starter", category: "junior", track: "Blue", price: 15.99 },
  { schedule: "weekday", racerType: "existing", productId: "43732159", pageId: "43734751", name: "Junior Intermediate Race Blue", tier: "intermediate", category: "junior", track: "Blue", price: 15.99 },
  { schedule: "weekday", racerType: "existing", productId: "43732593", pageId: "43734751", name: "Junior Pro Blue", tier: "pro", category: "junior", track: "Blue", price: 15.99 },

  // ── Weekend (Fri, Sat, Sun) — No Pro on weekends ──
  { schedule: "weekend", racerType: "existing", productId: "43734229", pageId: "43734751", name: "Starter Race Blue", tier: "starter", category: "adult", track: "Blue", price: 26.99 },
  { schedule: "weekend", racerType: "existing", productId: "43734485", pageId: "43734751", name: "Starter Race Red", tier: "starter", category: "adult", track: "Red", price: 26.99 },
  { schedule: "weekend", racerType: "existing", productId: "43726940", pageId: "43734751", name: "Intermediate Race Blue", tier: "intermediate", category: "adult", track: "Blue", price: 26.99 },
  { schedule: "weekend", racerType: "existing", productId: "43727216", pageId: "43734751", name: "Intermediate Race Red", tier: "intermediate", category: "adult", track: "Red", price: 26.99 },
  { schedule: "weekend", racerType: "existing", productId: "43733133", pageId: "43734751", name: "Junior Starter Race Blue", tier: "starter", category: "junior", track: "Blue", price: 19.99 },
  { schedule: "weekend", racerType: "existing", productId: "43729633", pageId: "43734751", name: "Junior Intermediate Race Blue", tier: "intermediate", category: "junior", track: "Blue", price: 20.99 },

  // ── Mega (Tuesday) ──
  { schedule: "mega", racerType: "existing", productId: "43734407", pageId: "43734751", name: "Starter Race Mega", tier: "starter", category: "adult", track: "Mega", price: 20.99 },
  { schedule: "mega", racerType: "existing", productId: "43727015", pageId: "43734751", name: "Intermediate Race Mega", tier: "intermediate", category: "adult", track: "Mega", price: 20.99 },
  { schedule: "mega", racerType: "existing", productId: "43733733", pageId: "43734751", name: "Pro Race Mega", tier: "pro", category: "adult", track: "Mega", price: 20.99 },
  { schedule: "mega", racerType: "existing", productId: "43732358", pageId: "43734751", name: "Junior Intermediate Race Mega", tier: "intermediate", category: "junior", track: "Mega", price: 20.99 },
  { schedule: "mega", racerType: "existing", productId: "43732675", pageId: "43734751", name: "Junior Pro Race Mega", tier: "pro", category: "junior", track: "Mega", price: 20.99 },

  // ════════════════════════════════════════════════════════════════════════
  // PACK WORKAROUND — sell single-race product 3 times (April 2026).
  //
  // BMI broke race-pack credit assignment on page 42960253 sometime
  // between April 6–10, 2026 (see tasks/bmi-race-pack-credits-bug.md).
  // Credits don't post even though sell + payment succeed.
  //
  // Workaround: each entry below is a SINGLE-RACE product in BMI,
  // priced at pack_price / 3. We gate it behind a pack-style picker
  // (force 3 heat selections) and fire booking/book three times against
  // one orderId — 3 separate bill lines at $pack/3 each, summing to the
  // pack total. No credits involved. No BMI combo mechanic.
  //
  // `packType: "combo"` is a misnomer inherited from the earlier code,
  // but the ComboPackPicker plumbing (3× bookRaceHeat chained on one
  // orderId) is exactly what we want here. Renaming would ripple
  // through the existing single-flow combo code, so we leave it.
  //
  // `price` below is the customer-facing pack TOTAL — shown in the
  // picker + cart. BMI-side per-heat price in the response drives the
  // actual bill-line amounts.
  //
  // Delete-all semantics: the pack renders as a single atomic cart
  // block (OrderSummary.tsx isPack branch) with no per-heat remove —
  // abandoning the pack drops all 3 heats together.
  // ════════════════════════════════════════════════════════════════════════
  {
    schedule: "mega", racerType: "existing",
    productId: "45094787", pageId: "44286218",
    name: "Pro Mega 3-Pack",
    tier: "pro", category: "adult", track: "Mega",
    price: 49.98,
    packType: "combo", raceCount: 3,
  },
  {
    schedule: "mega", racerType: "existing",
    productId: "45094734", pageId: "44286218",
    name: "Intermediate Mega 3-Pack",
    tier: "intermediate", category: "adult", track: "Mega",
    price: 49.98,
    packType: "combo", raceCount: 3,
  },

  // Weekday mixed-track 3-packs (Mon/Wed/Thu) — heats can mix Red + Blue.
  // ComboPackPicker fetches dayplanner from each entry in trackProducts
  // and books each selected heat against the product matching its track.
  // `productId`/`pageId` on the parent entry point at the Red product
  // for UI purposes; the actual booking uses trackProducts[heat.track].
  {
    schedule: "weekday", racerType: "existing",
    productId: "45094857", pageId: "25850629",
    name: "Intermediate Weekday 3-Pack",
    tier: "intermediate", category: "adult", track: null,
    price: 49.98,
    packType: "combo", raceCount: 3,
    trackProducts: {
      Red:  { productId: "45094857", pageId: "25850629" },
      Blue: { productId: "45094906", pageId: "25850629" },
    },
  },
  {
    schedule: "weekday", racerType: "existing",
    productId: "45094954", pageId: "25850669",
    name: "Pro Weekday 3-Pack",
    tier: "pro", category: "adult", track: null,
    price: 49.98,
    packType: "combo", raceCount: 3,
    trackProducts: {
      Red:  { productId: "45094954", pageId: "25850669" },
      Blue: { productId: "45095003", pageId: "25850669" },
    },
  },

  // Weekend mixed-track Intermediate 3-Pack (Fri/Sat/Sun). No Pro on
  // weekends. Same mixed-track mechanic as the weekday packs.
  {
    schedule: "weekend", racerType: "existing",
    productId: "45095096", pageId: "25850598",
    name: "Intermediate Weekend 3-Pack",
    tier: "intermediate", category: "adult", track: null,
    price: 59.98,
    packType: "combo", raceCount: 3,
    trackProducts: {
      Red:  { productId: "45095096", pageId: "25850598" },
      Blue: { productId: "45095051", pageId: "25850598" },
    },
  },
];

/** Minimal BmiProduct stub for static products (HeatPicker uses raw.message) */
function stubRaw(p: StaticRaceProduct): BmiProduct {
  return {
    id: Number(p.productId),
    name: p.name,
    info: "",
    hasPicture: true,
    isCombo: false,
    minAge: p.category === "junior" ? 0 : 13,
    maxAge: p.category === "junior" ? 14 : 200,
    isMembersOnly: true,
    minAmount: -1,
    maxAmount: p.category === "junior" ? 7 : 10,
    resourceKind: "Race",
    kind: 2,
    bookingMode: 0,
    productGroup: "Karting",
    prices: [{ amount: p.price, kind: 0, shortName: "m", depositKind: 0 }],
    resources: [],
    dynamicGroups: null,
    xRef: null,
  };
}

/** Look up a race product by its BMI productId. Returns the registered
 *  display name + track when known. Used at confirmation/email render
 *  time as a fallback for BMI's own line.name when BMI's public catalog
 *  ships a stale or wrong public-facing name (the package-only SKU
 *  45811415 case — BMI's bill/overview returned "Intermediate Race
 *  Mega" for a Blue Track product). Returns null for unknown ids so
 *  the caller can fall through to BMI's own name. */
export function getRaceProductById(
  productId: string | number | null | undefined,
): { name: string; track: string | null; tier: RaceTier; category: RaceCategory } | null {
  if (productId == null) return null;
  const pid = String(productId);
  const hit = RACE_PRODUCTS.find((p) => p.productId === pid);
  if (!hit) return null;
  return { name: hit.name, track: hit.track, tier: hit.tier, category: hit.category };
}

/** Get race products for a given date and racer type */
export function getStaticProducts(date: string, racerType: RacerType = "new"): ClassifiedProduct[] {
  const [y, m, d] = date.split("T")[0].split("-").map(Number);
  const dow = new Date(y, m - 1, d).getDay(); // 0=Sun, 6=Sat
  let schedule: Schedule;
  if (dow === 2) schedule = "mega";           // Tuesday
  else if (dow === 0 || dow === 5 || dow === 6) schedule = "weekend"; // Fri-Sun
  else schedule = "weekday";                  // Mon, Wed, Thu

  return RACE_PRODUCTS
    .filter(p => p.schedule === schedule && p.racerType === racerType)
    .map(p => ({
      productId: p.productId,
      pageId: p.pageId,
      name: p.name,
      tier: p.tier,
      category: p.category,
      track: p.track,
      price: p.price,
      isCombo: p.packType === "combo",
      packType: (p.packType ?? "none") as PackType,
      raceCount: p.raceCount ?? 1,
      sessionGroup: "Unknown",
      raw: stubRaw(p),
      trackProducts: p.trackProducts,
    }));
}

// ── Classified product ──────────────────────────────────────────────────────

export type PackType = "none" | "sell" | "combo";

export interface ClassifiedProduct {
  productId: string;
  pageId: string;
  name: string;
  tier: RaceTier;
  category: RaceCategory;
  track: string | null;
  price: number;
  isCombo: boolean;
  packType: PackType;
  raceCount: number;
  sessionGroup: string;
  raw: BmiProduct;
  /**
   * Mixed-track pack: map each track label (e.g. "Red", "Blue") to the
   * BMI product that books heats on that track. Set on weekday 3-pack
   * entries that span Red + Blue. ComboPackPicker uses this to fetch
   * dayplanner from every entry and book each heat against the
   * track-matched product. Absent on single-track packs.
   */
  trackProducts?: Record<string, { productId: string; pageId: string }>;
}

/**
 * Classify raw BMI API products into our tier/category/track model.
 * Only returns Karting products.
 */
export function classifyProducts(pages: BmiPage[]): ClassifiedProduct[] {
  const results: ClassifiedProduct[] = [];

  for (const page of pages) {
    for (const prod of page.products) {
      if (prod.productGroup !== "Karting") continue;

      const name = prod.name;
      const nameLower = name.toLowerCase();

      let tier: RaceTier = "starter";
      if (nameLower.includes("intermediate")) tier = "intermediate";
      else if (nameLower.includes("pro")) tier = "pro";

      const category: RaceCategory = nameLower.includes("junior") ? "junior" : "adult";

      let track: string | null = null;
      if (nameLower.includes("red")) track = "Red";
      else if (nameLower.includes("blue")) track = "Blue";
      else if (nameLower.includes("mega")) track = "Mega";

      const apiPrice = prod.prices?.find(p => p.depositKind === 0)?.amount ?? 0;

      let packType: PackType = "none";
      if (prod.isCombo) {
        packType = "combo";
      } else if (nameLower.includes("pack") && prod.kind === 1 && !prod.resourceKind) {
        packType = "sell";
      }

      const raceCountMatch = name.match(/(\d+)[- ]?race/i);
      const raceCount = packType !== "none" ? (raceCountMatch ? parseInt(raceCountMatch[1], 10) : 3) : 1;

      const price = lookupPrice(apiPrice);

      results.push({
        productId: String(prod.id),
        pageId: String(page.id),
        name,
        tier,
        category,
        track,
        price,
        isCombo: prod.isCombo,
        packType,
        raceCount,
        sessionGroup: prod.sessionGroup ?? "Unknown",
        raw: prod,
      });
    }
  }

  return results;
}

export function filterProducts(
  products: ClassifiedProduct[],
  racerType: RacerType,
  adultCount: number,
  juniorCount: number,
  memberships?: string[],
): ClassifiedProduct[] {
  // Determine highest qualification from memberships
  const mems = (memberships || []).map(m => m.toLowerCase());
  const hasQualifiedPro = mems.some(m => m.includes("pro"));
  const hasQualifiedIntermediate = mems.some(m => m.includes("intermediate"));

  return products.filter(p => {
    // Hide race-pack credit products (BMI credit pipeline is broken).
    // Keep combo products (they use booking/book, not credits).
    if (p.packType === "sell") return false;
    if (p.category === "adult" && adultCount === 0) return false;
    if (p.category === "junior" && juniorCount === 0) return false;

    if (racerType === "new") {
      // New racers: starter only
      return p.tier === "starter";
    }

    // Returning racers: filter by qualification
    if (hasQualifiedPro) {
      // Pro: show all tiers
      return true;
    }
    if (hasQualifiedIntermediate) {
      // Intermediate: starter + intermediate
      return p.tier === "starter" || p.tier === "intermediate";
    }
    // No qualifications: starter only
    return p.tier === "starter";
  });
}

export function groupByTrack(products: ClassifiedProduct[]): Map<string, ClassifiedProduct[]> {
  const groups = new Map<string, ClassifiedProduct[]>();
  for (const p of products) {
    const key = p.name.replace(/\s+(Red|Blue)$/i, "").trim() + `|${p.category}|${p.packType}`;
    const arr = groups.get(key) ?? [];
    arr.push(p);
    groups.set(key, arr);
  }
  return groups;
}

// ── Visual theming ──────────────────────────────────────────────────────────

export const TIER_COLOR: Record<RaceTier, { border: string; bg: string; badge: string; text: string }> = {
  starter: {
    border: "border-[#00E2E5]",
    bg: "bg-[#00E2E5]/10",
    badge: "bg-[#00E2E5]/20 text-[#00E2E5]",
    text: "text-[#00E2E5]",
  },
  intermediate: {
    border: "border-[#8652FF]",
    bg: "bg-[#8652FF]/10",
    badge: "bg-[#8652FF]/20 text-[#8652FF]",
    text: "text-[#8652FF]",
  },
  pro: {
    border: "border-[#E53935]",
    bg: "bg-[#E53935]/10",
    badge: "bg-[#E53935]/20 text-[#E53935]",
    text: "text-[#E53935]",
  },
};

export const TIER_LABELS: Record<RaceTier, string> = {
  starter: "Starter",
  intermediate: "Intermediate",
  pro: "Pro",
};

/** Centralized tier descriptions — used on booking page, racing page, and emails */
export const TIER_DESCRIPTIONS: Record<RaceTier, string> = {
  starter:
    "Everyone must start at our Starter speed — a fun, exciting race meant for everyone on either track. Being your first visit, you'll also purchase a FastTrax license which includes use of helmets, FastTrax app tracking, head sock, waived booking fees, and more.",
  intermediate: "Higher speed unlock — not for the faint of heart. A real competitive karting experience. Qualified from Starter. Ages 13+.",
  pro: "Our fastest unlocked speed. Maximum performance for racers who've proven their skill.",
};

/** Qualifying lap times per tier per track */
export const TIER_QUALIFYING: Record<RaceTier, string> = {
  starter: "41s (Blue Track) or 46s (Red Track) to unlock Intermediate",
  intermediate: "32.5s (Blue Track) or 37s (Red Track) to unlock Pro",
  pro: "",
};

// ── Acknowledgements ────────────────────────────────────────────────────────

export function getAcknowledgements(category: RaceCategory): string[] {
  if (category === "adult") {
    return ["24878407", "24878469"];
  }
  return ["24878469"];
}

// ── BMI API helper ──────────────────────────────────────────────────────────

export async function bmiGet(endpoint: string, params?: Record<string, string>) {
  const qs = new URLSearchParams({ endpoint, ...params });
  const res = await fetch(`/api/bmi?${qs.toString()}`);
  if (!res.ok) throw new Error(`BMI GET ${endpoint} failed: ${res.status}`);
  return res.json();
}

export async function bmiPost(endpoint: string, body: unknown, params?: Record<string, string>) {
  const qs = new URLSearchParams({ endpoint, ...params });
  const res = await fetch(`/api/bmi?${qs.toString()}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`BMI POST ${endpoint} failed: ${res.status}`);
  return res.json();
}

/** Extract orderId from raw BMI JSON (avoids JS Number precision loss on large IDs) */
export function extractRawOrderId(responseText: string): string | null {
  const m = responseText.match(/"orderId"\s*:\s*(\d+)/);
  return m ? m[1] : null;
}

/**
 * Book a race heat via BMI Public API, preserving orderId precision.
 * Returns { rawOrderId, result } where rawOrderId is extracted from raw text.
 */
export async function bookRaceHeat(
  product: ClassifiedProduct,
  quantity: number,
  proposal: BmiProposal,
  existingOrderId?: string | null,
  personId?: string | null,
): Promise<{ rawOrderId: string; billLineId: string | null; result: Record<string, unknown> }> {
  const payload: Record<string, unknown> = {
    productId: String(product.productId),
    quantity,
    resourceId: Number(proposal.blocks[0]?.block.resourceId) || -1,
    proposal: {
      blocks: proposal.blocks.map((pb) => ({
        productLineIds: pb.productLineIds || [],
        block: {
          ...pb.block,
          resourceId: Number(pb.block.resourceId) || -1,
        },
      })),
      productLineId: proposal.productLineId ?? null,
    },
  };

  // Inject orderId AND personId as raw numbers to avoid JS precision loss on large IDs
  let bodyJson = JSON.stringify(payload);
  // Prepend orderId if adding to existing bill
  if (existingOrderId) {
    bodyJson = `{"orderId":${existingOrderId},` + bodyJson.slice(1);
  }
  // Inject personId as raw number (avoids Number() precision loss on large BMI IDs)
  if (personId) {
    bodyJson = bodyJson.slice(0, -1) + `,"personId":${personId}}`;
  }

  const qs = new URLSearchParams({ endpoint: "booking/book" });
  const res = await fetch(`/api/bmi?${qs.toString()}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: bodyJson,
  });
  const rawText = await res.text();
  let result: Record<string, unknown>;
  try {
    result = JSON.parse(rawText);
  } catch {
    console.error("[bookRaceHeat] non-JSON response:", res.status, rawText.substring(0, 200));
    throw new Error(`Booking API returned ${res.status}: ${rawText.substring(0, 100)}`);
  }
  const rawOrderId = extractRawOrderId(rawText);

  if (result.success === false) {
    console.error("[bookRaceHeat] API error:", result.errorMessage, "body sent:", bodyJson.substring(0, 200));
    throw new Error(result.errorMessage as string || "Booking failed");
  }
  if (!rawOrderId) {
    console.error("[bookRaceHeat] no orderId in response:", rawText.substring(0, 200));
    throw new Error("No order ID returned from booking");
  }

  // Extract orderItemId (bill line ID) from raw text too
  const lineMatch = rawText.match(/"orderItemId"\s*:\s*(\d+)/);
  const billLineId = lineMatch ? lineMatch[1] : null;

  console.log("[bookRaceHeat] orderId (raw):", rawOrderId, "billLineId:", billLineId);
  return { rawOrderId, billLineId, result };
}

/** Remove a single line item from a BMI bill without cancelling the whole order */
export async function removeBookingLine(orderId: string, billLineId: string) {
  const qs = new URLSearchParams({ endpoint: "booking/removeItem" });
  // Use raw text to avoid precision loss on large IDs
  const res = await fetch(`/api/bmi?${qs.toString()}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: `{"orderId":${orderId},"orderItemId":${billLineId}}`,
  });
  const data = await res.json();
  console.log("[removeBookingLine]", orderId, billLineId, data);
  return data;
}

export async function bmiDelete(endpoint: string) {
  const qs = new URLSearchParams({ endpoint });
  const res = await fetch(`/api/bmi?${qs.toString()}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`BMI DELETE ${endpoint} failed: ${res.status}`);
  return res.json();
}
