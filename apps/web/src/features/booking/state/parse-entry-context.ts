/**
 * Parse the entry URL's search params into an EntryContext.
 *
 * The activity page's `searchParams` prop arrives as
 * `{ [key]: string | string[] | undefined }` because Next.js allows
 * repeated keys. This parser normalizes that, trims values, ignores
 * blanks, and emits a typed EntryContext.
 *
 * Supported params (PR-B2):
 *   ?member=ID                          → memberId
 *   ?promo=CODE                         → promo.code (source = "url")
 *   ?firstName=&lastName=&email=&phone= → prefilledContact fields
 *   ?referrer=NAME / ?ref / ?utm_source → referrer
 *   ?location=naples|fort-myers|...     → center (CenterCode)
 *   ?experience=world-cup               → worldCup (match-picker bowling mode)
 *
 * Unknown params are silently ignored. The parser is intentionally
 * tolerant — marketing links should never 500 a wizard.
 *
 * Cookie-based seeding (e.g. auth) is a separate parser added when a
 * real cookie source exists. The page combines the two before passing
 * the merged context to BookingFlow.
 */
import { normalizeLocationSlug } from "@/lib/attractions-data";
import type { ContactInfo, CenterCode } from "../types";
import { EMPTY_ENTRY_CONTEXT, type EntryContext } from "./entry-context";

/** Map a `?location=` slug to a v2 CenterCode (FT / HP Fort Myers → fort-myers, Naples → naples). */
function locationToCenter(raw: string | undefined): CenterCode | null {
  const key = normalizeLocationSlug(raw);
  if (!key) return null;
  return key === "naples" ? "naples" : "fort-myers";
}

type RawValue = string | string[] | undefined;
type RawSearchParams = Readonly<Record<string, RawValue>>;

/** Take the first non-empty trimmed value, or undefined. */
function first(v: RawValue): string | undefined {
  if (v === undefined) return undefined;
  if (Array.isArray(v)) {
    for (const item of v) {
      const t = item?.trim();
      if (t) return t;
    }
    return undefined;
  }
  const trimmed = v.trim();
  return trimmed || undefined;
}

export function parseEntryContextFromSearchParams(sp: RawSearchParams): EntryContext {
  // Build incrementally — only attach fields that were actually present.
  const out: Partial<EntryContext> = {};

  const memberId = first(sp.member);
  if (memberId) out.memberId = memberId;

  const promoCode = first(sp.promo);
  if (promoCode) out.promo = { code: promoCode, source: "url" };

  const referrer = first(sp.referrer) ?? first(sp.ref) ?? first(sp.utm_source);
  if (referrer) out.referrer = referrer;

  const center = locationToCenter(first(sp.location));
  if (center) out.center = center;

  // World Cup VIP Bowling entry mode. Only the exact value counts — any other
  // ?experience= value is ignored (marketing links must never 500 a wizard).
  if (first(sp.experience) === "world-cup") out.worldCup = true;

  // Single-time-pick bowling flow preview opt-in (dark-flag testing on
  // Vercel previews). Only the exact value counts.
  if (first(sp.bowlingV3) === "1") out.bowlingV3 = true;

  // FastTrax QAMF duckpin preview opt-in (dark-flag testing). Exact value only.
  if (first(sp.ftDuckpin) === "1") out.ftDuckpin = true;

  // "Play Now" per-lane QR entry (`?playNow=1&lane=N`). Exact value for the flag;
  // the lane must be a positive integer (validated against real center lanes
  // downstream). parseInt on a small lane number is safe (never a BMI id).
  if (first(sp.playNow) === "1") out.playNow = true;
  const laneRaw = first(sp.lane);
  if (laneRaw) {
    const lane = Number.parseInt(laneRaw, 10);
    if (Number.isInteger(lane) && lane > 0) out.pinnedLane = lane;
  }

  const firstName = first(sp.firstName);
  const lastName = first(sp.lastName);
  const email = first(sp.email);
  const phone = first(sp.phone);
  if (firstName || lastName || email || phone) {
    const c: Partial<ContactInfo> = {};
    if (firstName) c.firstName = firstName;
    if (lastName) c.lastName = lastName;
    if (email) c.email = email;
    if (phone) c.phone = phone;
    out.prefilledContact = c;
  }

  // Don't return a fresh-but-empty object when nothing matched —
  // share the frozen sentinel so reference equality stays cheap for
  // memoized session reducers.
  return Object.keys(out).length === 0 ? EMPTY_ENTRY_CONTEXT : (out as EntryContext);
}
