// ── Core types ───────────────────────────────────────────────────────────────

export type RaceTier = "starter" | "intermediate" | "pro";
export type RaceCategory = "adult" | "junior";
export type RacerType = "new" | "existing";

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
// BMI Public API does not return prices. These are the known prices from the
// SMS-Timing API, keyed by tier + category + packType.

const PRICE_TABLE: Record<string, number> = {
  // Single races
  "starter|adult|none": 25.98,
  "starter|junior|none": 25.98,
  "intermediate|adult|none": 25.98,
  "intermediate|junior|none": 25.98,
  "pro|adult|none": 25.98,
  "pro|junior|none": 25.98,
  // Combo packs (Mega — 3 races)
  "intermediate|adult|combo": 49.98,
  "pro|adult|combo": 49.98,
  // Sell packs (weekday — 3 races)
  "intermediate|adult|sell": 49.99,
  "pro|adult|sell": 49.99,
};

function lookupPrice(tier: RaceTier, category: RaceCategory, packType: PackType, apiPrice: number): number {
  if (apiPrice > 0) return apiPrice; // Use API price if available
  return PRICE_TABLE[`${tier}|${category}|${packType}`] ?? 25.98;
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

      const price = lookupPrice(tier, category, packType, apiPrice);

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
): ClassifiedProduct[] {
  return products.filter(p => {
    // Hide race packs for now
    if (p.packType !== "none") return false;
    if (racerType === "new" && p.tier !== "starter") return false;
    if (racerType === "existing" && p.tier === "starter") return false;
    if (p.category === "adult" && adultCount === 0) return false;
    if (p.category === "junior" && juniorCount === 0) return false;
    return true;
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

export async function bmiDelete(endpoint: string) {
  const qs = new URLSearchParams({ endpoint });
  const res = await fetch(`/api/bmi?${qs.toString()}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`BMI DELETE ${endpoint} failed: ${res.status}`);
  return res.json();
}
