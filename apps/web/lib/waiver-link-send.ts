/**
 * THE send-path waiver link. Every email, SMS, contract and confirmation surface
 * gets its waiver URL from here — nothing hand-rolls one.
 *
 * ── What this replaced, and why it is not just tidier ─────────────────────────
 * Nine call sites each built the same string by hand:
 *
 *   const project = await fetchProject(quote.center_code, quote.bmi_reservation_id)
 *   if (project?.projectReference)
 *     url = `https://kiosk.sms-timing.com/${ck}/subscribe/event?id=${projectReference}`
 *
 * That shape has three problems beyond duplication:
 *
 *   1. It is an EXTERNAL BMI kiosk page, not our unified /waiver flow, so none of
 *      the first-party work (roster, guardian flow, sign log, Spanish, in-house
 *      template) reached a single guest who arrived by email.
 *   2. It needed a BMI Office ROUND TRIP per send, purely to read
 *      `projectReference`. When that call failed the sender's fallback was to
 *      SKIP THE EMAIL (`no waiver URL for quote=…, skipping`). A waiver reminder
 *      was contingent on an upstream API being up.
 *   3. Its fallbacks were hardcoded to `headpinzftmyers`, so a Naples guest was
 *      sent to the Fort Myers tenant — where their waiver is not valid.
 *
 * A short link needs only `center_code` and `bmi_reservation_id`, and both are
 * ALREADY COLUMNS on the quote row. So the BMI fetch disappears completely: no
 * network dependency, no skipped sends, and `projectReference` — which is NOT a
 * `/waiver` pid — is out of the waiver path entirely.
 *
 * ── organizer vs register: which link goes where ──────────────────────────────
 * Owner rule (2026-07-30): "for the main person who gets the waiver email, they
 * should be able to remove people. Others with share link should not."
 *
 *   ORGANIZER -> mail and SMS addressed TO THE BOOKER (`quote.guest_email`), and
 *                the booker's own contract page. Roster + remove.
 *   REGISTER  -> anything FORWARDABLE: the contract page's Copy/Text buttons, the
 *                waiver page's own Share sheet. Sign only.
 *
 * Consequence for COPY, and it is load-bearing rather than cosmetic: the old
 * emails said "please forward this link to everyone in your group". Forwarding an
 * ORGANIZER link hands every guest the ability to delete people from the booking, so
 * that copy had to change with the link. Organizer emails now say the link is
 * theirs and point them at the in-page Share button, which hands out a REGISTER
 * code. A capability is only as narrow as the instructions shipped next to it.
 *
 * ── Degradation ──────────────────────────────────────────────────────────────
 * `mintWaiverLinkOrLongUrl` never throws: a mint failure yields the LONG absolute
 * /waiver URL, which is sign-only. So the worst case is a booker who lost the
 * remove button — never a dead link, and never an unauthenticated mutation
 * surface. Callers get a usable URL or null, exactly the `string | null` contract
 * they already had.
 */
import {
  mintWaiverLinkOrLongUrl,
  type WaiverLinkCapability,
  type WaiverLinkForSend,
} from "@/lib/waiver-short-link";
import { buildWaiverUrl } from "~/features/waiver/build-waiver-url";
import { waiverVenueForCenterCode } from "~/features/waiver/waiver-venue";
import type { CenterCode } from "~/features/booking/types";

/**
 * The columns a waiver link actually needs. Structural rather than
 * `GroupFunctionQuote` so this is callable from a cron row, a partial select or a
 * test without inventing forty unrelated fields.
 */
export interface WaiverLinkQuote {
  id: number;
  center_code: string;
  bmi_reservation_id: string;
  /**
   * Brand origin already resolved and STORED on the quote (headpinz.com vs
   * fasttraxent.com). Using the stored value rather than a request origin is the
   * point: a cron has no request, and letting a brand-less origin decide would
   * put a HeadPinz guest on the FastTrax host.
   */
  base_url?: string | null;
}

/**
 * Warm-lambda memo, keyed by quote AND capability — the two capabilities are
 * different links and must never share a cache slot.
 *
 * ONLY SUCCESSES ARE CACHED. Minting is idempotent in Neon, so re-attempting
 * costs one upsert, whereas caching a DEGRADED result would let a single
 * transient Neon blip strip the remove button from every remaining email in the
 * batch — silently, for the life of the instance. Retry is cheap; a poisoned
 * cache is not. (The BMI-era cache stored nulls because its failure was a missing
 * external page, not a lost capability.)
 */
const SEND_CACHE = new Map<string, WaiverLinkForSend>();

/** Test seam — forget memoized links. */
export function _resetWaiverLinkSendCache(): void {
  SEND_CACHE.clear();
}

/**
 * Hosts of the waiver pages we are migrating AWAY from. A supplied URL on one of
 * these is treated as ABSENT rather than passed through, so a caller still
 * holding a legacy link cannot ship one — which is what makes "no email carries a
 * legacy waiver link" a property of this module instead of a promise about call
 * sites.
 */
const LEGACY_WAIVER_HOSTS = new Set(["kiosk.sms-timing.com", "kiosk.bmileisure.com"]);

/** Base for parsing a possibly-relative URL. Never appears in output. */
const PARSE_BASE = "https://waiver.invalid";

function parseMaybeRelative(raw: string): URL | null {
  try {
    return new URL(raw, PARSE_BASE);
  } catch {
    return null;
  }
}

/**
 * Mint the ONE link for this quote and capability.
 *
 * Returns null only when there is nothing to point at: an unrecognised
 * `center_code` or a missing reservation id. Both mean we cannot say WHICH venue
 * the waiver files against, and a wrong venue is worse than no link — the caller
 * falls back to the center-less picker, which asks the guest.
 */
export async function waiverLinkForQuote(
  quote: WaiverLinkQuote,
  capability: WaiverLinkCapability,
): Promise<WaiverLinkForSend | null> {
  const projectId = String(quote.bmi_reservation_id ?? "").trim();
  const venue = waiverVenueForCenterCode(quote.center_code);
  if (!projectId || !venue) {
    console.warn(
      `[waiver-link-send] no waiver link for quote=${quote.id}: center_code=${String(
        quote.center_code,
      )} reservation=${projectId || "none"} — refusing to guess a venue`,
    );
    return null;
  }

  const key = `${quote.id}:${capability}`;
  const cached = SEND_CACHE.get(key);
  if (cached) return cached;

  const link = await mintWaiverLinkOrLongUrl({
    center: venue.center,
    reservation: { locationId: venue.locationId, projectId },
    capability,
    origin: quote.base_url || undefined,
  });
  // Cache the good case only — see SEND_CACHE.
  if (link.short) SEND_CACHE.set(key, link);
  return link;
}

/**
 * String form, matching the `waiverUrl: string | null` shape every sender already
 * passes around. Use `waiverLinkForQuote` when you need to know whether the link
 * actually carries the capability you asked for (`link.capability`).
 */
export async function waiverUrlForQuote(
  quote: WaiverLinkQuote,
  capability: WaiverLinkCapability,
): Promise<string | null> {
  return (await waiverLinkForQuote(quote, capability))?.url ?? null;
}

/**
 * Both links for a reservation, WITHOUT needing a quote row — for callers that
 * hold only a centerCode + projectId (the dispatch cron works off BMI items, not
 * quotes).
 *
 * Returns `organizerUrl` / `signUrl` — the words the owner uses and the emails
 * print. Those now match the stored capability values (`organizer` / `register`)
 * rather than shadowing an `admin` enum with an "Organizer" label, which is exactly
 * how a future caller puts the wrong link in the wrong slot: someone grepping for
 * "organizer" has to find the mint call.
 *
 * Unmemoized: it has no stable quote id to key on, and minting is idempotent, so a
 * repeat call returns the same code from Neon.
 */
export async function waiverLinksForReservation(params: {
  centerCode: string;
  projectId: string;
  origin?: string;
}): Promise<{ organizerUrl: string; signUrl: string } | null> {
  const projectId = String(params.projectId ?? "").trim();
  const venue = waiverVenueForCenterCode(params.centerCode);
  if (!projectId || !venue) return null;
  const mint = (capability: WaiverLinkCapability) =>
    mintWaiverLinkOrLongUrl({
      center: venue.center,
      reservation: { locationId: venue.locationId, projectId },
      capability,
      origin: params.origin,
    });
  const [organizer, sign] = await Promise.all([mint("organizer"), mint("register")]);
  return { organizerUrl: organizer.url, signUrl: sign.url };
}

/**
 * Upgrade a waiver URL that some CALLER built into a short capability link.
 *
 * The racing senders (booking-confirmation, race-day-instructions,
 * race-day-emails) receive `waiverUrl` as a string from the page or a stored
 * record rather than deriving it from a quote row, so they need a URL-in/URL-out
 * form. Always returns something usable:
 *
 *   canonical /waiver WITH loc+pid -> minted short link (long URL if minting fails)
 *   canonical /waiver, no loc+pid   -> the same standalone link, made absolute.
 *                                      Nothing to attach to, so no capability to
 *                                      grant and nothing to shorten.
 *   legacy kiosk host / empty       -> canonical absolute /waiver for `center`
 *   any other absolute URL          -> returned UNCHANGED. Not ours to rewrite.
 *
 * An absolute input keeps ITS OWN origin, because the caller that built it is the
 * one that knew the brand; `opts.origin` only fills in for a relative input.
 */
export async function waiverLinkForSuppliedUrl(
  supplied: string | null | undefined,
  capability: WaiverLinkCapability,
  opts?: { center?: CenterCode | null; origin?: string },
): Promise<string> {
  const fallbackCenter = opts?.center ?? null;
  const canonical = () =>
    buildWaiverUrl({ center: fallbackCenter }, { absolute: true, origin: opts?.origin });

  const raw = String(supplied ?? "").trim();
  if (!raw) return canonical();

  const isAbsolute = /^https?:\/\//i.test(raw);
  const parsed = parseMaybeRelative(raw);
  if (!parsed) return canonical();
  if (isAbsolute && LEGACY_WAIVER_HOSTS.has(parsed.hostname.toLowerCase())) return canonical();

  const isWaiverPath = parsed.pathname === "/waiver" || parsed.pathname.startsWith("/waiver/");
  if (!isWaiverPath) {
    // Some other link entirely. Passing an absolute one through unchanged is the
    // conservative choice; a relative one we cannot make absolute safely.
    return isAbsolute ? raw : canonical();
  }

  const origin = isAbsolute ? parsed.origin : opts?.origin;
  const center = parsed.searchParams.get("c");
  const locationId = parsed.searchParams.get("loc") ?? "";
  const projectId = parsed.searchParams.get("pid") ?? "";

  // Both or neither — the rule buildWaiverUrl and the mint both enforce. A
  // standalone link has no reservation, so there is no capability to encode.
  if (!locationId || !projectId) {
    return buildWaiverUrl(
      { center: (center as CenterCode | null) ?? fallbackCenter },
      {
        absolute: true,
        origin,
      },
    );
  }

  const link = await mintWaiverLinkOrLongUrl({
    // Garbage `c` is whitelisted away to null inside the mint, so a hand-edited
    // link cannot file a waiver at a center that does not exist.
    center: center as CenterCode | null,
    reservation: { locationId, projectId },
    capability,
    origin,
  });
  return link.url;
}
