/**
 * The venue timing server's broadcast records, read for RACE LIFECYCLE.
 *
 * kart-timing-bridge (Railway) holds a socket to the venue's own timing server
 * and POSTs every broadcast message to our webhook. The messages that matter
 * here are ARRAYS of race records — the server re-sends the day's race list on
 * state changes — containing `RaceFinish` records (verified against three
 * weeks of real traffic in `kart:events:queue`, survey 2026-08-12):
 *
 *   { $type: "RaceFinish", RaceId: 57886016, Name: "67 - Mega Starter",
 *     ResourceId: -1, ResourceName: "Mega Track", State: "Finished",
 *     ActualStart: "2026-08-11T22:52:44.3747", ActualEnd: "2026-08-11T23:05:35.4579",
 *     ScheduledStart/End, DurationTime, PendingFinishDurationTime, RecordVersion }
 *
 * THE FACTS THIS MODULE ENCODES, all measured from that survey:
 *  - `RaceId` is the SAME id space as Pandora session ids — RaceId 57886013 was
 *    heat 64, exactly the sessionId our briefing board recorded that night. It
 *    is ALWAYS handled as a string.
 *  - Dates are VENUE-LOCAL Eastern wall-clock with no timezone suffix — the
 *    same trap as BMI Office dates, so the same fix: normalizeEtDate.
 *  - A race can be `State: "Finished"` with NO ActualEnd yet (the pending-finish
 *    window; heat 65's unstamped push arrived 42s BEFORE Pandora's stamp).
 *    That unstamped record is the FASTEST end signal that exists.
 *  - Arrays repeat the WHOLE day's races on every push, and reconnect catch-up
 *    dumps replay hours-old ones — so acting on a finish requires BOTH a
 *    per-race claim (caller's job) and the freshness gate below.
 *
 * PURE — the webhook-side actions live in briefing/race-finish.server.ts.
 */
import { normalizeEtDate } from "@/lib/et-time";
import type { TrackKey } from "~/features/signage/track";

/** Venue ResourceId → our track key. Mega is resource -1 (barrier out, one
 *  circuit) — same ids the timing cloud socket uses. */
const VENUE_RESOURCE_TRACKS: Record<string, TrackKey> = {
  "11208654": "blue",
  "11208660": "red",
  "-1": "mega",
};

export interface VenueRaceFinish {
  /** String, always — same id space as Pandora sessionIds (house rule: never
   *  a Number round-trip, even while today's ids fit). */
  raceId: string;
  heatName: string;
  /** From "67 - Mega Starter" → 67; null for names that do not lead with a
   *  number (group events) — callers must not guess. */
  heatNumber: number | null;
  track: TrackKey | null;
  state: string;
  actualStartMs: number | null;
  actualEndMs: number | null;
}

/** Venue wall-clock ("2026-08-11T23:05:35.4579", ET, no zone) → epoch ms. */
export function parseVenueLocalMs(value: unknown): number | null {
  if (typeof value !== "string" || !value) return null;
  const ms = Date.parse(normalizeEtDate(value));
  return Number.isFinite(ms) ? ms : null;
}

/** "67 - Mega Starter" → 67. Distinct from results-frame's parseHeatNumber:
 *  the cloud socket prefixes "[HEAT]", the venue broadcast does not. */
export function parseVenueHeatNumber(name: string): number | null {
  const m = /^\s*(\d+)\s*-/.exec(name);
  return m ? Number(m[1]) : null;
}

/** Every RaceFinish record in a webhook message (array or single object).
 *  Anything malformed is skipped, never thrown — this runs on the webhook's
 *  hot path where an exotic message must cost nothing. */
export function extractRaceFinishes(message: unknown): VenueRaceFinish[] {
  const records = Array.isArray(message) ? message : [message];
  const out: VenueRaceFinish[] = [];
  for (const rec of records) {
    if (!rec || typeof rec !== "object") continue;
    const r = rec as Record<string, unknown>;
    if (r["$type"] !== "RaceFinish") continue;
    if (r.RaceId === undefined || r.RaceId === null) continue;
    const heatName = typeof r.Name === "string" ? r.Name : "";
    out.push({
      raceId: String(r.RaceId),
      heatName,
      heatNumber: parseVenueHeatNumber(heatName),
      track: VENUE_RESOURCE_TRACKS[String(r.ResourceId)] ?? null,
      state: typeof r.State === "string" ? r.State : "",
      actualStartMs: parseVenueLocalMs(r.ActualStart),
      actualEndMs: parseVenueLocalMs(r.ActualEnd),
    });
  }
  return out;
}

/** How stale a stamped end may be and still trigger the finish actions. Wide
 *  enough to absorb the pipe's ordinary delivery lag, narrow enough that a
 *  reconnect catch-up dump of the afternoon's races stays inert. */
export const FINISH_FRESH_MS = 10 * 60_000;

/** An UNSTAMPED Finished race (pending-finish window) is trusted only while a
 *  race that recently started could plausibly still be wrapping up. */
const UNSTAMPED_MAX_RACE_AGE_MS = 30 * 60_000;

/**
 * Should this finish record fire the end-of-race actions right now?
 *
 * Stamped: the end must be recent (small negative slack for clock skew between
 * the venue server and us). Unstamped ("Finished" during the pending window —
 * the fastest signal): trusted only when its own start is recent, because a
 * catch-up dump could in principle replay an old unstamped record.
 */
export function isActionableFinish(f: VenueRaceFinish, nowMs: number): boolean {
  if (f.state !== "Finished") return false;
  if (f.actualEndMs !== null) {
    const sinceEnd = nowMs - f.actualEndMs;
    return sinceEnd >= -120_000 && sinceEnd <= FINISH_FRESH_MS;
  }
  if (f.actualStartMs !== null) {
    const sinceStart = nowMs - f.actualStartMs;
    return sinceStart > 0 && sinceStart <= UNSTAMPED_MAX_RACE_AGE_MS;
  }
  return false;
}
