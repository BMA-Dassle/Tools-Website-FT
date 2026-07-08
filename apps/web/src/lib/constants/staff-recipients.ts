/**
 * CENTRAL per-center staff alert recipients — THE place to edit who gets
 * booking/special alerts for each HeadPinz center (owner 7/6: "somewhere
 * central so we can edit for any special").
 *
 * Any feature that emails staff about a center-scoped booking (World Cup VIP,
 * future specials) should import from here instead of hardcoding addresses.
 * The Ultimate VIP combo alert keeps its own cross-business list in
 * features/combos/combo-notify.ts (it spans FastTrax + HeadPinz).
 *
 * Plain constants — no business logic (lib/constants convention).
 */

export type HeadPinzCenterKey = "fort-myers" | "naples";

/** Corporate — on EVERY center's alerts (owner 7/6: "that's corp"). */
export const CORP_STAFF_RECIPIENTS = [
  "jacob@headpinz.com",
  "curtis@headpinz.com",
  "eric@headpinz.com",
];

/** Each center's own crew (owner list 2026-07-06) — corp is appended by
 *  staffRecipientsForCenter, so edit only the local names here. */
export const CENTER_STAFF_RECIPIENTS: Record<HeadPinzCenterKey, string[]> = {
  "fort-myers": ["bruce@headpinz.com", "abigail@headpinz.com", "tyler@headpinz.com"],
  naples: ["donald@headpinz.com", "donna@headpinz.com", "carter@headpinz.com"],
};

export const CENTER_DISPLAY_NAMES: Record<HeadPinzCenterKey, string> = {
  "fort-myers": "HeadPinz Fort Myers",
  naples: "HeadPinz Naples",
};

/** Normalize any center identifier the app passes around — v2 CenterCode,
 *  Square center code, or QAMF numeric id — to a HeadPinz center key. */
export function normalizeCenterKey(
  center: string | number | null | undefined,
): HeadPinzCenterKey | null {
  switch (String(center)) {
    case "fort-myers":
    case "TXBSQN0FEKQ11":
    case "9172":
      return "fort-myers";
    case "naples":
    case "PPTR5G2N0QXF7":
    case "3148":
      return "naples";
    default:
      return null;
  }
}

/** Recipients for a center = that center's crew + corp (deduped), falling
 *  back to Fort Myers when the id is unrecognized — better a misrouted alert
 *  than a silent one. */
export function staffRecipientsForCenter(center: string | number | null | undefined): string[] {
  const crew = CENTER_STAFF_RECIPIENTS[normalizeCenterKey(center) ?? "fort-myers"];
  return [...new Set([...crew, ...CORP_STAFF_RECIPIENTS])];
}
