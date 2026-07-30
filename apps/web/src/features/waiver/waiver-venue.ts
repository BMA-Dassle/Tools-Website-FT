/**
 * center_code -> the VENUE a waiver files against.
 *
 * A group quote stores `center_code`, but a waiver link needs two things the
 * quote does not spell out: the `?c=` CenterCode and the BMI `loc` id. Those are
 * not the same axis — "fort-myers" is a METRO with two venues on one BMI server
 * (HeadPinz FM 332160 and FastTrax 467486), and the BMI locationId is what
 * decides which PANDORA location the signature is filed at:
 *
 *   332160 -> headpinz  TXBSQN0FEKQ11
 *   467486 -> fasttrax  LAB52GY480CJF
 *   332145 -> naples    PPTR5G2N0QXF7
 *
 * Getting it wrong does not fail loudly — `/api/waiver/context` accepts EITHER
 * FM id for center "fort-myers" — it just files a FastTrax guest's waiver under
 * HeadPinz, or serves the wrong venue's template. Naples is the sharp edge: it
 * has its own Pandora location AND its own waiver template (contentID 5958737 vs
 * FM 19065376), so a Naples waiver filed at Fort Myers is not a valid waiver.
 *
 * The mapping is deliberately the INVERSE of `PANDORA_LOCATION_IDS` in
 * lib/bmi-office-actions.ts, which is the existing authority on what a
 * center_code means: "fort-myers" is HeadPinz FM, "fasttrax" is FastTrax, and
 * they are distinct venues rather than a brand flag on one venue. Nothing here
 * consults `quote.brand` — brand picks the email's LOGO and origin host, not the
 * location a waiver is filed at, and letting it decide the venue is how a
 * brand-less caller ends up defaulting a Naples event to Fort Myers.
 *
 * UNKNOWN center_code RETURNS NULL — never a default. Defaulting to HP-FM is the
 * bug fixed in `app/api/pandora/waiver/route.ts` (commit d261ef7e): it silently
 * files waivers at the wrong location instead of refusing, and a refused link
 * degrades to the center-less picker, which ASKS. A wrong answer is worse than
 * no answer here.
 */
import type { CenterCode } from "~/features/booking/types";

export interface WaiverVenue {
  /** The `?c=` value — the METRO, which is all the waiver page needs to brand. */
  center: CenterCode;
  /**
   * BMI locationId, as a STRING. Kept as text end to end so no caller is tempted
   * to Number() it alongside the projectId it always travels with.
   */
  locationId: string;
}

/**
 * Keyed by the `center_code` values group quotes actually store — the same three
 * keys as `PANDORA_LOCATION_IDS` / `CLIENT_KEYS` in lib/bmi-office-actions.ts.
 * Adding a venue means adding it in both places; the test pins these ids against
 * `CENTER_TO_BMI_LOCATION_IDS`, which is what `/api/waiver/context` validates
 * against, so a pair that could never resolve fails here rather than in an inbox.
 */
const VENUES: Record<string, WaiverVenue> = {
  "fort-myers": { center: "fort-myers", locationId: "332160" },
  fasttrax: { center: "fort-myers", locationId: "467486" },
  naples: { center: "naples", locationId: "332145" },
};

/** The venue for a stored `center_code`, or null when we do not recognise it. */
export function waiverVenueForCenterCode(
  centerCode: string | null | undefined,
): WaiverVenue | null {
  const key = String(centerCode ?? "")
    .trim()
    .toLowerCase();
  if (!key) return null;
  return Object.prototype.hasOwnProperty.call(VENUES, key) ? VENUES[key] : null;
}
