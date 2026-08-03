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
 * `placeId` is STRONGLY preferred: the `writereview` endpoint opens Google's
 * star-rating form directly, which is the whole point of the ask. `url` is an
 * escape hatch for a center with no known place id.
 */
export type ReviewTarget = { placeId: string } | { url: string };

/** Opens the Google star-rating form directly for a given place id. */
const WRITE_REVIEW_BASE = "https://search.google.com/local/writereview?placeid=";

export const REVIEW_TARGETS: Record<string, ReviewTarget> = {
  [HEADPINZ_FM_CENTER_CODE]: { placeId: "ChIJw7rUvBSl3YgRZnV1tR0aK9s" },
  [HEADPINZ_NAPLES_CENTER_CODE]: { placeId: "ChIJq6qqNOSi3YgREP2LHBrr1g4" },
  // FastTrax has no known Google place id. Owner-supplied URL, stored VERBATIM
  // — the `si=` blob is an opaque Google entity reference and the remaining
  // params were not verified against live behavior, so we do not trim them.
  //
  // KNOWN LIMITATION: this is a search-results URL, so it opens the reviews
  // PANEL rather than the star form — racers tap once more than bowlers do,
  // and the session params (sca_esv/ved/biw/bih/dpr) may stop resolving over
  // time. Swap to `{ placeId: "ChIJ…" }` the moment a real id is available;
  // that is the only edit required. Get one from Google's Place ID Finder, or
  // use the Business Profile "Ask for reviews" g.page/r/…/review short link.
  [FASTTRAX_CENTER_CODE]: {
    url: "https://www.google.com/search?sca_esv=c76ec80322be5402&q=fasttrax+entertainment+reviews&si=APenkKm7iecQ4G6P-TsbSMFKIQtv3EFIqRAFw-i8uEbk55Z-_3mNF0KxJPs4_DX2H2FiParcY4b4kDPfnFjBxO5nIRoNBg8SZcUa3pzfhHYATJEJ5bJH-j4FOzEQNvfIe2Qk8ywPSjlsk6GvNvKsJi6nnNuB1H0hPA%3D%3D&sa=X&ved=2ahUKEwi86_OSs4OWAxUWv4kEHdX1B04QyNoBKAB6BAgXEAA&ictx=1&biw=1324&bih=772&dpr=1.25",
  },
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
