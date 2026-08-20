/**
 * Groupon code SHAPES — pure, no network, no env, no server imports.
 *
 * These live apart from `service/resolve.server.ts` on purpose. The kiosk
 * classifier runs in the browser bundle, and `resolve.server.ts` reaches the
 * signing key through `client.server.ts`; importing the resolver to get a regex
 * would drag credentials toward a client bundle and fail the `next build` gate
 * that keeps them out. Same split as `game-cards/vouchers/codes` — shapes are
 * shared, the rail is not.
 *
 * NOTHING HERE IS A VERDICT. Both shapes collide with codes we already accept:
 * the 8-character form matches an 8-character promo code, and its all-digit
 * case (`89895632` is a real production Groupon code) matches the bare
 * game-card barcode rule. Only a lookup can decide, so these are pre-filters
 * that keep us from making a pointless network call — never proof.
 */

/** Groupon's short code as the guest presents it: 8 alphanumerics (`WNDXH4DJ`). */
export const GROUPON_CODE_RE = /^[A-Z0-9]{8}$/;

/**
 * The printed/emailed form: `VS-XXXX-XXXX-XXXX-XXXX`. This one IS unambiguous —
 * no other code this kiosk accepts carries four hyphen-separated quads behind a
 * `VS` prefix, and today it classifies as a meaningless promo candidate.
 */
export const GROUPON_LONG_CODE_RE = /^VS(?:-[A-Z0-9]{4}){4}$/;

export function normalizeGrouponCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, "");
}

/** Could this string be a Groupon code at all? Cheap pre-filter, not authority. */
export function looksLikeGrouponCode(raw: string): boolean {
  const c = normalizeGrouponCode(raw);
  return GROUPON_CODE_RE.test(c) || GROUPON_LONG_CODE_RE.test(c);
}
