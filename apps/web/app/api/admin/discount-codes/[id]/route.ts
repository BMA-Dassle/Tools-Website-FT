import { NextRequest, NextResponse } from "next/server";
import {
  getDiscountCodeById,
  provisionSquareDiscount,
  setActive,
  setSquareCatalog,
  updateDiscountCode,
} from "~/features/discount-codes";
import { validateInput } from "../validation";

/**
 * GET    /api/admin/discount-codes/[id]  — fetch a single code
 * PUT    /api/admin/discount-codes/[id]  — update + re-sync Square catalog when bowling is in scope
 * DELETE /api/admin/discount-codes/[id]  — soft-deactivate (active=false). We never hard-delete
 *                                         a code that has redemption history.
 *
 * Admin token gate is enforced by middleware.ts.
 */

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const n = parseInt(id, 10);
  if (!n || isNaN(n)) return NextResponse.json({ error: "invalid id" }, { status: 400 });
  const row = await getDiscountCodeById(n);
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ code: row });
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const n = parseInt(id, 10);
  if (!n || isNaN(n)) return NextResponse.json({ error: "invalid id" }, { status: 400 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const parsed = validateInput(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  let row;
  try {
    row = await updateDiscountCode(n, parsed.value);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("duplicate key")) {
      return NextResponse.json({ error: "code already exists" }, { status: 409 });
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Re-sync Square. If bowling is in scope and we have no catalog id, create one.
  // If we already have a catalog id, push the updated name/percentage to Square.
  if (row.scopes.bowling) {
    try {
      const { catalogId } = await provisionSquareDiscount(row);
      if (catalogId !== row.squareCatalogId) {
        await setSquareCatalog(row.id, catalogId, "discount");
        row.squareCatalogId = catalogId;
        row.squareCatalogType = "discount";
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return NextResponse.json(
        { code: row, squareError: msg, warning: "Code saved but Square sync failed." },
        { status: 207 },
      );
    }
  }

  return NextResponse.json({ code: row });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const n = parseInt(id, 10);
  if (!n || isNaN(n)) return NextResponse.json({ error: "invalid id" }, { status: 400 });
  const existing = await getDiscountCodeById(n);
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });
  // Soft delete only — Square will reject a hard delete on a DISCOUNT that any
  // order references, and we'd lose the redemption-history join target.
  await setActive(n, false);
  return NextResponse.json({ ok: true });
}
