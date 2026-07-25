/**
 * Shared shoe-rental derivation — single source of truth for turning per-bowler
 * shoe-size choices into the paid Square line item.
 *
 * Background (2026-07-25): historically the CHARGE quantity came from a separate
 * group-level "how many pairs" step (BowlingShoesStep → shoeSelections →
 * lineItems), while each bowler's `players[].shoeSize` fed only the QAMF roster
 * and the $0 KDS ticket. The two were never reconciled, so a party could be
 * charged 4 pairs while only 2 bowlers actually wanted rentals (the rest picked
 * "own shoes"). The kiosk bowling flow now DERIVES the paid quantity from the
 * sizes chosen: one selection, one source of truth, no overcharge.
 *
 * Shoe-included packages (Fun-4-All / Pizza Bowl / VIP) charge $0 for shoes —
 * sizes are still collected for the roster/KDS, but no paid line is created.
 */
import type { BowlingSquareProduct } from "@/lib/bowling-db";

/** QAMF centerId → API centerCode for the shoe-product lookup. Mirrors the map
 *  in BowlingShoesStep so the two flows resolve the same catalog. */
export const QAMF_SHOE_CENTER_CODES: Record<number, string> = {
  9172: "TXBSQN0FEKQ11",
  3148: "PPTR5G2N0QXF7",
  11542: "FASTTRAX", // duckpin has no shoe rental — never actually fetched
};

/** Experience slugs whose price already includes shoes → no separate charge. */
export const SHOES_INCLUDED_SLUGS = ["fun-4-all", "fun-4-all-vip", "pizza-bowl", "pizza-bowl-vip"];

export function experienceIncludesShoes(slug: string | null | undefined): boolean {
  return SHOES_INCLUDED_SLUGS.includes(slug ?? "");
}

type ShoeRosterPlayer = { shoeSize: string | null };

/**
 * Paid pairs = bowlers who picked a real rental size. `null` = unanswered and
 * `""` = "own shoes" both count as zero, matching the reserve normalization
 * ("" → null) so we only charge for an explicit rental size like "Male 9".
 */
export function shoeRentalCount(players: ShoeRosterPlayer[] | undefined | null): number {
  return (players ?? []).filter((p) => p.shoeSize != null && p.shoeSize !== "").length;
}

type ShoeLineItem = {
  squareProductId: number;
  quantity: number;
  label?: string;
  priceCents?: number;
  depositPct?: number;
  squareCatalogObjectId?: string;
};
type ShoeProductMeta = {
  id: number;
  label: string;
  priceCents: number;
  depositPct: number;
  squareCatalogObjectId: string;
};

/**
 * Rebuild the shoe half of a bowling item's checkout from the roster: strips any
 * existing shoe lines from `existingLineItems` and appends a single derived line
 * (product[0] × rental count) unless the package includes shoes or nobody rents.
 * Returns the exact `{ shoeSelections, shoeProducts, lineItems }` patch the
 * reserve path reads — so the charge can never drift from the sizes shown.
 */
export function deriveShoePatch(
  players: ShoeRosterPlayer[],
  experienceSlug: string | null | undefined,
  existingLineItems: ShoeLineItem[],
  products: BowlingSquareProduct[],
): {
  shoeSelections: Record<number, number>;
  shoeProducts?: ShoeProductMeta[];
  lineItems: ShoeLineItem[];
} {
  const nonShoe = existingLineItems.filter(
    (li) => !products.some((p) => p.id === li.squareProductId),
  );
  const product = products[0];
  const qty = experienceIncludesShoes(experienceSlug) ? 0 : shoeRentalCount(players);

  if (!product || qty <= 0) {
    return { shoeSelections: {}, shoeProducts: undefined, lineItems: nonShoe };
  }

  const line: ShoeLineItem = {
    squareProductId: product.id,
    quantity: qty,
    label: product.label,
    priceCents: product.priceCents,
    depositPct: product.depositPct,
    squareCatalogObjectId: product.squareCatalogObjectId,
  };
  return {
    shoeSelections: { [product.id]: qty },
    shoeProducts: [
      {
        id: product.id,
        label: product.label,
        priceCents: product.priceCents,
        depositPct: product.depositPct,
        squareCatalogObjectId: product.squareCatalogObjectId,
      },
    ],
    lineItems: [...nonShoe, line],
  };
}
