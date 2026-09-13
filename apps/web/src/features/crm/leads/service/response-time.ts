/**
 * Response time — how long an assignee takes to make the FIRST outbound
 * touch on a lead (brief §4 B3: "`first_touch_at` set by the first outbound
 * call/sms/email activity by the assignee; hook exposed for B4/C1/C2/C3").
 *
 * The pure half (`responseBadge`, `firstTouchMinutes`, `isOutboundTouch`,
 * the thresholds) lives in `../response-badge.ts` so the client can draw the
 * strip; it is re-exported here. This file adds the Neon hook:
 * `recordFirstTouch` sets `first_touch_at` ONCE, only when the touch came from
 * the current assignee, in a single guarded UPDATE so two simultaneous touches
 * cannot both win. `noteOutboundTouch` is the convenience the channel PRs call
 * with the activity they just wrote.
 */

import { isDbConfigured, sql } from "@ft/db";
import { ensureLeadsSchema } from "../data/leads-db";
import { isOutboundTouch } from "../response-badge";

export {
  RESPONSE_CRIT_MINUTES,
  RESPONSE_WARN_MINUTES,
  TOUCH_KINDS,
  firstTouchMinutes,
  isOutboundTouch,
  responseBadge,
  type ResponseBadge,
} from "../response-badge";

export interface RecordFirstTouchInput {
  leadId: string;
  /** The rep who made the touch; only the CURRENT assignee's touch counts. */
  repId: string;
  at?: Date;
}

export interface RecordFirstTouchResult {
  /** True when THIS call set `first_touch_at`. */
  recorded: boolean;
  firstTouchAt: string | null;
}

/**
 * `UPDATE … SET first_touch_at = $at WHERE first_touch_at IS NULL AND
 * assigned_rep_id = $rep` — one statement, so the first touch wins and a later
 * one is a no-op. Returns the stored value either way.
 */
export async function recordFirstTouch(
  input: RecordFirstTouchInput,
): Promise<RecordFirstTouchResult> {
  if (!isDbConfigured()) return { recorded: false, firstTouchAt: null };
  await ensureLeadsSchema();
  const q = sql();
  const at = (input.at ?? new Date()).toISOString();
  const updated = (await q`
    UPDATE crm_leads
       SET first_touch_at = ${at}::timestamptz, updated_at = NOW()
     WHERE id = ${input.leadId}::bigint
       AND first_touch_at IS NULL
       AND assigned_rep_id = ${input.repId}::bigint
     RETURNING to_char(first_touch_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS first_touch_at
  `) as { first_touch_at: string }[];
  if (updated[0]) return { recorded: true, firstTouchAt: updated[0].first_touch_at };
  const current = (await q`
    SELECT to_char(first_touch_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS first_touch_at
      FROM crm_leads WHERE id = ${input.leadId}::bigint
  `) as { first_touch_at: string | null }[];
  return { recorded: false, firstTouchAt: current[0]?.first_touch_at ?? null };
}

/**
 * The hook for the channel PRs: hand over the activity you just recorded and
 * the lead's assignee; an outbound call / text / email by that rep becomes the
 * first touch. Anything else (inbound, a note, another rep) is ignored.
 */
export async function noteOutboundTouch(
  activity: {
    kind: string;
    direction: string | null | undefined;
    repId: string | null;
    occurredAt?: Date | string | null;
  },
  lead: { id: string; rep: string | null },
  deps: { record: typeof recordFirstTouch } = { record: recordFirstTouch },
): Promise<RecordFirstTouchResult> {
  if (!isOutboundTouch(activity) || !activity.repId || !lead.rep || activity.repId !== lead.rep) {
    return { recorded: false, firstTouchAt: null };
  }
  const at = activity.occurredAt ? new Date(activity.occurredAt) : new Date();
  return deps.record({ leadId: lead.id, repId: activity.repId, at });
}
