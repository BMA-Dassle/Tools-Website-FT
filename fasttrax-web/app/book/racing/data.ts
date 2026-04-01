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

export interface ClassifiedProduct {
  productId: string;
  pageId: string;
  name: string;
  tier: RaceTier;
  category: RaceCategory;
  track: string | null; // "Red", "Blue", or null (Mega/unknown)
  price: number;       // cash price (depositKind 0)
  isCombo: boolean;    // multi-pack
  sessionGroup: string;
  raw: SmsProduct;
}

/**
 * Classify raw API products into our tier/category/track model.
 * Only returns Karting products.
 */
export function classifyProducts(pages: SmsPage[]): ClassifiedProduct[] {
  const results: ClassifiedProduct[] = [];

  for (const page of pages) {
    for (const prod of page.products) {
      if (prod.productGroup !== "Karting") continue;

      const name = prod.name;
      const nameLower = name.toLowerCase();

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

      // Cash price
      const price = prod.prices.find(p => p.depositKind === 0)?.amount ?? 0;

      results.push({
        productId: prod.id,
        pageId: page.id,
        name,
        tier,
        category,
        track,
        price,
        isCombo: prod.isCombo,
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
    const key = p.name.replace(/\s+(Red|Blue)$/i, "").trim() + `|${p.category}|${p.isCombo}`;
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
