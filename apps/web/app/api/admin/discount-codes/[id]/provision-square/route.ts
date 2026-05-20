import { NextRequest, NextResponse } from "next/server";
import {
  getDiscountCodeById,
  provisionSquareDiscount,
  setSquareCatalog,
} from "~/features/discount-codes";

/**
 * POST /api/admin/discount-codes/[id]/provision-square
 *
 * Retry button for codes that saved but failed Square catalog provisioning
 * on create/update. Only meaningful when bowling is in scope.
 *
 * Admin token gate is enforced by middleware.ts.
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const n = parseInt(id, 10);
  if (!n || isNaN(n)) return NextResponse.json({ error: "invalid id" }, { status: 400 });

  const row = await getDiscountCodeById(n);
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!row.scopes.bowling) {
    return NextResponse.json(
      { error: "code is not in bowling scope; Square provisioning is not applicable" },
      { status: 400 },
    );
  }

  try {
    const { catalogId } = await provisionSquareDiscount(row);
    await setSquareCatalog(row.id, catalogId, "discount");
    return NextResponse.json({ ok: true, squareCatalogId: catalogId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
