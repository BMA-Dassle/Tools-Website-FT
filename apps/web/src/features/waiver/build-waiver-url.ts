/**
 * THE canonical waiver link. Every surface that sends a guest to sign — nav,
 * footers, confirmation pages, the group-event emails and SMS — builds its URL
 * here and nowhere else.
 *
 * Why this exists: 21 files hand-rolled their own external kiosk.bmileisure.com /
 * kiosk.sms-timing.com links, each with its own clientKey guess, so the first-party
 * /waiver flow was live and verified but reachable only by typing the URL. Worse,
 * a hand-rolled link can silently point a Naples guest at Fort Myers — Naples has
 * its own Pandora location AND its own waiver template (contentID 5958737 vs FM's
 * 19065376), so a wrong center means a waiver filed where the guest isn't playing.
 *
 * Cutover is per-surface on purpose (owner 2026-07-30): standalone links (nav,
 * footer) carry no reservation and are safe now; the reservation-scoped ones in
 * emails depend on the BMI attach path (probe A3), so they flip separately.
 */
import type { CenterCode } from "~/features/booking/types";

// NOTE: there is deliberately no LEGACY_WAIVER_URLS export here any more. It held
// the external kiosk.bmileisure.com pages, nothing imported it, and leaving a
// ready-made legacy URL in the module that exists to replace them is an invitation
// to a future caller. Anything reachable from here must be a first-party link.

export interface WaiverLinkTarget {
  /** Which venue the guest is signing for. Omit only when it is genuinely
   *  unknown — the page then asks (HeadPinz) or infers from the host (FastTrax). */
  center?: CenterCode | null;
  /** Reservation-scoped link: signatures ATTACH to this BMI project. Both parts
   *  are required together; a half-set pair silently degrades to standalone. */
  reservation?: { locationId: number | string; projectId: string } | null;
}

/**
 * Relative by default so it works on both brand hosts (headpinz.com and
 * fasttraxent.com serve /waiver as a shared top-level route). Pass `absolute`
 * for email and SMS, which have no origin to resolve against.
 */
export function buildWaiverUrl(
  target: WaiverLinkTarget = {},
  opts: { absolute?: boolean; origin?: string } = {},
): string {
  const params = new URLSearchParams();
  if (target.center) params.set("c", target.center);
  const res = target.reservation;
  // Both or neither: a link with loc but no pid attaches to nothing and would
  // look reservation-scoped to the guest.
  if (res && res.locationId && res.projectId) {
    params.set("loc", String(res.locationId));
    params.set("pid", String(res.projectId));
  }
  const qs = params.toString();
  const path = `/waiver${qs ? `?${qs}` : ""}`;
  if (!opts.absolute) return path;
  const origin = (opts.origin || process.env.NEXT_PUBLIC_SITE_URL || "https://fasttraxent.com")
    .trim()
    .replace(/\/+$/, "");
  return `${origin}${path}`;
}
