/**
 * Google review destinations, keyed by Square location id.
 *
 * SINGLE SOURCE OF TRUTH for "where do we send a happy guest to review us."
 * Previously the two HeadPinz place ids were hardcoded inline in
 * `middleware.ts` (/review, /review/naples) and a third copy lived in
 * `emails/race-results.html`. Consumers now import from here.
 *
 * Keyed by Square location id because that is exactly what
 * `guest_surveys.center_code` stores — the guest-survey CTA can resolve a
 * destination straight off the survey row with no lookup table in between.
 * Codes come from `@/lib/qamf-centers` (the center-id single source of truth);
 * do NOT re-hardcode the strings here.
 *
 * Lives in src/lib/constants (not under a feature) because two unrelated
 * surfaces consume it: the brand-level /review redirects in middleware and the
 * guest-survey review CTA. It is constants + one pure resolver, no business
 * logic, and import-free apart from the center codes — which keeps it safe to
 * pull into the edge middleware bundle.
 */

import {
  FASTTRAX_CENTER_CODE,
  HEADPINZ_FM_CENTER_CODE,
  HEADPINZ_NAPLES_CENTER_CODE,
} from "@/lib/qamf-centers";

/**
 * How we reach a center's review surface.
 *
 * `placeId` is the only form that opens Google's star-rating form directly,
 * which is the whole point of the ask — every center uses it today, and the
 * unit test enforces that. `url` remains as an escape hatch for a center with
 * no obtainable place id; if you reach for it, expect the test to make you
 * justify it, because a search-results URL only opens the reviews PANEL and
 * costs the guest an extra tap at exactly the moment they agreed to help.
 */
export type ReviewTarget = { placeId: string } | { url: string };

/** Opens the Google star-rating form directly for a given place id. */
const WRITE_REVIEW_BASE = "https://search.google.com/local/writereview?placeid=";

export const REVIEW_TARGETS: Record<string, ReviewTarget> = {
  [HEADPINZ_FM_CENTER_CODE]: { placeId: "ChIJw7rUvBSl3YgRZnV1tR0aK9s" },
  [HEADPINZ_NAPLES_CENTER_CODE]: { placeId: "ChIJq6qqNOSi3YgREP2LHBrr1g4" },
  // FastTrax Entertainment, 14501 Global Pkwy. Derived from the feature id in
  // Google's own Maps URL for the listing:
  //   FID 0x88db150017c80ddf:0x4e247a50fcc15a01  (CID 5630759922376464897)
  // A place id is base64url over that FID pair, verified by round-tripping
  // both HeadPinz ids above byte-for-byte before trusting this one.
  //
  // NOTE the distinct 0x88db15… prefix: HeadPinz Fort Myers (0x88dda5…) is
  // across the same parking lot, and a CLOSED FastTrax exists at 17455
  // Summerlin Rd. If this ever needs re-deriving, confirm the listing is the
  // Global Pkwy one before copying anything.
  [FASTTRAX_CENTER_CODE]: { placeId: "ChIJ3w3IFwAV24gRAVrB_FB6JE4" },
};

/** Resolve a target to its absolute URL. */
export function reviewUrlFromTarget(target: ReviewTarget): string {
  return "placeId" in target
    ? `${WRITE_REVIEW_BASE}${encodeURIComponent(target.placeId)}`
    : target.url;
}

/**
 * Review URL for a Square location id (= `guest_surveys.center_code`), or
 * `null` when we have no destination for it.
 *
 * Fail-closed by design: an unmapped or missing center yields null, and every
 * caller treats null as "render no CTA / don't redirect to Google". A new
 * center silently gets no review ask rather than being sent to another
 * center's listing.
 */
export function googleReviewUrl(centerCode: string | null | undefined): string | null {
  if (!centerCode) return null;
  const target = REVIEW_TARGETS[centerCode];
  return target ? reviewUrlFromTarget(target) : null;
}
