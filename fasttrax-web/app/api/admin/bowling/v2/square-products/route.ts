import { NextRequest, NextResponse } from "next/server";
import {
  getBowlingSquareProducts,
  upsertBowlingSquareProduct,
  type BowlingProductKind,
} from "@/lib/bowling-db";

/**
 * Bowling V2 — admin product catalog management.
 *
 * Auth: ADMIN_CAMERA_TOKEN via middleware (x-admin-token header or ?token= query).
 *
 * GET  /api/admin/bowling/v2/square-products
 *   ?centerCode=TXBSQN0FEKQ11  (required)
 *   &kind=addon_shoe            (optional filter)
 *   &all=true                   (include inactive rows, default false)
 *
 * POST /api/admin/bowling/v2/square-products
 *   Upserts a product. Matches on (center_code, product_kind, square_catalog_object_id).
 *   Body: BowlingSquareProduct fields (minus id/insertedAt).
 */

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const centerCode = searchParams.get("centerCode");
  const kind = searchParams.get("kind") as BowlingProductKind | null;
  const includeInactive = searchParams.get("all") === "true";

  if (!centerCode) {
    return NextResponse.json({ error: "centerCode required" }, { status: 400 });
  }

  try {
    const products = await getBowlingSquareProducts(centerCode, kind ?? undefined, includeInactive);
    return NextResponse.json({ products, count: products.length });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const {
    centerCode,
    productKind,
    label,
    squareCatalogObjectId,
    priceCents,
    depositPct,
    sortOrder,
    isActive,
    qamfWebOfferId,
  } = body as {
    centerCode?: string;
    productKind?: BowlingProductKind;
    label?: string;
    squareCatalogObjectId?: string;
    priceCents?: number;
    depositPct?: number;
    sortOrder?: number;
    isActive?: boolean;
    qamfWebOfferId?: number;
  };

  if (!centerCode || !productKind || !label || !squareCatalogObjectId) {
    return NextResponse.json(
      { error: "centerCode, productKind, label, and squareCatalogObjectId are required" },
      { status: 400 },
    );
  }

  try {
    const product = await upsertBowlingSquareProduct({
      centerCode,
      productKind,
      label,
      squareCatalogObjectId,
      priceCents: priceCents ?? 0,
      depositPct: depositPct ?? 100,
      sortOrder: sortOrder ?? 0,
      isActive: isActive ?? true,
      qamfWebOfferId: qamfWebOfferId ?? undefined,
    });
    return NextResponse.json({ product });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
