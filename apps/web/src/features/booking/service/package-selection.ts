/**
 * Package selection edits on a race item — the pure state math behind taking a
 * premium package (Rookie Pack / Ultimate Qualifier) OFF an order.
 *
 * It lives outside the components because THREE surfaces perform the same edit
 * and must perform it identically: the product step's Remove on the selected
 * package card, the product step's "picking a single race replaces it" path, and
 * the kiosk cart's Remove. Before this existed, only the middle one was wired —
 * so a guest who tapped Rookie Pack (which auto-advances to the heat picker) had
 * no way back out except deleting the whole race item (owner report 2026-08-03).
 *
 * Returning the dropped heats instead of releasing them keeps this pure: the BMI
 * line release is a network side effect and stays with the caller, which is also
 * where the existing release helper (`releaseHeatBmiLines`) already lives.
 */
import type { RaceHeatAssignment, RaceItem } from "../state/types";
import { getPackage } from "./packages";

export interface PackageClearResult {
  /** Item patch — the category's package id cleared, plus the surviving heats
   *  when the package was holding any. */
  patch: Partial<RaceItem>;
  /** The package's own held heats, dropped by `patch`. Release the BMI lines of
   *  every entry carrying a `bmiLineId`. */
  removed: RaceHeatAssignment[];
}

/**
 * Clear ONE category's package (adult and junior variants are separate ids and
 * separate decisions) and drop the heats that package was holding — a heat in
 * this category whose product is one of the package's own race components.
 * Single races the guest added alongside it are untouched.
 *
 * Safe to call when no package is selected: the patch still nulls the field
 * (idempotent) and `removed` is empty.
 */
export function clearPackageForCategory(
  item: Pick<RaceItem, "packageIdAdult" | "packageIdJunior" | "heats">,
  category: "adult" | "junior",
): PackageClearResult {
  const patch: Partial<RaceItem> =
    category === "adult" ? { packageIdAdult: null } : { packageIdJunior: null };
  const pkg = getPackage(category === "adult" ? item.packageIdAdult : item.packageIdJunior);
  if (!pkg) return { patch, removed: [] };

  const productIds = new Set(pkg.races.flatMap((r) => r.tracks.map((t) => t.productId)));
  const removed = item.heats.filter(
    (h) =>
      !!h.heatId &&
      (h.category ?? "adult") === category &&
      !!h.productId &&
      productIds.has(h.productId),
  );
  if (removed.length === 0) return { patch, removed: [] };

  const removedSet = new Set(removed);
  return { patch: { ...patch, heats: item.heats.filter((h) => !removedSet.has(h)) }, removed };
}
