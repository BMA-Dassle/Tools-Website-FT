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
