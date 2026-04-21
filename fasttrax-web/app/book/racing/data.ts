// ── Core types ───────────────────────────────────────────────────────────────

export type RaceTier = "starter" | "intermediate" | "pro";
export type RaceCategory = "adult" | "junior";
export type RacerType = "new" | "existing";

// ── SMS-Timing API types ─────────────────────────────────────────────────────

export interface SmsPrice {
  amount: number;
  kind: number;
  shortName: string;
  depositKind: number; // 0 = cash, 2 = deposit/membership
}

/** One product inside a page from GET /api/page/{venue}?date= */
export interface SmsProduct {
  id: string;
  name: string;
  info: string;
  shortInfo: string;
  hasPicture: boolean;
  isCombo: boolean;
  minAge: number;
  maxAge: number;
  isMembersOnly: boolean;
  minAmount: number;
  maxAmount: number;
  resourceId: string;
  resourceKind: string;
  kind: number;
  bookingMode: number;
  productGroup: string;
  sessionGroup: string;
  durationSec: number;
  message: string;
  prices: SmsPrice[];
  saleMode: number;
  dynamicGroups: unknown;
}

/** A page (category) from GET /api/page/{venue}?date= */
export interface SmsPage {
  id: string;
  name: string;
  defaultName: string;
  kind: number;
  products: SmsProduct[];
}

export interface SmsSessionSetup {
  durationTime: string;
  durationMode?: number;
  durationLaps: number;
  group?: null;
  durationInterval: string;
  id: string;
}

export interface SmsBlock {
  name: string;
  showSessionTimes?: boolean;
  capacity: number;
  freeSpots: number;
  resourceId: string;
  prices: SmsPrice[];
  bookingMode?: number;
  sessionSetup: SmsSessionSetup;
  resourceGroupMode?: number;
  start: string;
  stop: string;
}

export interface SmsProposalBlock {
  productId: null;
  productLineIds: string[];
  block: SmsBlock;
}

export interface SmsProposal {
  blocks: SmsProposalBlock[];
  productLineId: null;
  selected: boolean;
}

/** Modifier page returned from booking/sell for sell-type packs */
export interface SmsModifierPage {
  pageId: string;
  pageName: string;
  minAmount: number;
  maxAmount: number;
  perPerson: boolean;
  products: SmsProduct[];
  rows: number;
  columns: number;
}

/** Response from booking/sell for sell packs */
export interface SmsSellResponse {
  modifiers: SmsModifierPage[];
  nextProposals: null;
  schedules: { start: string; stop: string; name: string; quantity: number; resourceId: string }[];
  laneSplittingInfo: null;
}

/** Response from booking/book (for combo packs with nextProposals) */
export interface SmsBookResponse {
  nextProposals: {
    current: number;
    total: number;
    proposals: SmsProposal[];
    overbooking: boolean;
    success: boolean;
    errorMessage: string | null;
  } | null;
  schedules: { start: string; stop: string; name: string; quantity: number; resourceId: string }[];
  modifiers: SmsModifierPage[];
  laneSplittingInfo: null;
  /** Bill ID — may be top-level or nested */
  id?: string;
  billId?: string;
}

/** A scheduled race within a pack booking */
export interface PackSchedule {
  start: string;
  stop: string;
  name: string;
  trackName?: string; // e.g. "Blue", "Red"
}

export interface SmsBillLine {
  id: string;
  parentBillLineId: string | null;
  name: string;
  quantity: number;
  productId: string;
  pageId: string;
  productGroup: string;
  resourceKind: string;
  scheduledTime: { start: string; stop: string } | null;
  totalPrice: SmsPrice[];
  canDelete: boolean;
}

export interface SmsBill {
  id: string;
  lines: SmsBillLine[];
  subTotal: SmsPrice[];
  total: SmsPrice[];
  totalTax: SmsPrice[];
  totalDeposit: number;
  allowPayOnSite: boolean;
  success: boolean;
  errorMessage: string | null;
}

// ── Classified product (derived from API response) ───────────────────────────

export type PackType = "none" | "sell" | "combo";

export interface ClassifiedProduct {
  productId: string;
  pageId: string;
  name: string;
  tier: RaceTier;
  category: RaceCategory;
  track: string | null; // "Red", "Blue", or null (Mega/unknown)
  price: number;       // cash price (depositKind 0)
  isCombo: boolean;    // multi-pack
  packType: PackType;  // "sell" = weekday pack (booking/sell flow), "combo" = mega pack (sequential booking/book)
  raceCount: number;   // 1 for single races, 3 for packs
  sessionGroup: string;
  raw: SmsProduct;
}

/**
 * Classify raw API products into our tier/category/track model.
 * Only returns Karting products.
 */
/**
 * Race-pack credit workaround (April 2026).
 *
 * BMI broke the race-pack credit pipeline on page 42960253. Customers
 * pay but no credits post (see tasks/bmi-race-pack-credits-bug.md).
 *
 * Workaround: each "3-pack" product below is a SINGLE-RACE product in
 * BMI, priced at pack_price / 3 per heat. In the UI we gate it behind
 * a pack-style picker (force 3 heat selections), then call booking/book
 * three times against the same orderId — that's 3 separate bill lines,
 * one per heat, summing to the pack total. No BMI combo mechanic and
 * no credit pipeline involved.
 *
 * "packType: combo" here is a misnomer inherited from the earlier code
 * — the mechanic is actually "single product sold 3 times", not BMI's
 * native combo. The UI plumbing (ComboPackPicker → 3× bookRaceHeat
 * chained on one orderId) is identical either way.
 *
 * Override `packType` + `raceCount: 3` here regardless of BMI's isCombo
 * flag (the BMI products are plain single-race, not combo-flagged).
 * `packPrice` is what the customer sees in the picker / cart total.
 */
const WORKAROUND_PACK_PRODUCTS: Record<string, { name: string; packPrice: number }> = {
  "45094787": { name: "Pro Mega 3-Pack", packPrice: 49.98 },
  "45094734": { name: "Intermediate Mega 3-Pack", packPrice: 49.98 },
};

/**
 * Old combo product that's misconfigured in BMI (fires a single $24.99
 * weekday-race line instead of the $49.98 3-pack total). Hidden from
 * the picker so guests get routed to the working workaround products.
 */
const HIDDEN_PRODUCT_IDS = new Set(["44276020"]);

export function classifyProducts(pages: SmsPage[]): ClassifiedProduct[] {
  const results: ClassifiedProduct[] = [];

  for (const page of pages) {
    for (const prod of page.products) {
      if (prod.productGroup !== "Karting") continue;
      if (HIDDEN_PRODUCT_IDS.has(String(prod.id))) continue;

      const nameLower = prod.name.toLowerCase();
      const workaround = WORKAROUND_PACK_PRODUCTS[String(prod.id)];

      // Workaround products get a friendlier name + known pack price.
      const name = workaround?.name ?? prod.name;

      // Determine tier
      let tier: RaceTier = "starter";
      if (nameLower.includes("intermediate")) tier = "intermediate";
      else if (nameLower.includes("pro")) tier = "pro";

      // Determine category: "Junior" in name = junior, otherwise adult
      const category: RaceCategory = nameLower.includes("junior") ? "junior" : "adult";

      // Determine track
      let track: string | null = null;
      if (nameLower.includes("red")) track = "Red";
      else if (nameLower.includes("blue")) track = "Blue";
      else if (nameLower.includes("mega")) track = "Mega";

      // Cash price — workaround products display the pack total; everything
      // else uses BMI's returned depositKind=0 price.
      const price =
        workaround?.packPrice ??
        (prod.prices.find(p => p.depositKind === 0)?.amount ?? 0);

      // Determine pack type — workaround product IDs force combo even if
      // BMI hasn't flagged them isCombo.
      let packType: PackType = "none";
      if (workaround || prod.isCombo) {
        packType = "combo"; // Mega track combo packs — sequential booking/book flow
      } else if (nameLower.includes("pack") && prod.durationSec === 0 && !prod.resourceKind) {
        packType = "sell"; // Weekday sell packs — booking/sell flow with modifier pages
      }

      // Parse race count from name (e.g. "3-Race Pack", "3 Race Pack"),
      // workaround products default to 3.
      const raceCountMatch = name.match(/(\d+)[- ]?race/i);
      const raceCount =
        workaround ? 3
        : packType !== "none" ? (raceCountMatch ? parseInt(raceCountMatch[1], 10) : 3)
        : 1;

      results.push({
        productId: prod.id,
        pageId: page.id,
        name,
        tier,
        category,
        track,
        price,
        isCombo: !!workaround || prod.isCombo,
        packType,
        raceCount,
        sessionGroup: prod.sessionGroup,
        raw: prod,
      });
    }
  }

  return results;
}

/**
 * Filter products for the wizard based on racer type and party composition.
 * - New racers → only Starter tier
 * - Existing racers → Intermediate + Pro tiers
 * - Only show adult products if adults > 0
 * - Only show junior products if juniors > 0
 */
export function filterProducts(
  products: ClassifiedProduct[],
  racerType: RacerType,
  adultCount: number,
  juniorCount: number,
): ClassifiedProduct[] {
  return products.filter(p => {
    // Filter by experience level
    if (racerType === "new" && p.tier !== "starter") return false;
    if (racerType === "existing" && p.tier === "starter") return false;

    // Filter by party composition
    if (p.category === "adult" && adultCount === 0) return false;
    if (p.category === "junior" && juniorCount === 0) return false;

    return true;
  });
}

/**
 * Group products that exist on multiple tracks (Blue/Red).
 * Returns groups keyed by a normalized name (without track suffix).
 */
export function groupByTrack(products: ClassifiedProduct[]): Map<string, ClassifiedProduct[]> {
  const groups = new Map<string, ClassifiedProduct[]>();
  for (const p of products) {
    // Normalize: remove "Red"/"Blue" from name to group them
    const key = p.name.replace(/\s+(Red|Blue)$/i, "").trim() + `|${p.category}|${p.packType}`;
    const arr = groups.get(key) ?? [];
    arr.push(p);
    groups.set(key, arr);
  }
  return groups;
}

// ── Visual theming ───────────────────────────────────────────────────────────

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

// ── Acknowledgements ─────────────────────────────────────────────────────────

// Determine acknowledgements dynamically from product category
export function getAcknowledgements(category: RaceCategory): string[] {
  if (category === "adult") {
    // Age 13+ AND height 59"+
    return ["24878407", "24878469"];
  }
  // Junior — height only
  return ["24878469"];
}
