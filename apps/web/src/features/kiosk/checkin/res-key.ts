/**
 * Reservation KEY for kiosk check-in — pure helpers, no I/O.
 *
 * The check-in rail was built billId-first: proof/ref tokens, the events table,
 * the per-reservation lock and every summary all key on the BMI bill. But a
 * standalone HP bowling booking (the hp/book wizard → /api/bowling/v2/reserve)
 * NEVER gets a `bmi_bill_id` — only unified-cart anchor rows carry one — so a
 * bowling-only guest was invisible to the kiosk on every find path (scan,
 * phone, browse). Rather than rework each signature, the key stays ONE opaque
 * string with two shapes:
 *
 *   - bare digits            → a BMI billId (unchanged, everything existing)
 *   - "bowl:{neonId}"        → a bowling-only reservation, keyed on its Neon
 *                              bowling_reservations.id
 *
 * `kiosk_checkin_events.bill_id` is TEXT, the Redis tokens carry opaque JSON,
 * and `completeCheckin` already gates every BMI write on `hasRacing` /
 * a parseable office project id — so the second shape rides the existing rail
 * without touching the racing pipeline.
 *
 * OWNER RULE (2026-08-16): bowling check-in exists ONLY at HeadPinz Fort Myers
 * and HeadPinz Naples — never FastTrax. FT duckpin rows (center LAB52GY480CJF)
 * are excluded by `isKioskBowlingRow`, which is the single predicate every
 * lookup path (scan / phone / browse) and the itinerary eligibility flag use.
 */
import {
  HEADPINZ_FM_CENTER_CODE,
  HEADPINZ_NAPLES_CENTER_CODE,
} from "@/lib/qamf-centers";

const BOWL_PREFIX = "bowl:";

/** Is this check-in key a bowling-only reservation handle? */
export function isBowlKey(key: string): boolean {
  return key.startsWith(BOWL_PREFIX);
}

/** Key for a bowling-only reservation (Neon bowling_reservations.id). */
export function makeBowlKey(neonId: number): string {
  return `${BOWL_PREFIX}${neonId}`;
}

/** Neon reservation id from a bowl key, or null for any other shape. */
export function bowlIdFromKey(key: string): number | null {
  if (!isBowlKey(key)) return null;
  const id = Number(key.slice(BOWL_PREFIX.length));
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** The two centers where bowling check-in is offered. FT duckpin is NOT here —
 *  that exclusion is the owner's "bowling check-in never at FastTrax" rule. */
const HP_BOWLING_CENTER_CODES: ReadonlySet<string> = new Set([
  HEADPINZ_FM_CENTER_CODE,
  HEADPINZ_NAPLES_CENTER_CODE,
]);

export function isHpBowlingCenterCode(centerCode: string | null | undefined): boolean {
  return !!centerCode && HP_BOWLING_CENTER_CODES.has(centerCode);
}

/** The row subset this module judges — keeps callers' row types out of here. */
export interface BowlingRowLike {
  productKind?: string;
  centerCode?: string | null;
}

/**
 * Is this Neon money-group row a bowling leg the KIOSK may check in?
 * open/kbf only (race and attraction rows are never bowling), and only at the
 * two HeadPinz centers — a FastTrax duckpin row never qualifies.
 */
export function isKioskBowlingRow(row: BowlingRowLike): boolean {
  return (
    (row.productKind === "open" || row.productKind === "kbf") &&
    isHpBowlingCenterCode(row.centerCode)
  );
}
