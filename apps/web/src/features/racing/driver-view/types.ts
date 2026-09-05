/**
 * The driver view's domain types — what one racer, in one kart, is told.
 *
 * THE KART NUMBER IS THE KEY. No sign-in, no pass, no scan (owner 2026-09-05):
 * a guest types the number off the nose cone and that is the whole identity.
 * Everything here is therefore addressed by kart, and the awkward part of the
 * venue feed is that its events are NOT:
 *
 *   - kart-keyed, no session:      CrashNotification, UnCrashNotification,
 *                                  SpeedChange, PassingButNoSessionAssigned
 *   - participant-keyed, no kart:  ParticipantBlueFlag, BlackOverWhite,
 *                                  Disqualified, DidNotStart, Added/Removed
 *   - both:                        TimingPassing, EnterTap, RaceAdvice
 *   - session-only:                SessionStarted/Finished/Paused/Resumed,
 *                                  CheckeredFlag, Emergency, RaceStart/Finish
 *
 * So a blue flag can only reach kart 15 through a BINDING built from the events
 * that carry both halves. That binding is the whole reason this feature has a
 * server side at all — see `binding.ts`.
 */

/** Kart number as the venue prints it — `RentalObjectName`. Always a string:
 *  the venue sends "4", "13", "15" and leading zeros are not ours to lose. */
export type KartNumber = string;

export type TrackKey = "blue" | "red" | "mega";

/**
 * How loudly an alert speaks.
 *
 * `takeover` covers the whole screen and is reserved for the flags plus the two
 * moments a driver must act on. Everything else is `inline` and slides in over
 * the pit board without hiding the position or the clock — the owner's rule is
 * that nothing steals the screen mid-corner.
 */
export type AlertLevel = "takeover" | "inline";

export type AlertKind =
  // takeovers — race control
  | "green"
  | "blue"
  | "caution"
  | "red"
  | "crash"
  | "blackwhite"
  | "disqualified"
  | "paused"
  | "chequered"
  // inline — good news
  | "personalBest"
  | "dayRecord"
  | "monthRecord"
  | "everRecord"
  | "positionUp"
  | "recovered"
  // inline — housekeeping
  | "restricted"
  | "slowZone"
  | "kartReassigned"
  | "didNotStart"
  | "aboutToStart"
  | "finished";

export interface DriverAlert {
  kind: AlertKind;
  level: AlertLevel;
  /** Epoch ms, from the venue's own stamp where it has one. */
  atMs: number;
  /** The kart this was routed to. */
  kart: KartNumber;
  /** Venue session, when the source event knew it. */
  sessionId: string | null;
  sessionName: string | null;
  /**
   * The venue's own words, passed through untouched — race control types these
   * into `Comments` on a warning or a disqualification and the driver is owed
   * them verbatim.
   */
  note: string | null;
  /** A formatted number the copy interpolates: a lap time, a position. */
  value: string | null;
  /**
   * When this stops being true. Crash states carry `ExpireTime` (~20s); a
   * takeover with no expiry stands until something replaces it.
   */
  expiresAtMs: number | null;
  /**
   * The venue's unique record id. Primary key everywhere downstream, which is
   * what makes the bridge's reconnect replays harmless.
   */
  eventId: string;
  /** `$type` it came from, so a row can always be traced back to the wire. */
  source: string;
}

/** One timed lap. */
export interface DriverLap {
  lapNumber: number;
  /** Null on the rollout laps the venue reports without a time. */
  lapTimeMs: number | null;
  /** ISO, genuine UTC — the venue stamps `PassingTimeUtc` with a Z. */
  atUtc: string;
  passingId: string;
}

/** Who is in the kart, resolved from the events that carry both halves. */
export interface KartBinding {
  kart: KartNumber;
  participantId: string | null;
  participantName: string | null;
  /**
   * BMI person id. STRING, ALWAYS — cloud-minted ids run 17 digits and a
   * Number round-trip silently lands on a neighbour. See the bridge's
   * `raw-ids.ts` for the proof.
   */
  personId: string | null;
  sessionId: string | null;
  sessionName: string | null;
  resourceId: string | null;
  track: TrackKey | null;
  updatedAtMs: number;
}

/** Everything the driver view renders, for one kart, in one answer. */
export interface DriverViewState {
  kart: KartNumber;
  binding: KartBinding | null;
  laps: DriverLap[];
  /** Newest first. */
  alerts: DriverAlert[];
  /** The one takeover currently standing, if any. */
  takeover: DriverAlert | null;
}
