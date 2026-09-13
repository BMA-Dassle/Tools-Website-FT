/**
 * TOUCH COUNTING — the prototype's rule, made executable (crm-shared.js:418):
 *
 *   "A touch counts once per lead per channel per day. Auto-replies and
 *    delivery receipts never count."
 *
 * Three consequences, each pinned by a test:
 *   • the DAY is an ET calendar day (R10) — a 9 PM ET call is still "today"
 *     even though the Vercel function's UTC clock has already rolled over;
 *   • the CHANNEL is the activity kind (call / sms / email / reachout), so a
 *     rep who calls twice and texts once has made two touches, not three;
 *   • only OUTBOUND counts. An inbound text is the guest touching us, and a
 *     delivery receipt is not a person at all — neither is ever an activity
 *     row with `direction: "out"` (C1 writes receipts onto
 *     `crm_sms_messages.delivery_status`, never as an activity), so the rule
 *     falls out of the direction filter rather than needing a deny-list.
 *
 * Pure except for `countTouchesToday`, which reads the day's rows back.
 */

import { isDbConfigured, sql } from "@ft/db";
import { ET, easternRangeToUtc, todayEasternYmd } from "../../core/dates";
import { TOUCH_CHANNELS, type TouchChannel, type TouchCounts } from "../contracts";
import { ensureActivitiesSchema } from "../data/activities-db";

const CHANNELS = new Set<string>(TOUCH_CHANNELS);

const ET_YMD = new Intl.DateTimeFormat("en-CA", {
  timeZone: ET,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** The ET calendar day an instant falls on, as YYYY-MM-DD. */
export function touchDayEt(occurredAt: string | Date): string {
  const d = occurredAt instanceof Date ? occurredAt : new Date(occurredAt);
  return ET_YMD.format(d);
}

export interface TouchLike {
  kind: string;
  direction: string | null | undefined;
  occurredAt: string | Date;
}

/** The channel this activity counts against, or null when it counts against none. */
export function touchChannelOf(a: TouchLike): TouchChannel | null {
  if (a.direction !== "out") return null;
  return CHANNELS.has(a.kind) ? (a.kind as TouchChannel) : null;
}

/** `<channel>|<ET day>` — the identity a touch is deduped on, for ONE lead. */
export function touchKey(a: TouchLike): string | null {
  const channel = touchChannelOf(a);
  return channel ? `${channel}|${touchDayEt(a.occurredAt)}` : null;
}

export function emptyTouchCounts(): TouchCounts {
  return { call: 0, sms: 0, email: 0, reachout: 0 };
}

/**
 * Distinct touches in a set of one lead's activities: at most one per channel
 * per ET day. Feed it a whole history and it returns the lifetime count; feed
 * it today's rows and it returns today's.
 */
export function countTouches(activities: readonly TouchLike[]): TouchCounts {
  const seen = new Set<string>();
  const out = emptyTouchCounts();
  for (const a of activities) {
    const channel = touchChannelOf(a);
    if (!channel) continue;
    const key = `${channel}|${touchDayEt(a.occurredAt)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out[channel] += 1;
  }
  return out;
}

/**
 * Would THIS activity be a new touch, given what is already on the lead?
 * The answer the POST route hands back as `countedAsTouch` — the activity is
 * always recorded either way; only the SCORE is deduped.
 */
export function isNewTouch(existing: readonly TouchLike[], candidate: TouchLike): boolean {
  const key = touchKey(candidate);
  if (!key) return false;
  return !existing.some((a) => touchKey(a) === key);
}

/** One lead's touches on an ET calendar day, read back from Neon. */
export async function countTouchesToday(
  leadId: string,
  now: Date = new Date(),
): Promise<TouchCounts> {
  if (!isDbConfigured()) return emptyTouchCounts();
  await ensureActivitiesSchema();
  const ymd = todayEasternYmd(now);
  const { startUtc, endUtc } = easternRangeToUtc(ymd, ymd);
  const q = sql();
  const rows = (await q.query(
    `SELECT DISTINCT kind
       FROM crm_activities
      WHERE lead_id = $1::bigint
        AND direction = 'out'
        AND kind = ANY($2::text[])
        AND occurred_at >= $3::timestamptz
        AND occurred_at < $4::timestamptz`,
    [leadId, [...TOUCH_CHANNELS], startUtc, endUtc],
  )) as { kind: string }[];
  const out = emptyTouchCounts();
  for (const r of rows) {
    if (CHANNELS.has(r.kind)) out[r.kind as TouchChannel] = 1;
  }
  return out;
}
