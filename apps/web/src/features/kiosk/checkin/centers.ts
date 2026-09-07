/**
 * The kiosk's centre vocabulary, on its own so a server read that only needs
 * "which center_code values belong to this centre" does not have to import
 * the whole check-in server module (Redis, Office, signage…).
 *
 * `center_code` on bowling_reservations carries TWO namespaces — the v1 Square
 * location ids for bowling and the v2 slugs for race/attraction rows — so a
 * centre is a LIST of codes, never one string.
 */
export type CenterSlug = "fort-myers" | "naples";

export function isCenterSlug(v: string): v is CenterSlug {
  return v === "fort-myers" || v === "naples";
}

/** Both center_code namespaces (v1 Square codes + v2 slugs) for one center. */
export const CENTER_CODES_FOR_SLUG: Record<CenterSlug, string[]> = {
  "fort-myers": ["TXBSQN0FEKQ11", "LAB52GY480CJF", "fort-myers", "fasttrax"],
  naples: ["PPTR5G2N0QXF7", "naples"],
};

export function bmiClientKeyFor(slug: CenterSlug): string {
  return slug === "naples" ? "headpinznaples" : "headpinzftmyers";
}
