import { NextRequest, NextResponse } from "next/server";
import {
  insertDiscountCode,
  listDiscountCodes,
  provisionSquareDiscount,
  setSquareCatalog,
  type DiscountCodeInput,
} from "~/features/discount-codes";
import { validateInput } from "./validation";

/**
 * GET  /api/admin/discount-codes        — list all codes (active + inactive)
 * POST /api/admin/discount-codes        — create a code; provisions Square DISCOUNT if bowling is in scope
 *
 * Admin token gate is enforced by middleware.ts (ADMIN_CAMERA_TOKEN).
 * The route handler trusts that gate and focuses on validation + persistence.
 */

export async function GET() {
  const rows = await listDiscountCodes();
  return NextResponse.json({ codes: rows });
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const parsed = validateInput(body);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  const input: DiscountCodeInput = parsed.value;

  let row;
  try {
    row = await insertDiscountCode(input, "admin");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("duplicate key")) {
      return NextResponse.json({ error: "code already exists" }, { status: 409 });
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  // Provision Square Catalog DISCOUNT when bowling is in scope. Bowling is
  // the only Square-native domain in v1 — racing/attractions go through BMI
  // and don't need a Square catalog object.
  if (row.scopes.bowling) {
    try {
      const { catalogId } = await provisionSquareDiscount(row);
      await setSquareCatalog(row.id, catalogId, "discount");
      row.squareCatalogId = catalogId;
      row.squareCatalogType = "discount";
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Row exists but Square provisioning failed — admin sees a "Retry
      // provision" button. Code is not customer-usable until provisioning
      // succeeds (bowling validate will return null squareCatalogId, but
      // the quote injection step would then fail at charge time).
      return NextResponse.json(
        {
          code: row,
          squareError: msg,
          warning:
            "Code saved but Square provisioning failed. Use Retry to provision before customers redeem.",
        },
        { status: 207 },
      );
    }
  }

  return NextResponse.json({ code: row }, { status: 201 });
}
