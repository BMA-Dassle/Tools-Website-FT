/**
 * Square catalog → modifier groups for a package's configurable food item.
 *
 * Extracted from app/api/bowling/v2/catalog-modifiers (2026-09-06) so the
 * server can build a reservation's food picker itself — the check-in gate, the
 * post-booking editor and the admin board all need the same groups the booking
 * step showed, and a route calling its own HTTP endpoint is the wrong seam.
 *
 * Response shape per group:
 *   minSelected: 0 = OPTIONAL. Square's -1 ("no limit") normalises to 0 here,
 *                because for a REQUIREMENT no-limit means no minimum. (Whether
 *                the guest must pick is ALSO decided by the package's
 *                included_modifier_count — see food-config.ts; Square's
 *                minimums are honoured on top of it, never instead of it.)
 *   maxSelected: null = unlimited.
 *
 * minSelected/maxSelected and per-option prices were added 2026-08-31 for the
 * NFL wings, which mix REQUIRED lists (sauce, dipper, breaded-or-naked) with
 * OPTIONAL paid ones (drums/flats +$2, extra sauce +75c).
 */
import type { ModifierGroup } from "~/features/booking/service/food-config";

const SQUARE_BASE = "https://connect.squareup.com/v2";
const SQUARE_VERSION = "2024-12-18";

function sqHeaders() {
  return {
    Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN || ""}`,
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

/** Thrown when Square did not answer — callers decide whether that blocks. */
export class CatalogUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogUnavailableError";
  }
}

export async function fetchModifierGroups(
  listIds: string[],
  overrides: ListOverrides = new Map(),
): Promise<ModifierGroup[]> {
  if (listIds.length === 0) return [];
  const batchRes = await fetch(`${SQUARE_BASE}/catalog/batch-retrieve`, {
    method: "POST",
    headers: sqHeaders(),
    body: JSON.stringify({ object_ids: listIds }),
  });
  if (!batchRes.ok) {
    throw new CatalogUnavailableError(`batch-retrieve failed: ${batchRes.status}`);
  }
  const batchData = (await batchRes.json()) as {
    objects?: SquareCatalogObject[];
    errors?: unknown;
  };
  if (batchData.errors) {
    throw new CatalogUnavailableError(`batch-retrieve errors: ${JSON.stringify(batchData.errors)}`);
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

/**
 * Resolve the modifier groups hanging off a catalog ITEM or ITEM_VARIATION, in
 * the order the item declares them, with the item's per-list min/max applied.
 * Returns [] for an item with no enabled lists (nothing to configure).
 */
export async function fetchModifierGroupsForCatalogObject(
  catalogObjectId: string,
): Promise<ModifierGroup[]> {
  if (!process.env.SQUARE_ACCESS_TOKEN) {
    throw new CatalogUnavailableError("SQUARE_ACCESS_TOKEN not set");
  }
  const objRes = await fetch(
    `${SQUARE_BASE}/catalog/object/${catalogObjectId}?include_related_objects=true`,
    { headers: sqHeaders() },
  );
  if (!objRes.ok) {
    throw new CatalogUnavailableError(
      `catalog object fetch failed: ${objRes.status} for ${catalogObjectId}`,
    );
  }
  const objData = (await objRes.json()) as {
    object?: SquareCatalogObject;
    related_objects?: SquareCatalogObject[];
    errors?: unknown;
  };
  if (objData.errors) {
    throw new CatalogUnavailableError(`catalog errors: ${JSON.stringify(objData.errors)}`);
  }
  const rootObject = objData.object;
  if (!rootObject) return [];

  // Resolve the ITEM that has modifier_list_info
  let itemObject: SquareCatalogObject | undefined;
  if (rootObject.type === "ITEM") {
    itemObject = rootObject;
  } else if (rootObject.type === "ITEM_VARIATION") {
    itemObject = objData.related_objects?.find((o) => o.type === "ITEM");
  }

  const enabled = (itemObject?.item_data?.modifier_list_info ?? [])
    .filter((m) => m.enabled !== false)
    // Render in the order the item declares, not the order Square returns.
    .sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0));
  if (enabled.length === 0) return [];

  const overrides: ListOverrides = new Map(
    enabled.map((m) => [
      m.modifier_list_id,
      { min: m.min_selected_modifiers, max: m.max_selected_modifiers },
    ]),
  );
  return fetchModifierGroups(
    enabled.map((m) => m.modifier_list_id),
    overrides,
  );
}
