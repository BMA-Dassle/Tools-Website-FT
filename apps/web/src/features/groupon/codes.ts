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
 * the short form matches a same-length promo code, and its all-digit case
 * (`89895632` is a real production Groupon code) matches the bare game-card
 * barcode rule. Only a lookup can decide, so these are pre-filters that keep us
 * from making a pointless network call — never proof.
 */

/**
 * Groupon's short code as the guest presents it: 7 OR 8 alphanumerics
 * (`WNDXH4DJ`, and the 7-long form the owner saw in the wild 2026-08-22).
 *
 * WHY A RANGE AND NOT TWO RULES. Length is not a signal here — nothing
 * downstream branches on it, and the code is only ever handed to a lookup that
 * answers "mine" or "never heard of it". A range is therefore the honest
 * expression of what we know, and widening it again costs one character.
 *
 * WHAT THE 7 COSTS. A 7-character code is ambiguous exactly the way the 8 was:
 * a 7-character promo code now spends one speculative Groupon round-trip before
 * the promo validator answers (the kiosk asks Groupon first for any candidate —
 * see `routeWithGrouponFallback`). That is the trade already accepted for the
 * 8-character form, and the asymmetry is stark: a wrong guess costs a
 * round-trip, a missed Groupon turns a paying guest away at the kiosk.
 *
 * A 7-DIGIT RUN STAYS A PROMO, NOT A GAME CARD. The bare game-card barcode rule
 * is `^\d{8,}$`, so unlike the 8-digit case a 7-digit Groupon never lands on the
 * game-card rail — it falls to the promo catch-all and the hint rides with it.
 * The padded 16-digit barcode is matched BEFORE its zero-stripping, so a card
 * whose account number is 7 digits (`0000000001038091` → `1038091`) is not
 * flagged either.
 */
export const GROUPON_CODE_RE = /^[A-Z0-9]{7,8}$/;

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
