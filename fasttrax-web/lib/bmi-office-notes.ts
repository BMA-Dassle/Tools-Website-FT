/**
 * BMI Office private-note audit trail for Pandora projects.
 *
 * Once a sales lead is submitted, every outbound SMS / email / Teams card
 * event gets a timestamped line appended to the project's private notes in
 * Pandora (via BMI Office) so planners see a full audit trail natively.
 *
 * STATUS: scaffolded. The BMI Office REST shape for appending a private
 * note to a project is not yet confirmed — the current `/api/bmi-office`
 * proxy is GET-only. Until we capture a HAR of the BMI Office UI adding a
 * note, this module:
 *
 *   1. Accumulates lines in a Redis list `salescard:{projectID}:notes`
 *      (90-day TTL) so no audit data is lost.
 *   2. Exposes `appendPrivateNote` and `getPendingNotes` so a future
 *      backfill cron can flush the buffer once the endpoint is wired.
 *   3. Will be extended to actually POST to BMI Office once the endpoint
 *      path (`PUT /project/{id}` with merged note body, or a dedicated
 *      note route) is confirmed.
 */

import redis from "@/lib/redis";

const NOTES_TTL = 60 * 60 * 24 * 90; // 90 days
const notesKey = (projectId: string | number) => `salescard:${projectId}:notes`;

/** Channel types we audit-log about. Keep in sync with badge formats below. */
export type NoteChannel = "sms" | "email" | "teams" | "action";

export interface AppendNoteParams {
  projectId: string | number;
  channel: NoteChannel;
  /** Short summary ("sent ok", "failed: 400", "acknowledged by Stephanie"). */
  message: string;
  /** Optional actor context — planner name, clicker name, etc. */
  actor?: string;
}

/** Format a line the way it'll appear in Pandora private notes. */
export function formatNoteLine(params: AppendNoteParams): string {
  const ts = new Date().toLocaleString("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "America/New_York",
  });
  const badge = params.channel.toUpperCase();
  const actorPart = params.actor ? ` (${params.actor})` : "";
  return `[${ts} ET] ${badge}${actorPart} — ${params.message}`;
}

/**
 * Non-throwing — a failed audit write must not break the parent flow.
 * Pushes to `salescard:{projectID}:notes` as a Redis list (newest last via
 * RPUSH so a human reading the log sees chronological order).
 */
export async function appendPrivateNote(params: AppendNoteParams): Promise<{ ok: boolean; line?: string; error?: string }> {
  try {
    const line = formatNoteLine(params);
    const key = notesKey(params.projectId);
    await redis.rpush(key, line);
    await redis.expire(key, NOTES_TTL);
    // TODO: once BMI Office note-append endpoint is confirmed, also POST
    // this line to Pandora here (inside the try so failures stay local).
    return { ok: true, line };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "redis error",
    };
  }
}

/** Read back all pending audit lines for a project (for dashboards / backfill). */
export async function getPendingNotes(projectId: string | number): Promise<string[]> {
  try {
    return await redis.lrange(notesKey(projectId), 0, -1);
  } catch {
    return [];
  }
}

/** Dev helper — return the formatted line without writing anywhere. */
export function previewNoteLine(params: AppendNoteParams): string {
  return formatNoteLine(params);
}
