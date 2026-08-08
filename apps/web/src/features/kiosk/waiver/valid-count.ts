/**
 * "How many of the people registered on this reservation hold a currently-valid
 * waiver" — shared by the kiosk roster (which also needs the NAMES) and the
 * public /api/waiver/context (which must never return them).
 *
 * Two sources, unioned, because neither alone is complete:
 *   - Pandora `waiverExpiry` per registered person. Authoritative for anyone who
 *     signed anywhere, ever (front desk, kiosk, a previous visit). The BMI Office
 *     lookup cannot see waiverExpiry, so this is a per-person read.
 *   - Our Neon kiosk_waiver_joins. Source of record for waivers WE captured — a
 *     guest whose BMI attach failed is still signed, and must still count.
 *
 * Errors resolve to "not valid" on purpose: undercounting shows a guest more work
 * to do, overcounting tells them they are done when they are not.
 */
import redis from "@/lib/redis";
import { personValidCacheKey } from "./cache";

const PANDORA_URL = "https://bma-pandora-api.azurewebsites.net/v2";
const PERSON_VALID_TTL_SECONDS = 120;
export const WAIVER_CHECK_CONCURRENCY = 5;

/** Authoritative "has a valid waiver right now" — same Pandora read as
 *  /api/pandora GET (which accepts 17-digit Office ids). Errors → false
 *  (show fewer people rather than fake a signed waiver). */
export async function waiverValidNow(
  personId: string,
  pandoraLocationId: string,
): Promise<boolean> {
  const cacheKey = personValidCacheKey(personId);
  const cached = await redis.get(cacheKey).catch(() => null);
  if (cached === "1") return true;
  if (cached === "0") return false;
  try {
    const res = await fetch(
      `${PANDORA_URL}/bmi/person/${pandoraLocationId}/${personId}?picture=false&allRelated=false`,
      {
        headers: { Authorization: `Bearer ${process.env.SWAGGER_ADMIN_KEY || ""}` },
        cache: "no-store",
      },
    );
    const data = await res.json();
    const person = res.ok && data.success ? data.data : null;
    if (!person) {
      // NEVER CACHE AN UNREADABLE RECORD. A person with a null birthdate makes
      // this endpoint 500 ("Response Validator Error"), and caching that as "0"
      // pinned them to "no waiver" for the whole TTL — including AFTER the
      // birthday was written and the record started reading cleanly. The answer
      // is still false (fail closed), but it must be re-asked next time.
      console.warn(
        `[waiver-valid] person ${personId} UNREADABLE (HTTP ${res.status}) — ` +
          `not caching; a null birthdate causes this and is repairable`,
      );
      return false;
    }
    const expiry = person.waiverExpiry ? new Date(person.waiverExpiry) : null;
    const valid = expiry ? expiry > new Date() : false;
    redis.setex(cacheKey, PERSON_VALID_TTL_SECONDS, valid ? "1" : "0").catch(() => {});
    return valid;
  } catch (err) {
    // Same rule for a network failure — no cache write, so a blip can't stick.
    console.warn(
      `[waiver-valid] person ${personId} lookup FAILED (${
        err instanceof Error ? err.message : String(err)
      }) — not caching`,
    );
    return false;
  }
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

export interface RegisteredPerson {
  personId: string;
  displayName: string;
}

export interface WaiverJoinRow {
  personId: string;
  displayName: string;
}

/**
 * Union the Pandora-valid subset of `registered` with our Neon joins.
 *
 * Dedupe by personId FIRST, then by display name: kiosk joins carry the Pandora
 * SHORT id while BMI projectPersons may surface the 17-digit Office id for the
 * same human, so the ids legitimately differ for one person. A rare
 * "John S." + "John S." merge is the accepted cost of not double-counting.
 *
 * Pure and synchronous so it can be unit-tested without Pandora or Neon.
 */
export function unionValidWithJoins(
  registered: RegisteredPerson[],
  validFlags: boolean[],
  joins: WaiverJoinRow[],
): RegisteredPerson[] {
  const valid = registered.filter((_, i) => validFlags[i]);
  const seenIds = new Set(valid.map((p) => p.personId));
  const seenNames = new Set(valid.map((p) => p.displayName.toLowerCase()));
  for (const j of joins) {
    if (seenIds.has(j.personId)) continue;
    if (seenNames.has(j.displayName.toLowerCase())) continue;
    seenIds.add(j.personId);
    seenNames.add(j.displayName.toLowerCase());
    valid.push({ personId: j.personId, displayName: j.displayName });
  }
  return valid;
}

/**
 * How many REGISTERED people still need a waiver. Per-person over `registered`,
 * never `registered.length - union.length`: the union also holds WALK-IN joins
 * (people never registered on the reservation), and arithmetic over its length let
 * three walk-ups swallow the "still pending" banner — or drive the count negative —
 * while registered guests remained unsigned. A registered person is pending unless
 * Pandora says valid OR one of our joins matches them (same id-then-name rule the
 * union folds with).
 */
export function pendingRegisteredCount(
  registered: RegisteredPerson[],
  validFlags: boolean[],
  joins: WaiverJoinRow[],
): number {
  const joinIds = new Set(joins.map((j) => j.personId));
  const joinNames = new Set(joins.map((j) => j.displayName.toLowerCase()));
  return registered.filter(
    (p, i) =>
      !validFlags[i] && !joinIds.has(p.personId) && !joinNames.has(p.displayName.toLowerCase()),
  ).length;
}
