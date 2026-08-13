/**
 * The briefing log, folded into one row per group. PURE — events in, records out.
 *
 * This is the half of the insurance record that is NOT stored (see events-db.ts):
 * how long a group was in the room, and whether the safety film actually ran to its
 * end. Both are arithmetic over the event log, and arithmetic is not a thing to
 * keep a second copy of — a stored duration can disagree with the events it came
 * from, and then neither can be trusted.
 *
 * TIME IN THE ROOM RUNS FROM THE SEND, not from the film. The group walks in when
 * staff send them; the film starts once they are seated. The insurance question is
 * about the room, so the clock starts at the door.
 *
 * THE END OF AN OCCUPANCY, in order of authority:
 *
 *   1. an explicit `ended` event — staff cleared the room, or the next group
 *      displaced this one. Recorded, and it wins.
 *   2. THE FILM'S OWN LENGTH. The common case has no explicit end at all: the film
 *      finishes, the helmet board runs its 30 seconds, the group walks to the grid
 *      and nobody presses anything. That end is not a guess — it is the length of
 *      the film we know we played plus the phase the TV is known to hold, i.e. the
 *      same arithmetic briefingTimelineAt uses to drive the wall. Marked
 *      `film-complete` so a reader can tell it from a stamped one.
 *   3. still in there — `null`, and the record is open.
 *
 * NO CRON, and that is the point of deriving rather than sweeping: a background job
 * to close finished occupancies would be one more thing that can silently stop
 * running, and its absence would look exactly like "the group never left".
 *
 * ONE RECORD PER (room, session). A replay is a count, not a second visit; a group
 * sent to both rooms on a Mega day is legitimately two records, because they are
 * two rooms with two occupancies.
 */
import { HELMET_PHASE_MS } from "./types";
import type { BriefingEvent } from "./events-db";
import type { BriefingRoom, BriefingTier } from "./types";

/** Why an occupancy ended. `film-complete` is inferred, never stored. */
export type BriefingEndKind = "cleared" | "replaced" | "film-complete";

export interface BriefingRecord {
  room: BriefingRoom;
  sessionId: string;
  heatNumber: number | null;
  raceType: string | null;
  /** The film that played (or was to play). */
  tier: BriefingTier | null;
  filmUrl: string | null;
  filmMs: number | null;
  /** They walked in. */
  sentAtMs: number;
  /** The film rolled. Null = it never did — the thing a claim would ask about. */
  startedAtMs: number | null;
  /** The LAST time it rolled, if it was replayed; equals startedAtMs otherwise. */
  lastStartedAtMs: number | null;
  /** How many times it was played again from the top. */
  restarts: number;
  /** They left, by record or by arithmetic. Null = still in the room. */
  endedAtMs: number | null;
  endKind: BriefingEndKind | null;
  /** Time in the room, ms. Null while the occupancy is open. */
  inRoomMs: number | null;
  /** The film ran from its start to its full length without being cut off. False
   *  when it never started, or when the room was cleared or taken over mid-film. */
  filmCompleted: boolean;
  /**
   * THE ROOM ITSELF, photographed as the film began — the evidence the rest of
   * this record cannot supply (see room-photo.server.ts). Null when the camera or
   * the upload was unavailable, which is a fact worth reading rather than a gap to
   * paper over: it means we have the log for this briefing and no picture.
   */
  photoUrl: string | null;
  photoAtMs: number | null;
  /**
   * WAIT-TIME ANCHORS, carried off the `sent` row (see events-db.ts). When the
   * heat was CALLED — the moment every wait in the building is measured from —
   * and the two ends of its check-in window. Null for any group sent before
   * these were captured, which is why every metric that uses them drops a
   * session rather than assuming a zero.
   */
  calledAtMs: number | null;
  checkinFirstAtMs: number | null;
  checkinLastAtMs: number | null;
  checkinIn: number | null;
  checkinTotal: number | null;
}

/**
 * Fold a day's (or a session's) events.
 *
 * `nowMs` decides only whether a derived end has ARRIVED yet — it never invents
 * an end, so a record folded at 3pm and the same record folded next year agree
 * about everything that had already happened.
 *
 * Events may arrive in any order; they are keyed and merged, then sorted, so a
 * caller cannot break the fold by passing a day's rows newest-first.
 */
export function foldBriefingLog(events: BriefingEvent[], nowMs: number): BriefingRecord[] {
  const byGroup = new Map<string, BriefingEvent[]>();
  for (const e of events) {
    const key = `${e.room}::${e.sessionId}`;
    const bucket = byGroup.get(key);
    if (bucket) bucket.push(e);
    else byGroup.set(key, [e]);
  }

  const records: BriefingRecord[] = [];
  for (const bucket of byGroup.values()) {
    const ordered = [...bucket].sort((a, b) => a.atMs - b.atMs);
    const sent = ordered.find((e) => e.action === "sent");
    const starts = ordered.filter((e) => e.action === "started" || e.action === "restarted");
    const ended = ordered.find((e) => e.action === "ended");
    const first = ordered[0];
    // FIRST picture wins. One is written per briefing today, but a re-send into
    // the same room by the same session would append a second, and the shot that
    // matters is the one taken as the film first rolled.
    const photo = ordered.find((e) => e.action === "photo" && !!e.photoUrl) ?? null;

    // A group with no `sent` event cannot have its room time measured from the
    // door, so the earliest thing we DO know about it stands in. Only reachable
    // for a group whose send predates this table (the log's first day) or whose
    // send row was written before the log existed.
    const sentAtMs = sent?.atMs ?? first.atMs;
    const film = starts.find((e) => e.videoMs != null) ?? starts[0] ?? null;
    const filmMs = film?.videoMs ?? null;
    const startedAtMs = starts[0]?.atMs ?? null;
    const lastStartedAtMs = starts.length > 0 ? starts[starts.length - 1].atMs : null;

    // Rule 2: the film's own end, plus the helmet phase the TV holds after it.
    // Only meaningful once the film actually started and we know its length.
    const derivedEndMs =
      lastStartedAtMs != null && filmMs != null && filmMs > 0
        ? lastStartedAtMs + filmMs + HELMET_PHASE_MS
        : null;

    let endedAtMs: number | null = null;
    let endKind: BriefingEndKind | null = null;
    if (ended) {
      endedAtMs = ended.atMs;
      endKind = ended.reason === "replaced" ? "replaced" : "cleared";
    } else if (derivedEndMs != null && derivedEndMs <= nowMs) {
      endedAtMs = derivedEndMs;
      endKind = "film-complete";
    }

    // Cut off mid-film if the room ended before the film's own run finished.
    const filmEndMs =
      lastStartedAtMs != null && filmMs != null && filmMs > 0 ? lastStartedAtMs + filmMs : null;
    const filmCompleted =
      filmEndMs != null && (endedAtMs != null ? endedAtMs >= filmEndMs : nowMs >= filmEndMs);

    records.push({
      room: first.room,
      sessionId: first.sessionId,
      heatNumber: sent?.heatNumber ?? first.heatNumber,
      raceType: sent?.raceType ?? first.raceType,
      tier: film?.tier ?? sent?.tier ?? first.tier,
      filmUrl: film?.videoUrl ?? null,
      filmMs,
      sentAtMs,
      startedAtMs,
      lastStartedAtMs,
      restarts: starts.filter((e) => e.action === "restarted").length,
      endedAtMs,
      endKind,
      inRoomMs: endedAtMs != null ? Math.max(0, endedAtMs - sentAtMs) : null,
      filmCompleted,
      photoUrl: photo?.photoUrl ?? null,
      photoAtMs: photo?.atMs ?? null,
      calledAtMs: sent?.calledAtMs ?? null,
      checkinFirstAtMs: sent?.checkinFirstAtMs ?? null,
      checkinLastAtMs: sent?.checkinLastAtMs ?? null,
      checkinIn: sent?.checkinIn ?? null,
      checkinTotal: sent?.checkinTotal ?? null,
    });
  }

  // Newest first: the desk reads the most recent group, and a report reads a day.
  return records.sort((a, b) => b.sentAtMs - a.sentAtMs);
}
