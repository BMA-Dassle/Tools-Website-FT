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
  /**
   * THE SLOT THIS HEAT WAS SOLD AS — the venue's own `ScheduledStart`.
   *
   * Present on every record type, and present on ALL of them: 103/103 races on
   * 2026-08-16 carried it, zero missing. We had been dropping it on the floor,
   * which is the only reason "are we on time" ever had to be bought from an
   * outside service (owner 2026-08-17: "I'm thinking we control ourselves").
   *
   * IT IS A CHECK-IN TIME, NOT A GREEN-FLAG TIME. Measured against the same
   * night's briefing log: check-in completes a median 1.6 min BEFORE this stamp,
   * while the flag drops a median 16.1 min AFTER it. Anything comparing this to
   * `actualStartMs` and calling the difference "delay" is measuring the briefing
   * pipeline, not lateness — see features/racing/on-time.ts.
   */
  scheduledStartMs: number | null;
  /** The slot's own end. Slot spacing (start→end) is the printed grid — 12 min
   *  on Blue and Red — which is what makes a missing heat visible. */
  scheduledEndMs: number | null;
  /** The race's CONFIGURED length ("00:07:00" → 420000), not time remaining.
   *  Staff extend it mid-race and the venue reflects that here within a second
   *  (watched go 40:00 → 46:00 → 53:00 on 2026-08-15), so it is read fresh from
   *  every record rather than cached at start. Required, not optional: a
   *  clock that silently treats "missing" as "zero" is worse than no clock. */
  durationMs: number | null;
  /**
   * The venue's own version stamp for this record — THE ONLY WAY TO TELL A NEW
   * EVENT FROM A REPLAYED ONE.
   *
   * A reconnect's catch-up dump re-sends records verbatim, version and all.
   * Captured live 2026-08-15 21:36:08: five races replayed in a single burst,
   * every one carrying a RecordVersion already folded minutes earlier. Anything
   * that must fire once per real event has to compare this, because arrival
   * order alone cannot distinguish the replay (see race-clock's applyRaceStart,
   * where mistaking one for the green flag put every Blue board a minute slow).
   *
   * STRING, ALWAYS. These run 17 digits (13431438263023000) — past
   * Number.MAX_SAFE_INTEGER, same hazard class as BMI ids. A Number round-trip
   * would round neighbouring versions into false equality, which here reads as
   * "nothing happened" and silently drops a real green flag.
   */
  recordVersion: string | null;
}

/**
 * `SessionDurationChangedNotification` — staff adding (or cutting) time at the
 * desk, as a discrete event.
 *
 *   { $type: "SessionDurationChangedNotification", SessionId: 58773798,
 *     SessionName: "65 - Red Starter Restarted", Mode: "AtMost",
 *     DurationTime: "0:16:00", Date: "2026-08-15T01:55:36.677", ResourceId }
 *
 * Note `SessionId`, NOT `RaceId` — same id space (confirmed 2026-08-15: 58773798
 * was the live Red race), and note `DurationTime` here is "0:16:00" with a
 * ONE-digit hour where the race records use "00:07:00". Both must parse.
 */
export interface VenueDurationChange {
  raceId: string;
  sessionName: string;
  durationMs: number | null;
  atMs: number | null;
}

const ET_OFFSET_FALLBACK_MINUTES = -300; // EST — the conservative winter offset

/** ET's UTC offset in minutes AT a specific instant (not at noon of its date —
 *  the distinction that matters after midnight on DST-transition nights, when
 *  Fri/Sat racing runs to 2 AM and lib/et-time's noon-probed offset is an hour
 *  wrong for the 12-2 AM stamps; review finding 2026-08-12). */
function etOffsetMinutesAt(utcMs: number): number {
  try {
    const name =
      new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        timeZoneName: "longOffset",
      })
        .formatToParts(new Date(utcMs))
        .find((p) => p.type === "timeZoneName")?.value ?? "";
    const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(name);
    if (!m) return ET_OFFSET_FALLBACK_MINUTES;
    const sign = m[1] === "-" ? -1 : 1;
    return sign * (Number(m[2]) * 60 + Number(m[3] ?? "0"));
  } catch {
    return ET_OFFSET_FALLBACK_MINUTES;
  }
}

/** Venue wall-clock ("2026-08-11T23:05:35.4579", ET, no zone) → epoch ms.
 *  Two-pass: guess the instant assuming the wall time were UTC, read ET's
 *  offset AT that guessed instant, correct — so a 1:30 AM stamp on fall-back
 *  night resolves with that night's actual offset, not noon's. Strict about
 *  the shape the venue actually sends; anything else is null, never a guess. */
export function parseVenueLocalMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/.exec(value);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = [1, 2, 3, 4, 5, 6].map((i) => Number(m[i]));
  const ms = m[7] ? Number(m[7].slice(0, 3).padEnd(3, "0")) : 0;
  const asUtc = Date.UTC(y, mo - 1, d, h, mi, s, ms);
  const guess = asUtc - etOffsetMinutesAt(asUtc) * 60_000;
  return asUtc - etOffsetMinutesAt(guess) * 60_000;
}

/** "67 - Mega Starter" → 67. Distinct from results-frame's parseHeatNumber:
 *  the cloud socket prefixes "[HEAT]", the venue broadcast does not. */
export function parseVenueHeatNumber(name: string): number | null {
  const m = /^\s*(\d+)\s*-/.exec(name);
  return m ? Number(m[1]) : null;
}

/** Venue duration string → ms. Accepts BOTH widths the server actually sends:
 *  "00:07:00" on race records and "0:16:00" on duration-change notifications.
 *  Strict otherwise — an unparseable duration is null, never a zero that would
 *  render as a race with no time left. */
export function parseVenueDurationMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const m = /^(\d{1,2}):([0-5]\d):([0-5]\d)(?:\.(\d+))?$/.exec(value.trim());
  if (!m) return null;
  const ms = m[4] ? Number(m[4].slice(0, 3).padEnd(3, "0")) : 0;
  return ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + ms;
}

/** Every record of one `$type` in a webhook message (array or single object).
 *  Anything malformed is skipped, never thrown — this runs on the webhook's
 *  hot path where an exotic message must cost nothing. */
function extractRaceRecords(message: unknown, type: string): VenueRaceFinish[] {
  const records = Array.isArray(message) ? message : [message];
  const out: VenueRaceFinish[] = [];
  for (const rec of records) {
    if (!rec || typeof rec !== "object") continue;
    const r = rec as Record<string, unknown>;
    if (r["$type"] !== type) continue;
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
      scheduledStartMs: parseVenueLocalMs(r.ScheduledStart),
      scheduledEndMs: parseVenueLocalMs(r.ScheduledEnd),
      durationMs: parseVenueDurationMs(r.DurationTime),
      // String(), never Number() — 17 digits, see the field doc.
      recordVersion:
        r.RecordVersion === undefined || r.RecordVersion === null ? null : String(r.RecordVersion),
    });
  }
  return out;
}

export function extractRaceFinishes(message: unknown): VenueRaceFinish[] {
  return extractRaceRecords(message, "RaceFinish");
}

/**
 * Every `RaceStart` record — THE FLAG DROPPING, as it happens.
 *
 * Owner 2026-08-12: "don't we have race start from the karting websocket?" We do,
 * and we were not listening for it. Surveyed the ingest FIFO the same night: the
 * bridge forwards RaceStart (272 of them in the buffer), and it carries the same
 * shape as a finish minus the end — RaceId, ResourceId, Name, and the venue's own
 * `ActualStart` with `State: "Started"`.
 *
 * WHY IT MATTERS EVEN THOUGH A FINISH ALSO CARRIES ActualStart: the finish only
 * arrives when the race is OVER. Reading the start from it means a race's start
 * time is unknown for the seven minutes it is being run — fine for a report
 * written the next day, useless for a board that says how long the group in
 * front of you has been waiting. With this, the start lands within seconds of the
 * flag and the finish merely completes the row.
 *
 * `state` is deliberately carried rather than filtered here: this returns what
 * the wire said, and the caller decides what to act on.
 */
export function extractRaceStarts(message: unknown): VenueRaceFinish[] {
  return extractRaceRecords(message, "RaceStart");
}

/**
 * Every `RaceStop` record — the race PAUSING.
 *
 * Carries `State: "Paused"` and the race's ORIGINAL `ActualStart`, which the
 * venue never restamps on resume (2026-08-15: race 58698117 paused and resumed
 * and kept `ActualStart 00:46:01` throughout, while the desk clock stopped and
 * started correctly). That is precisely why a countdown cannot be derived from
 * start + duration alone — see race-clock.ts.
 *
 * NOTE the record does NOT stamp WHEN the pause happened; only that the race is
 * now paused. Pause boundaries therefore come from message arrival time, which
 * is honest to within the pipe's delivery lag (sub-second on this feed).
 */
export function extractRaceStops(message: unknown): VenueRaceFinish[] {
  return extractRaceRecords(message, "RaceStop");
}

/**
 * THE SESSION LIFECYCLE NOTIFICATIONS — the same four moments the race records
 * describe, but stamped by the venue instead of inferred by us.
 *
 * Surveyed live 2026-08-16 (1.4h of `kart:events:queue`, 24 message types). All
 * four share one shape and differ only by `$type` and `NotificationMetaId`:
 *
 *   { $type: "SessionPausedNotification", ResourceId: 11208654,
 *     SessionId: 58599025, SessionName: "60 - Blue Starter",
 *     NotificationMetaId: -5013, Id: 58992427, Date: "2026-08-16T23:18:10.028" }
 *
 * WHY THESE AND NOT `RaceStop`, which we already read. RaceStop says the race is
 * NOW paused and carries no stamp for WHEN — extractRaceStops' own doc admits
 * pause boundaries have to come from message arrival time. This carries `Date`,
 * so a pause is finally an instant rather than "somewhere around when we heard".
 *
 * `Id` IS 17 DIGITS and is already rounded by the time anything JSON.parses it
 * (58992427 here is small, but ProjectStateChangedNotification's runs to
 * 63000000008659300). It is deliberately NOT extracted — nothing needs it, and
 * carrying a corrupted value invites somebody to key on it later.
 */
export type SessionLifecycleKind = "started" | "paused" | "resumed" | "finished";

const LIFECYCLE_TYPES: Record<string, SessionLifecycleKind> = {
  SessionStartedNotification: "started",
  SessionPausedNotification: "paused",
  SessionResumedNotification: "resumed",
  SessionFinishedNotification: "finished",
};

export interface VenueSessionLifecycle {
  /** String, always — same id space as Pandora sessionIds (house rule). */
  sessionId: string;
  sessionName: string;
  heatNumber: number | null;
  track: TrackKey | null;
  kind: SessionLifecycleKind;
  /** The venue's own stamp. Null when unparseable — never silently "now". */
  atMs: number | null;
}

export function extractSessionLifecycle(message: unknown): VenueSessionLifecycle[] {
  const records = Array.isArray(message) ? message : [message];
  const out: VenueSessionLifecycle[] = [];
  for (const rec of records) {
    if (!rec || typeof rec !== "object") continue;
    const r = rec as Record<string, unknown>;
    const kind = LIFECYCLE_TYPES[String(r["$type"])];
    if (!kind) continue;
    if (r.SessionId === undefined || r.SessionId === null) continue;
    const sessionName = typeof r.SessionName === "string" ? r.SessionName : "";
    out.push({
      sessionId: String(r.SessionId),
      sessionName,
      heatNumber: parseVenueHeatNumber(sessionName),
      track: VENUE_RESOURCE_TRACKS[String(r.ResourceId)] ?? null,
      kind,
      atMs: parseVenueLocalMs(r.Date),
    });
  }
  return out;
}

/**
 * THE TRACK E-STOP.
 *
 *   { $type: "EmergencyOnNotification", NotificationMetaId: -106,
 *     ResourceId: 11208654, Id: 58992455, Date: "2026-08-16T23:18:20.574" }
 *
 * POLARITY, ESTABLISHED FROM THE WIRE AND NOT FROM THE NAME (2026-08-16, Blue,
 * heat 60): `EmergencyOn` is the emergency being ACTIVE. The sequence is
 * unambiguous — On at 23:15:02.651, the session pauses 0.56s later, karts flag
 * as crashed over the next few seconds, the session resumes at 23:18:02, and
 * only then does `EmergencyOff` land. Getting this backwards would invert every
 * row of an incident log, which is the one error a safety record cannot make.
 *
 * NO SESSION ON THIS RECORD — 0 of 16 carried a SessionId or RaceId. An
 * emergency belongs to a TRACK; tying it to a heat is the caller's inference and
 * has to be recorded as such (track-events.server.ts).
 *
 * IT CHATTERS. Off at 23:18:07.866 was followed by On at 23:18:08.809, 0.9s
 * later. Anything holding state off these must tolerate rapid re-arming.
 */
export interface VenueEmergency {
  track: TrackKey | null;
  /** True = emergency ACTIVE. See the polarity note above. */
  on: boolean;
  atMs: number | null;
}

export function extractEmergencies(message: unknown): VenueEmergency[] {
  const records = Array.isArray(message) ? message : [message];
  const out: VenueEmergency[] = [];
  for (const rec of records) {
    if (!rec || typeof rec !== "object") continue;
    const r = rec as Record<string, unknown>;
    const type = String(r["$type"]);
    if (type !== "EmergencyOnNotification" && type !== "EmergencyOffNotification") continue;
    out.push({
      track: VENUE_RESOURCE_TRACKS[String(r.ResourceId)] ?? null,
      on: type === "EmergencyOnNotification",
      atMs: parseVenueLocalMs(r.Date),
    });
  }
  return out;
}

/**
 * ONE COMPLETED LAP, with the instant it was completed.
 *
 * `TimingPassingNotification` is the only thing on any of our wires that says
 * WHEN a particular lap happened. Everything else — the standings capture, the
 * Pandora scores API — carries aggregates: a best lap with no timestamp, which
 * cannot be located inside a video.
 *
 * Surveyed live 2026-08-17 (251 in one queue window):
 *
 *   { $type: "TimingPassingNotification", LapTimeMs: 42084,
 *     PassingTimeUtc: "2026-08-17T03:24:25.618Z", PassingId: 58992702,
 *     ParticipantName: "Genn A", ParticipantId: 58964159,
 *     RentalObjectName: "27", TransponderCode: "...",
 *     SessionId: 58599025, SessionName: "60 - Blue Starter", ... }
 *
 * NOTE THIS ARRIVES DESPITE `Timing: "false"` in the bridge's BcStart. Earlier
 * lore said per-lap data was gated behind that flag; it is not, and no
 * subscription change is needed.
 *
 * `PassingTimeUtc` is a REAL UTC instant with a Z suffix — unlike the venue's
 * ActualStart/ActualEnd, which are local wall clock with no zone (see
 * parseVenueLocalMs). Parse it directly; do not route it through that helper.
 *
 * Ids are stringified rather than Number()'d per the house rule, even though
 * these are 8-digit today.
 */
export interface VenueLapPassing {
  sessionId: string;
  sessionName: string;
  /** Display name exactly as the timing system shows it — often abbreviated
   *  ("Genn A"), because it is what a human typed at the kiosk. */
  participantName: string;
  /** Kart number, from RentalObjectName. */
  kart: string;
  lapTimeMs: number;
  /** When the racer crossed the line COMPLETING this lap, epoch ms. The lap
   *  itself therefore occupies [passingAtMs − lapTimeMs, passingAtMs]. */
  passingAtMs: number;
  passingId: string | null;
}

export function extractLapPassings(message: unknown): VenueLapPassing[] {
  const records = Array.isArray(message) ? message : [message];
  const out: VenueLapPassing[] = [];
  for (const rec of records) {
    if (!rec || typeof rec !== "object") continue;
    const r = rec as Record<string, unknown>;
    if (r["$type"] !== "TimingPassingNotification") continue;

    const lapTimeMs = Number(r.LapTimeMs);
    const passingAtMs = Date.parse(String(r.PassingTimeUtc ?? ""));
    const sessionId = r.SessionId === undefined || r.SessionId === null ? "" : String(r.SessionId);
    const participantName = typeof r.ParticipantName === "string" ? r.ParticipantName.trim() : "";

    // A passing with no session, no name, no time or no lap length cannot be
    // joined to anything — skipping beats storing a row nothing can use. The
    // out lap in particular arrives with a nonsense length.
    if (!sessionId || !participantName) continue;
    if (!Number.isFinite(lapTimeMs) || lapTimeMs <= 0) continue;
    if (!Number.isFinite(passingAtMs)) continue;

    out.push({
      sessionId,
      sessionName: typeof r.SessionName === "string" ? r.SessionName : "",
      participantName,
      kart: typeof r.RentalObjectName === "string" ? r.RentalObjectName : "",
      lapTimeMs,
      passingAtMs,
      passingId: r.PassingId === undefined || r.PassingId === null ? null : String(r.PassingId),
    });
  }
  return out;
}

/** Every `SessionDurationChangedNotification` — a staff time-add/cut. */
export function extractDurationChanges(message: unknown): VenueDurationChange[] {
  const records = Array.isArray(message) ? message : [message];
  const out: VenueDurationChange[] = [];
  for (const rec of records) {
    if (!rec || typeof rec !== "object") continue;
    const r = rec as Record<string, unknown>;
    if (r["$type"] !== "SessionDurationChangedNotification") continue;
    if (r.SessionId === undefined || r.SessionId === null) continue;
    out.push({
      raceId: String(r.SessionId),
      sessionName: typeof r.SessionName === "string" ? r.SessionName : "",
      durationMs: parseVenueDurationMs(r.DurationTime),
      atMs: parseVenueLocalMs(r.Date),
    });
  }
  return out;
}

/** How stale a stamped end may be and still trigger the finish actions. Wide
 *  enough to absorb the pipe's ordinary delivery lag, narrow enough that a
 *  reconnect catch-up dump of the afternoon's races stays inert. */
export const FINISH_FRESH_MS = 10 * 60_000;

/** An UNSTAMPED Finished race (pending-finish window) is trusted only while a
 *  race that recently started could plausibly still be wrapping up. Longest
 *  legitimate start→stamp span observed on real nights is ~15 min (7-12 min
 *  races + the 5 min pending window); wider invited replayed snapshots to
 *  fabricate fresh end times (review 2026-08-12, was 30 min). */
const UNSTAMPED_MAX_RACE_AGE_MS = 20 * 60_000;

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
