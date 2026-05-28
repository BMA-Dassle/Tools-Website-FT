import { SQUARE_CATALOG_IDS, SQUARE_LOCATIONS, LOCATION_TAX } from "./square-catalog-map";

// ── Types ──────────────────────────────────────────────────────────────────

export interface RacePackVariant {
  id: string;
  productId: string;
  name: string;
  raceCount: number;
  type: "weekday" | "anytime";
  price: number;
  depositKindId: string;
  squareCatalogId: string;
  squareLineItemName: string;
}

// ── Pandora deposit kind IDs ───────────────────────────────────────────────

const DEPOSIT_KIND_WEEKDAY = "12744867";
const DEPOSIT_KIND_ANYTIME = "12744871";

// ── Pack catalog ───────────────────────────────────────────────────────────

export const RACE_PACK_VARIANTS: RacePackVariant[] = [
  {
    id: "3-race-weekday",
    productId: "13079165",
    name: "3-Race Pack",
    raceCount: 3,
    type: "weekday",
    price: 49.99,
    depositKindId: DEPOSIT_KIND_WEEKDAY,
    squareCatalogId: SQUARE_CATALOG_IDS.RACE_PACK,
    squareLineItemName: "3-Race Pack (Mon-Thu)",
  },
  {
    id: "3-race-anytime",
    productId: "13079678",
    name: "3-Race Pack",
    raceCount: 3,
    type: "anytime",
    price: 59.99,
    depositKindId: DEPOSIT_KIND_ANYTIME,
    squareCatalogId: SQUARE_CATALOG_IDS.RACE_PACK,
    squareLineItemName: "3-Race Pack (Anytime)",
  },
  {
    id: "5-race-weekday",
    productId: "12754550",
    name: "5-Race Pack",
    raceCount: 5,
    type: "weekday",
    price: 79.99,
    depositKindId: DEPOSIT_KIND_WEEKDAY,
    squareCatalogId: SQUARE_CATALOG_IDS.RACE_PACK,
    squareLineItemName: "5-Race Pack (Mon-Thu)",
  },
  {
    id: "5-race-anytime",
    productId: "13079686",
    name: "5-Race Pack",
    raceCount: 5,
    type: "anytime",
    price: 99.99,
    depositKindId: DEPOSIT_KIND_ANYTIME,
    squareCatalogId: SQUARE_CATALOG_IDS.RACE_PACK,
    squareLineItemName: "5-Race Pack (Anytime)",
  },
  {
    id: "10-race-weekday",
    productId: "12754573",
    name: "10-Race Pack",
    raceCount: 10,
    type: "weekday",
    price: 159.99,
    depositKindId: DEPOSIT_KIND_WEEKDAY,
    squareCatalogId: SQUARE_CATALOG_IDS.RACE_PACK,
    squareLineItemName: "10-Race Pack (Mon-Thu)",
  },
  {
    id: "10-race-anytime",
    productId: "13079694",
    name: "10-Race Pack",
    raceCount: 10,
    type: "anytime",
    price: 199.99,
    depositKindId: DEPOSIT_KIND_ANYTIME,
    squareCatalogId: SQUARE_CATALOG_IDS.RACE_PACK,
    squareLineItemName: "10-Race Pack (Anytime)",
  },
];

export const PACK_PAGE_ID = "42960253";

export const FL_TAX_RATE = 0.065;

export function getPackVariant(id: string): RacePackVariant | null {
  return RACE_PACK_VARIANTS.find((v) => v.id === id) ?? null;
}

export function packTax(price: number): number {
  return Math.round(price * FL_TAX_RATE * 100) / 100;
}

export function packTotal(price: number): number {
  return Math.round((price + packTax(price)) * 100) / 100;
}

export const PACK_LOCATION_ID = SQUARE_LOCATIONS.FASTTRAX_FM;
export const PACK_TAX_CATALOG_ID = LOCATION_TAX[SQUARE_LOCATIONS.FASTTRAX_FM];
