/**
 * Shared data layer for all attraction booking flows.
 * Reuses BMI API types from racing but with attraction-specific classification.
 */

// ── Attraction Types ──────────────────────────────────────────────────────────

export type AttractionSlug = "gel-blaster" | "laser-tag" | "duck-pin" | "shuffly" | "racing";
export type BookingMode = "per-person" | "per-slot";
export type LocationKey = "fasttrax" | "headpinz";

export interface AttractionConfig {
  slug: AttractionSlug;
  name: string;
  shortName: string;
  location: LocationKey | "both";
  /** BMI page IDs per location */
  pageIds: Partial<Record<LocationKey, string>>;
  bookingMode: BookingMode;
  maxGroupSize: number;
  showWaiverPrompt: boolean;
  heroImage: string;
  color: string;
  description: string;
  /** Building name for display */
  building: string;
  /** Duration label */
  durationLabel?: string;
}

// ── Attraction Configs ────────────────────────────────────────────────────────

export const ATTRACTIONS: Record<string, AttractionConfig> = {
  "gel-blaster": {
    slug: "gel-blaster",
    name: "Nexus Gel Blaster Arena",
    shortName: "Gel Blasters",
    location: "headpinz",
    pageIds: { headpinz: "24909729" },
    bookingMode: "per-person",
    maxGroupSize: 16,
    showWaiverPrompt: true,
    heroImage: "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/attractions/gelblaster-hpfm.jpg",
    color: "#00E2E5",
    description: "High-tech gel blaster battles in an immersive glowing arena",
    building: "HeadPinz Fort Myers",
    durationLabel: "15 min session",
  },
  "laser-tag": {
    slug: "laser-tag",
    name: "Nexus Tactical Laser Tag",
    shortName: "Laser Tag",
    location: "headpinz",
    pageIds: { headpinz: "24909729" },
    bookingMode: "per-person",
    maxGroupSize: 17,
    showWaiverPrompt: true,
    heroImage: "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/attractions/lasertag-hpfm.jpg",
    color: "#8652FF",
    description: "Multi-level laser tag with haptic vests and immersive lighting",
    building: "HeadPinz Fort Myers",
    durationLabel: "15 min session",
  },
  "duck-pin": {
    slug: "duck-pin",
    name: "FastTrax Duckpin Bowling",
    shortName: "Duckpin",
    location: "fasttrax",
    pageIds: { fasttrax: "24909243" },
    bookingMode: "per-slot",
    maxGroupSize: 6,
    showWaiverPrompt: false,
    heroImage: "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/attractions/duckpin3.jpg",
    color: "#F59E0B",
    description: "Modern duckpin bowling — smaller pins, lighter balls, nonstop fun",
    building: "FastTrax Fort Myers",
    durationLabel: "30 min or 1 hour",
  },
  shuffly: {
    slug: "shuffly",
    name: "Shuffle Showdown",
    shortName: "Shuffly",
    location: "both",
    pageIds: { fasttrax: "24908598", headpinz: "27487108" },
    bookingMode: "per-slot",
    maxGroupSize: 10,
    showWaiverPrompt: false,
    heroImage: "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/attractions/shuffly2.jpg",
    color: "#10B981",
    description: "AR-powered shuffleboard with dynamic LED lighting and automatic scoring",
    building: "FastTrax & HeadPinz",
    durationLabel: "30 min or 1 hour",
  },
  racing: {
    slug: "racing",
    name: "High-Speed Electric Racing",
    shortName: "Racing",
    location: "fasttrax",
    pageIds: { fasttrax: "24871574" },
    bookingMode: "per-person",
    maxGroupSize: 10,
    showWaiverPrompt: true,
    heroImage: "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/tracks/blue-track-iYCkFVDkIiDVwNQaiABoZsqzj2Fjnj.jpg",
    color: "#E41C1D",
    description: "Florida's largest indoor go-kart racing on 3 unique tracks",
    building: "FastTrax Fort Myers",
    durationLabel: "3-race mega pack",
  },
};

/** All bookable attractions in display order */
export const ATTRACTION_LIST: AttractionConfig[] = [
  ATTRACTIONS.racing,
  ATTRACTIONS.shuffly,
  ATTRACTIONS["duck-pin"],
  ATTRACTIONS["gel-blaster"],
  ATTRACTIONS["laser-tag"],
];

// ── BMI Product Types (shared with racing) ────────────────────────────────────

export interface BmiPrice {
  amount: number;
  kind: number;
  shortName: string;
  depositKind: number;
}

export interface BmiProduct {
  id: number;
  name: string;
  info: string;
  hasPicture: boolean;
  isCombo: boolean;
  minAge: number | null;
  maxAge: number | null;
  minAmount: number;
  maxAmount: number;
  kind: number;
  bookingMode: number;
  productGroup: string;
  prices: BmiPrice[];
  resources: { id: number; xRef: string | null; kind: string }[];
  xRef: string | null;
  sessionGroup?: string;
  durationSec?: number;
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

// ── Classified Attraction Product ─────────────────────────────────────────────

export interface AttractionProduct {
  productId: string;
  pageId: string;
  name: string;
  attraction: AttractionSlug;
  location: LocationKey;
  price: number;
  bookingMode: BookingMode;
  maxAmount: number;
  durationMin: number | null;
  isCombo: boolean;
  raw: BmiProduct;
}

/** Known product IDs mapped to attractions */
const PRODUCT_ATTRACTION_MAP: Record<number, { attraction: AttractionSlug; location: LocationKey }> = {
  // Gel Blasters
  8976680: { attraction: "gel-blaster", location: "headpinz" },
  // Laser Tag
  8976685: { attraction: "laser-tag", location: "headpinz" },
  // Duck Pin
  23345635: { attraction: "duck-pin", location: "fasttrax" },
  24711034: { attraction: "duck-pin", location: "fasttrax" },
  // Shuffly FastTrax
  24709515: { attraction: "shuffly", location: "fasttrax" },
  24731238: { attraction: "shuffly", location: "fasttrax" },
  25769498: { attraction: "shuffly", location: "fasttrax" },
  // Shuffly HeadPinz
  24709632: { attraction: "shuffly", location: "headpinz" },
  25609182: { attraction: "shuffly", location: "headpinz" },
  25769534: { attraction: "shuffly", location: "headpinz" },
};

/** Classify products from BMI page response into attraction products */
export function classifyAttractionProducts(pages: BmiPage[], attractionSlug?: AttractionSlug): AttractionProduct[] {
  const products: AttractionProduct[] = [];

  for (const page of pages) {
    for (const p of page.products) {
      const mapping = PRODUCT_ATTRACTION_MAP[p.id];
      if (!mapping) continue;
      if (attractionSlug && mapping.attraction !== attractionSlug) continue;

      const cashPrice = p.prices?.find(pr => pr.depositKind === 0);
      products.push({
        productId: String(p.id),
        pageId: String(page.id),
        name: p.name,
        attraction: mapping.attraction,
        location: mapping.location,
        price: cashPrice?.amount ?? 0,
        bookingMode: p.bookingMode === 1 ? "per-slot" : "per-person",
        maxAmount: p.maxAmount === -1 ? 99 : p.maxAmount,
        durationMin: p.durationSec ? Math.round(p.durationSec / 60) : null,
        isCombo: p.isCombo || p.name.toLowerCase().includes("combo") || p.name.toLowerCase().includes("+"),
        raw: p,
      });
    }
  }

  return products;
}

// ── API Helpers (reuse from racing data layer) ────────────────────────────────

const FL_TAX_RATE = 0.065;
export function calculateTax(subtotal: number) { return Math.round(subtotal * FL_TAX_RATE * 100) / 100; }
export function calculateTotal(subtotal: number) { return Math.round((subtotal + calculateTax(subtotal)) * 100) / 100; }

export async function bmiGet(endpoint: string, params?: Record<string, string>) {
  const qs = new URLSearchParams({ endpoint, ...params });
  const res = await fetch(`/api/bmi?${qs.toString()}`);
  if (!res.ok) throw new Error(`BMI GET ${endpoint} failed: ${res.status}`);
  return res.json();
}

export async function bmiPost(endpoint: string, body: unknown) {
  const qs = new URLSearchParams({ endpoint });
  const res = await fetch(`/api/bmi?${qs.toString()}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`BMI POST ${endpoint} failed: ${res.status}`);
  return res.json();
}

/** Book an attraction product, returns raw orderId to avoid precision loss */
export async function bookAttractionSlot(
  productId: string,
  quantity: number,
  proposal: BmiProposal,
  existingOrderId?: string | null,
  personId?: string | null,
): Promise<{ rawOrderId: string; billLineId: string | null }> {
  const payload: Record<string, unknown> = {
    productId,
    quantity,
    resourceId: Number(proposal.blocks[0]?.block.resourceId) || -1,
    proposal: {
      blocks: proposal.blocks.map(pb => ({
        productLineIds: pb.productLineIds || [],
        block: { ...pb.block, resourceId: Number(pb.block.resourceId) || -1 },
      })),
      productLineId: proposal.productLineId ?? null,
    },
  };

  // Inject orderId and personId as raw numbers for precision
  let bodyJson = JSON.stringify(payload);
  if (existingOrderId) bodyJson = `{"orderId":${existingOrderId},` + bodyJson.slice(1);
  if (personId) bodyJson = bodyJson.slice(0, -1) + `,"personId":${personId}}`;

  const qs = new URLSearchParams({ endpoint: "booking/book" });
  const res = await fetch(`/api/bmi?${qs.toString()}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: bodyJson,
  });
  const rawText = await res.text();
  const orderIdMatch = rawText.match(/"orderId"\s*:\s*(\d+)/);
  const lineIdMatch = rawText.match(/"orderItemId"\s*:\s*(\d+)/);

  if (!orderIdMatch) {
    console.error("[bookAttractionSlot] failed:", rawText.substring(0, 200));
    throw new Error("Booking failed");
  }

  return { rawOrderId: orderIdMatch[1], billLineId: lineIdMatch ? lineIdMatch[1] : null };
}
