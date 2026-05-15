import { NextRequest, NextResponse } from "next/server";
import { getBowlingSquareProducts, type BowlingProductKind } from "@/lib/bowling-db";

/**
 * GET /api/bowling/v2/square-products
 *
 * Returns active bowling products for a center, optionally filtered by kind.
 * The wizard calls this once per add-on step; an empty array signals the
 * step should be skipped.
 *
 * Query params:
 *   centerId   — QAMF center ID (9172 = FM, 3148 = Naples)
 *   centerCode — Square/BMI center code ('TXBSQN0FEKQ11' | 'PPTR5G2N0QXF7')
 *                Either centerId OR centerCode must be supplied.
 *   kind       — optional product_kind filter (addon_shoe, addon_attraction, etc.)
 */

const CENTER_ID_TO_CODE: Record<string, string> = {
  "9172": "TXBSQN0FEKQ11",
  "3148": "PPTR5G2N0QXF7",
};

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const centerId = searchParams.get("centerId");
  const centerCodeParam = searchParams.get("centerCode");
  const kind = searchParams.get("kind") as BowlingProductKind | null;

  const centerCode = centerCodeParam ?? (centerId ? CENTER_ID_TO_CODE[centerId] : null);
  if (!centerCode) {
    return NextResponse.json({ error: "centerId or centerCode required" }, { status: 400 });
  }

  try {
    const products = await getBowlingSquareProducts(centerCode, kind ?? undefined);
    return NextResponse.json(products);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
