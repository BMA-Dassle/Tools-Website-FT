/**
 * One venue broadcast record → what the driver in a given kart should be told.
 *
 * PURE, and deliberately the only place that knows the venue's vocabulary. The
 * webhook hands records in, this decides whether each one concerns a kart and
 * what kind of alert it is; Redis, Neon and React know nothing about `$type`.
 *
 * ROUTING IS THE WHOLE PROBLEM. Three families of record arrive and none of
 * them are addressed the way the guest is:
 *
 *   kart-keyed      CrashNotification carries `RentalObjectName` and nothing else
 *                   — no session, no participant, no track.
 *   participant-keyed  ParticipantBlueFlagNotification carries `ParticipantId`
 *                   and `SessionId` but NEVER a kart number.
 *   session-only    CheckeredFlag, Emergency, SessionPaused — a whole race.
 *
 * So every function here takes a `KartBinding` lookup: the caller resolves
 * participant→kart and session→karts from the index in `binding.ts`, and this
 * module decides meaning. Passing a binding that cannot answer simply yields no
 * alert, which is the correct failure — a driver being shown someone else's
 * black flag is far worse than being shown nothing.
 *
 * CAUTION IS SYNTHETIC. There is no yellow-flag record on this wire — 32h of
 * traffic (2026-09-05) contains ParticipantBlueFlag, BlackOverWhite, Checkered
 * and Emergency, and no yellow of any kind. The owner's rule is that a caution
 * fires automatically on any crash detected on track, so `caution` is derived
 * from another kart's `CrashNotification`, and the crash on YOUR kart becomes
 * the `crash` takeover instead. If BMI ever exposes a real yellow, it should
 * replace the derivation rather than sit beside it.
 */
import type { AlertKind, AlertLevel, DriverAlert, KartNumber, TrackKey } from "./types";

/** A venue record, before we know anything about it. */
export type VenueRecord = Record<string, unknown>;

/** What the caller must be able to answer for routing to work. */
export interface RoutingContext {
  /** The kart this view is following. */
  kart: KartNumber;
  /** The participant currently bound to that kart, if known. */
  participantId: string | null;
  /** The session that kart is currently racing, if known. */
  sessionId: string | null;
  /** The venue resource the kart is on, so a session-wide flag can be scoped. */
  resourceId: string | null;
}

const TAKEOVER: ReadonlySet<AlertKind> = new Set<AlertKind>([
  "green",
  "blue",
  "caution",
  "red",
  "crash",
  "blackwhite",
  "disqualified",
  "paused",
  "chequered",
]);

export function levelFor(kind: AlertKind): AlertLevel {
  return TAKEOVER.has(kind) ? "takeover" : "inline";
}

/** Venue ResourceId → our track key. Mega is -1 (barrier out, one circuit). */
const RESOURCE_TRACKS: Record<string, TrackKey> = {
  "11208654": "blue",
  "11208660": "red",
  "-1": "mega",
};

export function trackForResource(resourceId: unknown): TrackKey | null {
  const key = str(resourceId);
  return key ? (RESOURCE_TRACKS[key] ?? null) : null;
}

/** Every id off this wire is read as a string — never `Number()`. */
function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

/**
 * The venue stamps `Date` as Eastern wall-clock with NO timezone suffix — the
 * same trap as BMI Office dates. `PassingTimeUtc` is the exception and is
 * genuine UTC with a Z. Anything unparseable falls back to arrival time, since
 * an alert with a slightly wrong stamp still beats a dropped alert.
 */
export function venueDateToMs(value: unknown, fallbackMs: number): number {
  const s = str(value);
  if (!s) return fallbackMs;
  // Already carries a zone (Z or ±hh:mm) — trust it.
  if (/(?:Z|[+-]\d{2}:\d{2})$/.test(s)) {
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : fallbackMs;
  }
  // Bare wall-clock. Eastern is UTC-4 in season and UTC-5 out of it; resolve it
  // properly rather than hardcoding an offset that is wrong half the year.
  const t = parseEasternWallClock(s);
  return t === null ? fallbackMs : t;
}

/** "2026-09-05T03:29:32.806" read as America/New_York, returned as epoch ms. */
export function parseEasternWallClock(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/.exec(s);
  if (!m) return null;
  const [, y, mo, d, h, mi, sec, frac] = m;
  const ms = frac ? Number(frac.padEnd(3, "0").slice(0, 3)) : 0;
  // Guess UTC, then correct by the zone's offset at that instant. Two passes
  // settle the DST boundary case where the first guess lands on the wrong side.
  const naive = Date.UTC(+y, +mo - 1, +d, +h, +mi, +sec, ms);
  let guess = naive;
  for (let i = 0; i < 2; i++) {
    const offset = easternOffsetMs(guess);
    guess = naive + offset;
  }
  return guess;
}

/**
 * How far behind UTC New York is at a given instant, in ms (positive).
 *
 * TRUNCATED TO THE SECOND FIRST, and that is not a detail: `Intl` formats to
 * second resolution, so subtracting its reconstruction from a millisecond-bearing
 * instant folds the fraction INTO the offset. The two-pass loop above then
 * compounds it, and a stamp of .806 came back 612ms late. Both operands have to
 * be whole seconds for the difference to be an offset and nothing else.
 */
function easternOffsetMs(atMs: number): number {
  const wholeSecond = Math.floor(atMs / 1000) * 1000;
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(new Date(wholeSecond));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") % 24,
    get("minute"),
    get("second"),
  );
  return wholeSecond - asUtc;
}

function alert(
  kind: AlertKind,
  rec: VenueRecord,
  ctx: RoutingContext,
  arrivedAtMs: number,
  extra?: { note?: string | null; value?: string | null; expiresAtMs?: number | null },
): DriverAlert {
  return {
    kind,
    level: levelFor(kind),
    atMs: venueDateToMs(rec.Date ?? rec.Occured, arrivedAtMs),
    kart: ctx.kart,
    sessionId: str(rec.SessionId) ?? ctx.sessionId,
    sessionName: str(rec.SessionName),
    note: extra?.note ?? null,
    value: extra?.value ?? null,
    expiresAtMs: extra?.expiresAtMs ?? null,
    eventId: str(rec.Id) ?? `${kind}:${arrivedAtMs}`,
    source: str(rec.$type) ?? "unknown",
  };
}

/** "1:06.832" from 66832 — the venue's own format for a lap. */
export function formatLap(ms: number): string {
  const m = Math.floor(ms / 60000);
  const s = ((ms % 60000) / 1000).toFixed(3).padStart(6, "0");
  return m > 0 ? `${m}:${s}` : s;
}

/**
 * Decide what, if anything, this record means for the kart in `ctx`.
 *
 * Returns null far more often than not — most of the wire is another kart's
 * business, or churn (`SpeedChange` for karts we are not following, `BcTime`,
 * `RaceAdvice` snapshots) that is handled elsewhere.
 */
export function classify(
  rec: VenueRecord,
  ctx: RoutingContext,
  arrivedAtMs: number,
): DriverAlert | null {
  const type = str(rec.$type);
  if (!type) return null;

  const recKart = str(rec.RentalObjectName);
  const recParticipant = str(rec.ParticipantId);
  const recSession = str(rec.SessionId);
  const recResource = str(rec.ResourceId);

  const isOurKart = recKart !== null && recKart === ctx.kart;
  const isOurParticipant =
    recParticipant !== null && ctx.participantId !== null && recParticipant === ctx.participantId;
  const isOurSession =
    recSession !== null && ctx.sessionId !== null && recSession === ctx.sessionId;
  // A session-wide record with no SessionId (Emergency) still scopes by track.
  const isOurResource =
    recResource !== null && ctx.resourceId !== null && recResource === ctx.resourceId;

  switch (type) {
    // ── race control, addressed to one participant ──────────────────────────
    case "ParticipantBlueFlagNotification":
      return isOurParticipant ? alert("blue", rec, ctx, arrivedAtMs) : null;

    case "ParticipantBlackOverWhiteFlagNotification":
      return isOurParticipant
        ? alert("blackwhite", rec, ctx, arrivedAtMs, { note: str(rec.Comments) })
        : null;

    case "ParticipantDisqualifiedNotification":
      return isOurParticipant
        ? alert("disqualified", rec, ctx, arrivedAtMs, { note: str(rec.Comments) })
        : null;

    case "ParticipantDidNotStartNotification":
      return isOurParticipant ? alert("didNotStart", rec, ctx, arrivedAtMs) : null;

    case "ParticipantRemovedFromStartedSessionNotification":
    case "ParticipantAddedToStartedSessionNotification":
      return isOurParticipant ? alert("kartReassigned", rec, ctx, arrivedAtMs) : null;

    // ── the track stopping, addressed to everyone on it ─────────────────────
    case "EmergencyOnNotification":
      // Karts are cut automatically by the system; the screen only has to say
      // so. Emergency carries a ResourceId but no session, hence the scope test.
      return isOurResource || ctx.resourceId === null ? alert("red", rec, ctx, arrivedAtMs) : null;

    case "EmergencyOffNotification":
      return isOurResource || ctx.resourceId === null
        ? alert("recovered", rec, ctx, arrivedAtMs)
        : null;

    case "SessionPausedNotification":
      return isOurSession ? alert("paused", rec, ctx, arrivedAtMs) : null;

    case "SessionResumedNotification":
      return isOurSession ? alert("green", rec, ctx, arrivedAtMs) : null;

    case "SessionStartedNotification":
      return isOurSession ? alert("green", rec, ctx, arrivedAtMs) : null;

    case "SessionAboutToStartNotification":
      return isOurSession ? alert("aboutToStart", rec, ctx, arrivedAtMs) : null;

    case "CheckeredFlagNotification":
      return isOurSession ? alert("chequered", rec, ctx, arrivedAtMs) : null;

    case "SessionFinishedNotification":
      return isOurSession ? alert("finished", rec, ctx, arrivedAtMs) : null;

    // ── incidents, addressed to a kart ──────────────────────────────────────
    case "CrashNotification": {
      if (recKart === null) return null;
      const expiresAtMs = venueDateToMs(rec.ExpireTime, arrivedAtMs + 20_000);
      // Ours is the instruction screen. Anyone else's is the automatic caution
      // — the owner's rule, and the only yellow this wire can produce.
      return isOurKart
        ? alert("crash", rec, ctx, arrivedAtMs, { expiresAtMs })
        : alert("caution", rec, ctx, arrivedAtMs, { value: recKart, expiresAtMs });
    }

    case "UnCrashNotification":
      return isOurKart ? alert("recovered", rec, ctx, arrivedAtMs) : null;

    case "EnterTapNotification":
      return isOurKart || isOurParticipant
        ? alert("slowZone", rec, ctx, arrivedAtMs, { note: str(rec.TrapName) })
        : null;

    case "AssignmentNotification":
      return isOurParticipant && recKart !== null && recKart !== ctx.kart
        ? alert("kartReassigned", rec, ctx, arrivedAtMs, { value: recKart })
        : null;

    // ── records ─────────────────────────────────────────────────────────────
    case "DayRecordBrokenNotification":
    case "MonthRecordBrokenNotification":
    case "EverRecordBrokenNotification": {
      if (!isOurParticipant) return null;
      const kind: AlertKind =
        type === "DayRecordBrokenNotification"
          ? "dayRecord"
          : type === "MonthRecordBrokenNotification"
            ? "monthRecord"
            : "everRecord";
      return alert(kind, rec, ctx, arrivedAtMs, { value: str(rec.Result) });
    }

    default:
      return null;
  }
}

/**
 * A lap crossing, if this record is one for the kart we follow.
 *
 * Separate from `classify` because a lap is not an alert — it is the record we
 * keep forever. The "personal best" alert is derived downstream, where the rest
 * of the session's laps are known; a single passing cannot tell.
 */
export function readPassing(
  rec: VenueRecord,
  kart: KartNumber,
): {
  passingId: string;
  lapTimeMs: number | null;
  atUtc: string | null;
  participantId: string | null;
  participantName: string | null;
  sessionId: string | null;
  sessionName: string | null;
  resourceId: string | null;
} | null {
  if (str(rec.$type) !== "TimingPassingNotification") return null;
  if (str(rec.RentalObjectName) !== kart) return null;
  const passingId = str(rec.PassingId);
  if (!passingId) return null;
  // The rollout laps arrive with no LapTimeMs at all — a real, expected shape,
  // not a parse failure. They are kept so the lap numbering matches the venue's.
  const rawLap = rec.LapTimeMs;
  const lapTimeMs =
    typeof rawLap === "number" && Number.isFinite(rawLap) && rawLap > 0 ? rawLap : null;
  return {
    passingId,
    lapTimeMs,
    atUtc: str(rec.PassingTimeUtc),
    participantId: str(rec.ParticipantId),
    participantName: str(rec.ParticipantName),
    sessionId: str(rec.SessionId),
    sessionName: str(rec.SessionName),
    resourceId: str(rec.ResourceId),
  };
}
