export type RaceTier = "starter" | "intermediate" | "pro";
export type RaceCategory = "adult" | "junior";

export interface RaceProduct {
  productId: string;
  pageId: string;
  name: string;
  displayName: string;
  category: RaceCategory;
  tier: RaceTier;
  price: number;
  pack?: number; // number of races if a multi-pack
  age: string;
  height: string;
  qualification: string | null;
  qualifiesFrom?: string; // display name of the tier required
  description: string;
  color: string; // tailwind border/accent color token
}

export const RACE_PRODUCTS: RaceProduct[] = [
  // ── STARTER ────────────────────────────────────────────────────────────────
  {
    productId: "24965505",
    pageId: "24966930",
    name: "Starter Race Mega",
    displayName: "Starter Race",
    category: "adult",
    tier: "starter",
    price: 25.98,
    age: "13+",
    height: '59"+ (4\'11"+)',
    qualification: null,
    description: "Your first race. No experience needed — jump in and find your pace on the Mega Track.",
    color: "cyan",
  },

  // ── INTERMEDIATE ───────────────────────────────────────────────────────────
  {
    productId: "24965707",
    pageId: "25850647",
    name: "Intermediate Race Mega",
    displayName: "Intermediate Race",
    category: "adult",
    tier: "intermediate",
    price: 25.98,
    age: "16+",
    height: '59"+ (4\'11"+)',
    qualification: 'Must have hit 41.5s (Blue) or 47s (Red) lap time in an Adult Starter Race.',
    qualifiesFrom: "Starter Race",
    description: "You've found your line. Now push the limits with faster drivers.",
    color: "violet",
  },
  {
    productId: "33415132",
    pageId: "25850647",
    name: "Intermediate Race Mega - 3 Race Pack",
    displayName: "Intermediate 3-Race Pack",
    category: "adult",
    tier: "intermediate",
    price: 49.98,
    pack: 3,
    age: "16+",
    height: '59"+ (4\'11"+)',
    qualification: 'Must have hit 41.5s (Blue) or 47s (Red) lap time in an Adult Starter Race.',
    qualifiesFrom: "Starter Race",
    description: "Best value for qualified intermediate drivers — 3 races, one price.",
    color: "violet",
  },
  {
    productId: "24966320",
    pageId: "25850647",
    name: "Junior Intermediate Race Mega",
    displayName: "Junior Intermediate Race",
    category: "junior",
    tier: "intermediate",
    price: 20.98,
    age: "7–13",
    height: '49"–70"',
    qualification: 'Must have hit a 1:15 lap time in a Junior Starter Race.',
    qualifiesFrom: "Junior Starter Race",
    description: "Junior racers who've proven their pace move up to the competitive grid.",
    color: "violet",
  },

  // ── PRO ────────────────────────────────────────────────────────────────────
  {
    productId: "24965768",
    pageId: "25850658",
    name: "Pro Race Mega",
    displayName: "Pro Race",
    category: "adult",
    tier: "pro",
    price: 25.98,
    age: "16+",
    height: '59"+ (4\'11"+)',
    qualification: 'Must have hit 32.25s (Blue) or 37.25s (Red) lap time in an Adult Intermediate Race.',
    qualifiesFrom: "Intermediate Race",
    description: "The fastest drivers on the track. Every tenth counts at the pro level.",
    color: "red",
  },
  {
    productId: "33416216",
    pageId: "25850658",
    name: "Pro Race Mega - 3 Race Pack",
    displayName: "Pro 3-Race Pack",
    category: "adult",
    tier: "pro",
    price: 49.98,
    pack: 3,
    age: "16+",
    height: '59"+ (4\'11"+)',
    qualification: 'Must have hit 32.25s (Blue) or 37.25s (Red) lap time in an Adult Intermediate Race.',
    qualifiesFrom: "Intermediate Race",
    description: "Lock in 3 pro races at a discount. Serious racers only.",
    color: "red",
  },
  {
    productId: "24966863",
    pageId: "25850658",
    name: "Junior Pro Race Mega",
    displayName: "Junior Pro Race",
    category: "junior",
    tier: "pro",
    price: 20.98,
    age: "7–13",
    height: '49"–70"',
    qualification: 'Must have hit a 45s lap time in a Junior Intermediate Race.',
    qualifiesFrom: "Junior Intermediate Race",
    description: "Elite junior racing. If you're here, you've earned it.",
    color: "red",
  },
];

export const COLOR_MAP: Record<string, { border: string; bg: string; badge: string; text: string }> = {
  cyan: {
    border: "border-[#00E2E5]",
    bg: "bg-[#00E2E5]/10",
    badge: "bg-[#00E2E5]/20 text-[#00E2E5]",
    text: "text-[#00E2E5]",
  },
  violet: {
    border: "border-[#8652FF]",
    bg: "bg-[#8652FF]/10",
    badge: "bg-[#8652FF]/20 text-[#8652FF]",
    text: "text-[#8652FF]",
  },
  red: {
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

export const BMI_BOOKING_BASE = "https://booking.bmileisure.com/headpinzftmyers/book/product-list";

// ── SMS-Timing API types ──────────────────────────────────────────────────────

export interface SmsPrice {
  amount: number;
  kind: number;
  shortName: string;
  depositKind: number; // 0 = cash, 2 = deposit/membership
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

// Acknowledgement product IDs required before payment.
// Adult races need BOTH: age 13+ (24878407) AND height 59"+ (24878469)
// Junior races need only the height acknowledgement (24878469)
export const ACKNOWLEDGEMENT_PRODUCTS: Record<string, string[]> = {
  "24965505": ["24878407", "24878469"], // Starter Race Mega (adult)
  "24965707": ["24878407", "24878469"], // Intermediate Race Mega (adult)
  "33415132": ["24878407", "24878469"], // Intermediate 3-Pack (adult)
  "24965768": ["24878407", "24878469"], // Pro Race Mega (adult)
  "33416216": ["24878407", "24878469"], // Pro 3-Pack (adult)
  "24966320": ["24878469"], // Junior Intermediate
  "24966863": ["24878469"], // Junior Pro
};
