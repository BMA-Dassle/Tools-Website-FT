/**
 * Gifting a deal pack: when it goes out, and what a buyer is allowed to pick.
 *
 * Kept separate from the purchase service because every rule here is a DATE rule,
 * and date rules are where this codebase has been bitten before (the Dec-19
 * 6pm→5pm EST shift that produced `lib/et-time.ts`). Isolated, they're testable
 * without a Square client or a database.
 *
 * THE SEND HOUR IS 8 AM EASTERN, NOT MIDNIGHT. A gift that lands at 00:00 is
 * timestamped the night before in the recipient's inbox and reads as though it
 * arrived a day early — and a birthday text at midnight wakes people up. 8 AM is
 * the first hour someone plausibly wants to hear it.
 *
 * WHY A SCHEDULED GIFT IS STILL MINTED IMMEDIATELY: the money moves at purchase,
 * so the voucher must exist at purchase. Holding the mint until the send date
 * would leave weeks in which a paid pack has no code — unrecoverable if anything
 * upstream changes. Only the DELIVERY waits.
 */

import { normalizeEtDate } from "@/lib/et-time";

/** Eastern hour a scheduled gift is delivered. See the header for why not midnight. */
export const GIFT_SEND_HOUR_ET = 8;

/** How far ahead a buyer may schedule. Covers "bought in August, for Christmas". */
export const GIFT_MAX_MONTHS_AHEAD = 6;

/**
 * A gift must land with usable life left on it.
 *
 * The voucher's clock starts at PURCHASE, not at delivery — so scheduling eats
 * the recipient's window. This floor guarantees they get at least a month.
 */
export const GIFT_MIN_DAYS_BEFORE_EXPIRY = 30;

/** Today's calendar date in Eastern Time, as `YYYY-MM-DD`. */
export function etToday(now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD, which is the one locale that gives us the
  // ISO ordering without hand-assembling parts.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** `YYYY-MM-DD` shifted by whole days, staying in calendar space (no tz drift). */
function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}

/** `YYYY-MM-DD` shifted by whole months, clamping to the end of a short month. */
function addMonths(dateStr: string, months: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  // Aug 31 + 6 months is Feb 31 — clamp to the last real day of the target month.
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

/**
 * The instant a gift chosen for `dateStr` should go out, as a UTC ISO string.
 *
 * Goes through `normalizeEtDate` rather than appending a fixed offset, so a
 * December gift resolves at EST and a July one at EDT. Appending "-04:00" year
 * round is the exact bug `lib/et-time.ts` exists to prevent.
 */
export function giftSendAtUtc(dateStr: string): string {
  const wall = `${dateStr}T${String(GIFT_SEND_HOUR_ET).padStart(2, "0")}:00:00`;
  return new Date(normalizeEtDate(wall)).toISOString();
}

/** The range a date picker should allow, inclusive, both `YYYY-MM-DD`. */
export function giftDateWindow(args: { expiresMonths: number; now?: Date }): {
  min: string;
  max: string;
} {
  const today = etToday(args.now);
  const byPolicy = addMonths(today, GIFT_MAX_MONTHS_AHEAD);
  // The voucher's life is measured from purchase (today), so the expiry ceiling
  // is computed from today too — not from the chosen send date.
  const byExpiry = addDays(addMonths(today, args.expiresMonths), -GIFT_MIN_DAYS_BEFORE_EXPIRY);
  return { min: today, max: byPolicy < byExpiry ? byPolicy : byExpiry };
}

export type GiftDateCheck = { ok: true; sendAt: string | null } | { ok: false; message: string };

/**
 * Validate a buyer-chosen send date and resolve it to a send instant.
 *
 * Returns `sendAt: null` for "today" — that is not a scheduled gift, it goes out
 * with the purchase like any other voucher, and carrying a same-day timestamp
 * through the scheduling machinery would only create a window where a paid gift
 * looks undelivered.
 */
export function checkGiftDate(
  dateStr: string | null | undefined,
  args: { expiresMonths: number; now?: Date },
): GiftDateCheck {
  if (!dateStr) return { ok: true, sendAt: null };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return { ok: false, message: "Please pick a valid delivery date." };
  }
  const { min, max } = giftDateWindow(args);
  if (dateStr < min) {
    return { ok: false, message: "That delivery date has already passed. Please pick another." };
  }
  if (dateStr > max) {
    return {
      ok: false,
      message: `Please pick a date on or before ${formatGiftDate(max)} — the voucher expires ${args.expiresMonths} months from today, and we leave a month to use it.`,
    };
  }
  // Today = send now. Anything later genuinely waits.
  return { ok: true, sendAt: dateStr === min ? null : giftSendAtUtc(dateStr) };
}

/** "August 20, 2026" — for confirmation copy and the buyer's receipt. */
export function formatGiftDate(value: string): string {
  // A bare YYYY-MM-DD is parsed as UTC midnight, which renders as the PREVIOUS
  // day in Eastern. Force it through the ET wall-clock path so the date a buyer
  // picked is the date they are shown.
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(value) ? giftSendAtUtc(value) : value;
  return new Date(iso).toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}
