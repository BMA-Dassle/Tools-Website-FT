import "server-only";

/**
 * THE PEOPLE WE OURSELVES SCANNED INTO A SESSION — one key, one reader, one
 * writer rule, so every surface that shows "checked in" can floor its number
 * with what we already know instead of waiting to be told.
 *
 * Every green scan at the check-in desk is OUR OWN WRITE. We do not need
 * Pandora to tell us it happened; we need Pandora only for what we could not
 * have seen — the roster changing, or somebody checked in directly in BMI. So
 * the desk records what it scanned, here, BEFORE it answers the scanner, and
 * anything counting that session floors the upstream's answer with the size of
 * this set (`applyLocalFloor` in ./roster-count).
 *
 * WHY THIS IS A MODULE AND NOT A CONST IN THE ROUTE. It began life inside
 * app/api/admin/checkin/route.ts, where it fixed the desk board's count and
 * nothing else. But the TV walls count the same heat from a second pipeline
 * (features/signage/service/checkin-progress), which had no access to it and
 * so still waited on a live Pandora read behind a memo behind a 15s poll —
 * up to a minute and a half after a racer had scanned. Two readers of one key
 * is only safe if they agree exactly what the key is and what its members mean,
 * which is what this file is for.
 *
 * A SET, NOT A COUNTER, so a racer who scans twice — or whose badge is read
 * twice by a scanner that fires on both edges — is counted once.
 *
 * MEMBERS ARE personId AS A STRING, never a number: BMI personIds exceed
 * Number.MAX_SAFE_INTEGER and this repo's classic bug is rounding one.
 */

import redis from "@/lib/redis";

/**
 * Long enough to outlive any called heat, so the floor is still there for the
 * whole time a heat can be at the desk, and short enough that yesterday's set
 * cannot floor a session id BMI reissues.
 */
export const SCAN_LEDGER_TTL_SEC = 45 * 60;

export function scanLedgerKey(locationId: string, sessionId: string | number): string {
  return `checkin:roster-seen:${locationId}:${sessionId}`;
}

/**
 * Record that WE checked this person into this session.
 *
 * NEVER THROWS. A ledger write must not be able to fail a check-in that has
 * already happened upstream — the worst case here is that the count degrades to
 * Pandora's own answer, which is where it started.
 */
export async function creditScan(
  locationId: string,
  sessionId: string | number,
  personId: string,
): Promise<void> {
  if (!locationId || !sessionId || !personId) return;
  try {
    const key = scanLedgerKey(locationId, sessionId);
    await redis.sadd(key, personId);
    await redis.expire(key, SCAN_LEDGER_TTL_SEC);
  } catch {
    /* see the NEVER THROWS note above */
  }
}

/**
 * How many people we have scanned into this session.
 *
 * Zero on any failure, which is the identity for a floor: an unreadable ledger
 * leaves the upstream's answer exactly as it was rather than lowering it.
 */
export async function scanCount(locationId: string, sessionId: string | number): Promise<number> {
  if (!locationId || !sessionId) return 0;
  try {
    return (await redis.scard(scanLedgerKey(locationId, sessionId))) ?? 0;
  } catch {
    return 0;
  }
}
