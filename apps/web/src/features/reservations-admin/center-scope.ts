/**
 * Center-scope filtering for the admin reservations board.
 *
 * BRIDGE (see tasks/future/center-code-normalization.md): `center_code` holds
 * two namespaces — bowling rows store the Square location ID, race/attraction
 * rows store a center slug ('fort-myers' | 'naples'). The 'fort-myers' slug is
 * shared by TWO physical centers: FastTrax racing AND HeadPinz FM attractions
 * (laser tag, gel blaster, shuffly — HeadPinz products since 2026-06). So a
 * center-scoped board fetch pulls the slug's rows for BOTH embeds and this
 * module decides per row which board it belongs on.
 */

/**
 * Attraction slugs whose revenue/operation is FastTrax, not HeadPinz.
 * Mirror of FASTTRAX_ATTRACTION_SLUGS in
 * ~/features/booking/service/unified-reserve.ts (kept separate so the board
 * route doesn't import the whole reserve module). If the two drift, the
 * failure is benign: a FastTrax attraction also shows on the HeadPinz FM
 * board — visible-but-extra, never invisible.
 */
export const FASTTRAX_ATTRACTION_SLUGS = new Set<string>(["duck-pin"]);

interface ScopedRow {
  centerCode: string;
  productKind: string;
  bookingMetadata?: Record<string, unknown>;
}

/** Attraction slugs persisted at reserve time (booking_metadata.attractions). */
function attractionSlugs(row: ScopedRow): string[] {
  const attractions = row.bookingMetadata?.attractions;
  if (!Array.isArray(attractions)) return [];
  return attractions
    .map((a) => (a && typeof a === "object" ? (a as { slug?: unknown }).slug : undefined))
    .filter((s): s is string => typeof s === "string" && s.length > 0);
}

/** At least one attraction leg on the row is HeadPinz-owned (not FastTrax). */
function hasHeadpinzAttraction(row: ScopedRow): boolean {
  return attractionSlugs(row).some((s) => !FASTTRAX_ATTRACTION_SLUGS.has(s));
}

/**
 * Whether a row fetched for the HeadPinz Fort Myers board (center
 * TXBSQN0FEKQ11, aliased to also fetch the 'fort-myers' slug) belongs on it:
 * - native rows (Square-ID center_code, i.e. bowling/KBF) — always
 * - 'fort-myers' slug attractions — yes unless every slug is FastTrax-owned
 *   (rows with no slug metadata stay visible: visible-but-extra beats invisible)
 * - 'fort-myers' slug races — only when the cart also bought a HeadPinz
 *   attraction: a mixed race + attraction cart writes ONE anchor row with
 *   product_kind 'race' (unified-reserve), the attraction legs living in
 *   booking_metadata.attractions. That laser tag / gel blaster session happens
 *   AT HeadPinz, so its staff must see the row. Pure races stay FastTrax-only.
 */
export function belongsOnHeadpinzFmBoard(row: ScopedRow): boolean {
  if (row.centerCode !== "fort-myers") return true;
  if (row.productKind === "attraction") {
    return attractionSlugs(row).length === 0 || hasHeadpinzAttraction(row);
  }
  if (row.productKind === "race") return hasHeadpinzAttraction(row);
  return false;
}
