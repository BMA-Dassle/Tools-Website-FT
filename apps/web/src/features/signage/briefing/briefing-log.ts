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

/** Why an occupancy ended. `film-complete` is inferred, never stored.
 *  `holding` = the group was sent to the pit seats (2026-08-13). */
export type BriefingEndKind = "cleared" | "replaced" | "film-complete" | "holding";

export interface BriefingRecord {
  room: BriefingRoom;
  /** Which TRACK the group is racing on — blue, red, or mega. Distinct from the
   *  room: on a Mega day both rooms serve one circuit, so a per-track number that
   *  read the room would split one track's average across two. */
  track: string | null;
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
  /**
   * THE LEGS, AND HOW LONG EACH TOOK (owner 2026-08-14: "need to start recording
   * more in the briefing log — keep track of all the time movements and how
   * long").
   *
   * The log already knew every instant; what it never did was subtract them, so
   * reading a slow night meant doing arithmetic across five columns by eye. Each
   * of these is one leg of the journey, and they are stored as DURATIONS rather
   * than left to the panel because the same numbers are what a report would want
   * tomorrow.
   *
   * Null wherever the anchoring instant is unknown — a leg we cannot measure is
   * blank, never zero. Zero is a real answer here (a group sent the moment they
   * were called) and must not be confused with "we do not know".
   */
  /** Called → walked into the room. The wait nobody was measuring. */
  waitToRoomMs: number | null;
  /** In the room → the film rolled. The gap Start's ten-second hold lives in. */
  toStartMs: number | null;
  /** When the karts came back, from the staff "race returned" press. */
  pittedAtMs: number | null;
  /**
   * THE TWO PA CUES, STAMPED (owner 2026-08-14: "in briefing log monitor pre and
   * post for each session with time stamp").
   *
   * Both already ride the insurance log — playPreRace and playPostRace write
   * `audio-pre` and `audio-post` rows — but nothing read them back, so the one
   * record of whether a group was actually called to their karts, and actually
   * called back in, was invisible to the desk.
   *
   * They are worth reading beside the rest of this row because they are the two
   * instants a person CAUSED. Everything else here is a press at a desk or a
   * marker off a wire; these two made a noise in the building, and a night where
   * one of them never sounded is a night somebody stood waiting for it.
   *
   * FIRST play wins, as with the photo: the cue is a session-keyed one-shot, so
   * a second row can only be a re-press re-asserting a release, and the instant
   * that matters is when the announcement actually sounded.
   */
  preAtMs: number | null;
  postAtMs: number | null;
  /** Pre-race called → post-race called: the group's whole time out of the
   *  room and on the circuit, measured by the two announcements. */
  preToPostMs: number | null;
  /** Left the room → karts back in the lane: the whole on-track leg. */
  roomToPittedMs: number | null;
  /**
   * CALLED → DONE, the figure a guest would give you. Runs to the pitted stamp
   * when there is one, else to the room's end, else to now — so a group still
   * moving shows a growing total and a finished one shows a fixed fact.
   */
  totalMs: number | null;
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
    // The karts back in the lane — the last movement this group makes, and the
    // one that closes the total.
    const pittedAtMs = ordered.find((e) => e.action === "pitted")?.atMs ?? null;
    // The two PA cues. `ordered` is sorted, so `find` is the FIRST play — see
    // the field docs for why a re-press must not move these.
    const preAtMs = ordered.find((e) => e.action === "audio-pre")?.atMs ?? null;
    const postAtMs = ordered.find((e) => e.action === "audio-post")?.atMs ?? null;

    // A group with no `sent` event cannot have its room time measured from the
    // door, so the earliest thing we DO know about it stands in. Only reachable
    // for a group whose send predates this table (the log's first day) or whose
    // send row was written before the log existed.
    const sentAtMs = sent?.atMs ?? first.atMs;
    const calledAtMs = sent?.calledAtMs ?? null;
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
      endKind =
        ended.reason === "replaced"
          ? "replaced"
          : ended.reason === "holding"
            ? "holding"
            : "cleared";
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
      track: sent?.track ?? first.track,
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
      waitToRoomMs: calledAtMs != null ? Math.max(0, sentAtMs - calledAtMs) : null,
      toStartMs: startedAtMs != null ? Math.max(0, startedAtMs - sentAtMs) : null,
      pittedAtMs,
      preAtMs,
      postAtMs,
      preToPostMs: preAtMs != null && postAtMs != null ? Math.max(0, postAtMs - preAtMs) : null,
      roomToPittedMs:
        pittedAtMs != null && endedAtMs != null ? Math.max(0, pittedAtMs - endedAtMs) : null,
      totalMs:
        calledAtMs != null ? Math.max(0, (pittedAtMs ?? endedAtMs ?? nowMs) - calledAtMs) : null,
      checkinFirstAtMs: sent?.checkinFirstAtMs ?? null,
      checkinLastAtMs: sent?.checkinLastAtMs ?? null,
      checkinIn: sent?.checkinIn ?? null,
      checkinTotal: sent?.checkinTotal ?? null,
    });
  }

  // Newest first: the desk reads the most recent group, and a report reads a day.
  return records.sort((a, b) => b.sentAtMs - a.sentAtMs);
}
