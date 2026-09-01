import { NextRequest, NextResponse } from "next/server";

/**
 * GET /api/bowling/v2/catalog-modifiers
 *
 * Returns Square catalog modifier groups + options for a pizza-bowl package.
 *
 * Two modes:
 *
 * 1. modifierListIds (preferred) — comma-separated Square modifier list IDs
 *    stored on the bowling_experience row. Skips catalog object lookup.
 *    Used when the experience has squareModifierListIds set.
 *
 * 2. catalogObjectId — legacy: resolve modifier lists from the catalog item/
 *    variation. Falls back gracefully if the item has no modifier_list_info.
 *
 * Response:
 *   Array<{
 *     id:       string;
 *     name:     string;   — e.g. "Pizza Toppings", "Soda Choice"
 *     selectionType: "SINGLE" | "MULTIPLE"
 *     minSelected: number — 0 = OPTIONAL. Square's -1 ("no limit") normalises
 *                           to 0 here, because for a REQUIREMENT no-limit means
 *                           no minimum.
 *     maxSelected: number | null — null = unlimited
 *     options: Array<{ id: string; name: string; priceCents: number }>
 *   }>
 *
 * minSelected/maxSelected and per-option prices were added 2026-08-31 for the
 * NFL wings, which mix REQUIRED lists (sauce, dipper, breaded-or-naked) with
 * OPTIONAL paid ones (drums/flats +$2, extra sauce +75c). Without them the
 * booking step required a pick in every list and showed no prices — fine while
 * Pizza Bowl was the only package, wrong the moment a second one arrived.
 */

const SQUARE_BASE = "https://connect.squareup.com/v2";
const SQUARE_TOKEN = process.env.SQUARE_ACCESS_TOKEN || "";
const SQUARE_VERSION = "2024-12-18";

function sqHeaders() {
  return {
    Authorization: `Bearer ${SQUARE_TOKEN}`,
    "Content-Type": "application/json",
    "Square-Version": SQUARE_VERSION,
  };
}

type SquareCatalogObject = {
  type: string;
  id: string;
  item_data?: {
    modifier_list_info?: Array<{
      modifier_list_id: string;
      enabled?: boolean;
      /** PER-ITEM override. Authoritative over the list's own values — the same
       *  list is "pick 1, required" on one item and optional on another. */
      min_selected_modifiers?: number;
      max_selected_modifiers?: number;
      ordinal?: number;
    }>;
  };
  modifier_list_data?: {
    name?: string;
    selection_type?: "SINGLE" | "MULTIPLE";
    min_selected_modifiers?: number;
    max_selected_modifiers?: number;
    modifiers?: Array<{
      type: string;
      id: string;
      modifier_data?: {
        name?: string;
        ordinal?: number;
        price_money?: { amount?: number; currency?: string };
      };
    }>;
  };
};

/** Per-item min/max, keyed by modifier list id. */
type ListOverrides = Map<string, { min?: number; max?: number }>;

async function fetchModifierGroups(listIds: string[], overrides: ListOverrides = new Map()) {
  const batchRes = await fetch(`${SQUARE_BASE}/catalog/batch-retrieve`, {
    method: "POST",
    headers: sqHeaders(),
    body: JSON.stringify({ object_ids: listIds }),
  });

  if (!batchRes.ok) {
    console.warn(`[catalog-modifiers] batch-retrieve failed: ${batchRes.status}`);
    return [];
  }

  const batchData = (await batchRes.json()) as {
    objects?: SquareCatalogObject[];
    errors?: unknown;
  };

  if (batchData.errors) {
    console.warn("[catalog-modifiers] batch-retrieve errors:", JSON.stringify(batchData.errors));
    return [];
  }

  return (batchData.objects ?? [])
    .filter((o) => o.type === "MODIFIER_LIST")
    .map((ml) => {
      const data = ml.modifier_list_data ?? {};
      const options = (data.modifiers ?? [])
        .filter((m) => m.type === "MODIFIER")
        .sort((a, b) => (a.modifier_data?.ordinal ?? 0) - (b.modifier_data?.ordinal ?? 0))
        .map((m) => ({
          id: m.id,
          name: m.modifier_data?.name ?? m.id,
          priceCents: m.modifier_data?.price_money?.amount ?? 0,
        }));
      // The PER-ITEM override wins. The same list can be required on one item
      // and optional on another — "Mixed, Drums or Flats" is min 1 on the
      // à-la-carte wings and min 0 on the game-day package — so reading the
      // list's own values would make every package inherit the register's rules.
      const ov = overrides.get(ml.id) ?? {};
      // Square uses -1 for "unset / no limit". For a MINIMUM that means no
      // minimum, i.e. optional — so it normalises to 0, not to "required".
      const rawMin = ov.min ?? data.min_selected_modifiers ?? -1;
      const rawMax = ov.max ?? data.max_selected_modifiers ?? -1;
      return {
        id: ml.id,
        name: data.name ?? "Options",
        selectionType: data.selection_type ?? ("SINGLE" as const),
        minSelected: rawMin > 0 ? rawMin : 0,
        maxSelected: rawMax > 0 ? rawMax : null,
        options,
      };
    });
}

export async function GET(req: NextRequest) {
  if (!SQUARE_TOKEN) {
    console.warn("[catalog-modifiers] SQUARE_ACCESS_TOKEN not set");
    return NextResponse.json([], { status: 200 });
  }

  // ── Mode 1: direct modifier list IDs (from bowling_experience row) ──
  const modifierListIdsParam = req.nextUrl.searchParams.get("modifierListIds");
  if (modifierListIdsParam) {
    const ids = modifierListIdsParam
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (ids.length === 0) return NextResponse.json([], { status: 200 });

    try {
      const groups = await fetchModifierGroups(ids);
      console.log(`[catalog-modifiers] Returning ${groups.length} groups via direct IDs`);
      return NextResponse.json(groups);
    } catch (err) {
      console.error("[catalog-modifiers] error fetching by list IDs:", err);
      return NextResponse.json([], { status: 200 });
    }
  }

  // ── Mode 2: catalog object lookup (legacy / fallback) ───────────────
  const catalogObjectId = req.nextUrl.searchParams.get("catalogObjectId");
  if (!catalogObjectId) {
    return NextResponse.json(
      { error: "modifierListIds or catalogObjectId required" },
      { status: 400 },
    );
  }

  try {
    const objRes = await fetch(
      `${SQUARE_BASE}/catalog/object/${catalogObjectId}?include_related_objects=true`,
      { headers: sqHeaders() },
    );

    if (!objRes.ok) {
      console.warn(
        `[catalog-modifiers] Square object fetch failed: ${objRes.status} for ${catalogObjectId}`,
      );
      return NextResponse.json([], { status: 200 });
    }

    const objData = (await objRes.json()) as {
      object?: SquareCatalogObject;
      related_objects?: SquareCatalogObject[];
      errors?: unknown;
    };

    if (objData.errors) {
      console.warn("[catalog-modifiers] Square errors:", JSON.stringify(objData.errors));
      return NextResponse.json([], { status: 200 });
    }

    const rootObject = objData.object;
    if (!rootObject) return NextResponse.json([], { status: 200 });

    // Resolve the ITEM that has modifier_list_info
    let itemObject: SquareCatalogObject | undefined;
    if (rootObject.type === "ITEM") {
      itemObject = rootObject;
    } else if (rootObject.type === "ITEM_VARIATION") {
      itemObject = objData.related_objects?.find((o) => o.type === "ITEM");
    }

    const modListInfos = itemObject?.item_data?.modifier_list_info ?? [];
    const enabled = modListInfos
      .filter((m) => m.enabled !== false)
      // Render in the order the item declares, not the order Square returns.
      .sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0));
    const enabledListIds = enabled.map((m) => m.modifier_list_id);
    const overrides: ListOverrides = new Map(
      enabled.map((m) => [
        m.modifier_list_id,
        { min: m.min_selected_modifiers, max: m.max_selected_modifiers },
      ]),
    );

    if (enabledListIds.length === 0) {
      console.warn(`[catalog-modifiers] No enabled modifier lists for ${catalogObjectId}`);
      return NextResponse.json([], { status: 200 });
    }

    const groups = await fetchModifierGroups(enabledListIds, overrides);
    console.log(`[catalog-modifiers] Returning ${groups.length} groups via catalog lookup`);
    return NextResponse.json(groups);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    console.error("[catalog-modifiers] error:", msg);
    return NextResponse.json([], { status: 200 });
  }
}
