/**
 * Public surface of the maintenance feature — vendor-outage "maintenance mode".
 *
 * One registry ([outages.ts]) + one vendor map ([vendors.ts]) drive every
 * surface, so an incident is declared once:
 *
 *   web      middleware.ts sends every booking entry for a paused product to
 *            /service-notice (one gate covers ~90 legacy + v2 links, email/QR
 *            deep links and bookmarks), and /book/v2 renders those tiles as
 *            locked instead of clicking through to a redirect.
 *   kiosk    /api/kiosk/availability marks the products paused; the tiles lock
 *            with the outage note (EN + ES) instead of "nothing left today".
 *   money    the BMI proxy refuses the sale-opening writes, so a cached page or
 *            an in-flight tab can never open a bill we can't fulfil.
 *
 * Import from "~/features/maintenance" — never from the subfiles.
 */
export { VENDOR_LABEL, vendorsForProduct, allProductIds } from "./vendors";
export type { VendorKey } from "./vendors";
export {
  activeOutages,
  isVendorDown,
  isProductPaused,
  outageForProduct,
  vendorPhrase,
} from "./outages";
export type { VendorOutage } from "./outages";

import { allProductIds, vendorsForProduct } from "./vendors";
import { activeOutages, isProductPaused, outageForProduct } from "./outages";

/** Where a blocked guest lands. Registered in middleware's
 *  `isSharedTopLevelRoute` so it serves on BOTH brand hosts — deliberately NOT
 *  named `/book…`: the /hp rewrite skips anything starting with "/book", which
 *  would have served FastTrax chrome to HeadPinz visitors. */
export const SERVICE_NOTICE_PATH = "/service-notice";

/** Is ANY vendor outage live? Drives the "should I even look" fast paths. */
export function maintenanceActive(): boolean {
  return activeOutages().length > 0;
}

/**
 * The product id a booking URL sells, or null when the path is not a booking
 * entry we gate. Accepts v1 and v2 paths and an optional `/hp` prefix, matching
 * `bookingV2Target` in middleware.ts so the two gates agree on what "a booking
 * entry" is.
 *
 * NEVER matches a post-purchase surface. `/confirmation` and `/checkin` are how
 * a guest who ALREADY paid reads their reservation (and how texted lane-ready
 * links work) — bouncing those to an outage notice would hide reservations that
 * are perfectly valid.
 */
export function bookingProductForPath(pathname: string): string | null {
  const p = (pathname.replace(/^\/hp/, "").replace(/\/+$/, "") || "/").toLowerCase();

  // The unified waiver flow. BMI-backed end to end: the signature is stored on
  // the Pandora person and our acceptance row is keyed by that personId, so with
  // BMI dark there is no person to sign for (owner 2026-08-03).
  //
  // Exact match or a trailing-slash prefix — NEVER a bare startsWith("/waiver"),
  // which would also swallow /waiver-3 (a static legal page that has nothing to
  // do with signing and must stay up). Same trap the middleware documents for
  // /w vs /waiver and /book/bowling vs /book/bowling-confirmation.
  //
  // /w/{code} short links are covered for free: that resolver 302s to /waiver,
  // which lands here on the next request.
  if (p === "/waiver" || p.startsWith("/waiver/")) return "waiver";

  if (!p.startsWith("/book")) return null;
  if (p.includes("/confirmation") || p.includes("/checkin")) return null;

  // Racing: exact only — "/book/race-packs" and "/book/race/confirmation" are
  // different products/surfaces (the same trap bookingV2Target documents).
  if (p === "/book/race" || p === "/book/race/v2") return "race";
  if (p === "/book/race-packs" || p === "/book/race-pack/v2") return "race-pack";

  // Attraction flows, v1 (`/book/laser-tag`) and v2 (`/book/laser-tag/v2`).
  for (const slug of ["gel-blaster", "laser-tag", "shuffly", "duck-pin"]) {
    if (p === `/book/${slug}` || p.startsWith(`/book/${slug}/`)) return slug;
  }

  // Combos are registry-driven, so match on the id rather than enumerating
  // them: every combo whose id names racing depends on BMI race legs. A
  // future bowling-only combo keeps selling — which is the point of keying on
  // the vendor and not on "is it a combo".
  const combo = /^\/book\/combo\/([^/]+)/.exec(p);
  if (combo) return combo[1].includes("race") ? "race-bowl" : null;

  return null;
}

/**
 * Where middleware should send this request, or null to let it through.
 * The product id rides along as `?a=` so the notice can name what the guest
 * came for instead of a generic wall.
 */
export function maintenanceRedirectForPath(pathname: string): { path: string; product: string } | null {
  const product = bookingProductForPath(pathname);
  if (!product || !isProductPaused(product)) return null;
  return { path: SERVICE_NOTICE_PATH, product };
}

/**
 * Every product id currently off sale. The kiosk availability payload carries
 * this list so tiles can show the OUTAGE note ("see Guest Services") rather
 * than the end-of-day note ("nothing left to book today") — two very different
 * things to tell a guest standing in the building.
 */
export function pausedProductIds(): string[] {
  return allProductIds().filter((id) => isProductPaused(id));
}

/** The kiosk note (EN + ES) for a paused product, or null when it's sellable. */
export function kioskOutageCopy(id: string): { en: string; es: string } | null {
  return outageForProduct(id)?.kiosk ?? null;
}

/**
 * BMI proxy endpoints refused while BMI is down.
 *
 * ONLY the writes that OPEN a sale. Deliberately excluded:
 *   payment/confirm  — a session that already charged the card must be allowed
 *                      to finish; blocking mid-flow is how you create an orphan
 *                      charge (tasks/lessons.md, kiosk captured-no-reserve).
 *   booking/removeItem, bill DELETE, booking/memo
 *                    — teardown and annotation. Abandon-cancel has to keep
 *                      running or abandoned holds sit on heats forever.
 *   every GET        — availability/order/person reads feed admin, ops scripts
 *                      and the recovery probes that tell us BMI is back.
 */
const BLOCKED_BMI_WRITE_PREFIXES = ["booking/book", "booking/sell"];

/** Should the BMI proxy refuse this endpoint right now? */
export function bmiWriteBlocked(endpoint: string): boolean {
  // "race" is the canonical BMI-only product — if it isn't BMI-vendored the map
  // changed underneath us, so don't block anything on a stale assumption.
  if (!vendorsForProduct("race").includes("bmi")) return false;
  if (!isProductPaused("race")) return false;
  return BLOCKED_BMI_WRITE_PREFIXES.some((p) => endpoint.startsWith(p));
}
