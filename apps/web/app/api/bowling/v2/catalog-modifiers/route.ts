import { NextRequest, NextResponse } from "next/server";
import {
  fetchModifierGroups,
  fetchModifierGroupsForCatalogObject,
} from "~/features/package-food/catalog";

/**
 * GET /api/bowling/v2/catalog-modifiers
 *
 * Returns Square catalog modifier groups + options for a package's food item.
 * Thin shell over ~/features/package-food/catalog (the server builds the same
 * groups itself for check-in and the post-booking editor).
 *
 * Two modes:
 *
 * 1. modifierListIds (preferred) — comma-separated Square modifier list IDs
 *    stored on the bowling_experience row. Skips catalog object lookup.
 *
 * 2. catalogObjectId — resolve modifier lists from the catalog item/variation,
 *    with the item's per-list min/max applied.
 *
 * Response: ModifierGroup[] — see food-config.ts. A Square failure answers []
 * with 200, as it always has; the booking step treats an empty list as
 * "unavailable, retry" rather than "nothing to pick" (fail-closed, 2026-09-06).
 */
export async function GET(req: NextRequest) {
  const modifierListIdsParam = req.nextUrl.searchParams.get("modifierListIds");
  if (modifierListIdsParam) {
    const ids = modifierListIdsParam
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (ids.length === 0) return NextResponse.json([], { status: 200 });
    try {
      return NextResponse.json(await fetchModifierGroups(ids));
    } catch (err) {
      console.error("[catalog-modifiers] error fetching by list IDs:", err);
      return NextResponse.json([], { status: 200 });
    }
  }

  const catalogObjectId = req.nextUrl.searchParams.get("catalogObjectId");
  if (!catalogObjectId) {
    return NextResponse.json(
      { error: "modifierListIds or catalogObjectId required" },
      { status: 400 },
    );
  }
  try {
    return NextResponse.json(await fetchModifierGroupsForCatalogObject(catalogObjectId));
  } catch (err) {
    console.error("[catalog-modifiers] error:", err instanceof Error ? err.message : err);
    return NextResponse.json([], { status: 200 });
  }
}
