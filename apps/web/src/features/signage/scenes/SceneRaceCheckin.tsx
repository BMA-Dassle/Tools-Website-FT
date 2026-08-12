"use client";

/**
 * The track check-in screen: who is checking in right now, and what time.
 *
 * THE ONE THING THIS SCREEN MUST GET RIGHT is what the time on it MEANS.
 *
 * The time on a racer's e-ticket is their check-in CUT-OFF — the moment they
 * must already be checked in by (owner, 2026-08-11). It is not the green flag,
 * and it is not when check-in opens. A bare time on a wall reads as "my race is
 * at 7:45" to anyone who has not been here before, so they relax and miss the
 * cut. Every time on this screen is therefore labelled as a deadline.
 *
 * DATA COMES FROM THE SAME PLACE THE WEBSITE'S DOES. `useTrackStatus()` polls
 * /api/track-status and /api/pandora/races-current?prefer=cache — the exact two
 * endpoints behind the e-tickets, the confirmation pages and the kiosk race
 * hub. That is deliberate: a wall that disagrees with the ticket in a guest's
 * hand is worse than no wall. Nothing here re-derives a session or a delay.
 */
import { IconAlertTriangleFilled } from "@tabler/icons-react";
import { useTrackStatus } from "@/hooks/useTrackStatus";
import { withAlpha } from "../color";
import { nextLevelTarget } from "~/features/racing/qualify";
import { LiveSessionChip } from "../live-session";
import {
  TRACK_ACCENTS,
  TRACK_LABELS,
  TRACK_RESOURCE_IDS,
  effectiveTrack,
  trackFromResourceIds,
  type TrackKey,
} from "../track";
import { recentScans, eventInScope } from "../director/schedule";
import { RecordsQr } from "../components/RecordsQr";
import { demoCurrentRace, demoIsMegaDay } from "../demo";
import type { SceneProps } from "../director/types";

const BIRTHDAY_PINK = "#EC4899";
const PAD_X = 96;
const PAD_Y = 54;

/** How long a checked-in name stays on the rail, and how many fit. Sized for a
 *  full heat arriving together — the common case, not the exception. */
const SCAN_RAIL_WINDOW_MS = 90_000;
const SCAN_RAIL_LIMIT = 6;

/**
 * Quiet for this long and the screen goes to STANDBY: the rail clears and the
 * session gets the whole wall.
 *
 * A burst of scans is one arriving group; the gap after it means we are between
 * heats, or the heat has been called and we are waiting on people. In that gap
 * the last few names are clutter — what somebody walking up needs is the
 * session and the time, as large as possible. So the screen alternates between
 * BUSY (names landing) and STANDBY (clean), rather than holding a stale list.
 */
const STANDBY_AFTER_MS = 30_000;

/** The Mega check-in FEED board keeps everyone listed for the whole session —
 *  no aging off, no standby clear. The window only exists to stop yesterday
 *  replaying after an idle day. */
const FEED_WINDOW_MS = 3 * 3600_000;
const FEED_LIMIT = 48;

/** How long a wrong-race notice stays up. Long enough to read twice. */
const WRONG_RACE_SHOW_MS = 12_000;

/** How long a newly-called heat gets the attention treatment. Long enough for
 *  someone at the far end of the arcade to look up and read it. */
const JUST_CALLED_MS = 45_000;

/**
 * How long a scan with NO session to attach to may still be listed.
 *
 * Not a session lifetime — a session now ends when the group is sent to a briefing
 * room (see the note in the component). This only bounds orphan names, so the feed
 * board cannot re-list an hour of old scans during a gap between heats.
 */
const SCAN_ORPHAN_MS = 10 * 60_000;

/**
 * How long the board announces which briefing room to walk to, after a send.
 *
 * A minute: long enough for a group that has just been told verbally to look up and
 * confirm it, short enough that the board is free for the next heat. After it the
 * board goes idle — the group has left the desk, so there is nothing to show.
 */
const PROCEED_SHOW_MS = 60_000;

/** Where the records QR points. The public best-times board, which already
 *  carries the per-track records matrix. */
const recordsUrl =
  typeof window !== "undefined"
    ? `${window.location.origin}/leaderboards`
    : "https://fasttraxent.com/leaderboards";

export function SceneRaceCheckin({ feed, nowMs, config, demo }: SceneProps) {
  const status = useTrackStatus();

  const megaEnabled = status?.trackStatus.megaTrackEnabled ?? false;

  const screenTrack = trackFromResourceIds(config.scope.resourceIds);
  let track = effectiveTrack(screenTrack, megaEnabled) ?? "blue";

  // Data beats configuration. On a Mega day the barrier between Blue and Red
  // comes out and racing moves to the combined circuit — but the delay service
  // that reports `megaTrackEnabled` is external and does not flip the instant
  // the day turns over. If this screen's own track has nothing checking in and
  // Mega does, follow Mega: the alternative is a board sitting on "no session"
  // while a heat is genuinely checking in feet away.
  if (!status?.currentRaces?.[track] && status?.currentRaces?.mega) {
    track = "mega";
  }

  // Preview session on a Mega day previews a MEGA session (owner 2026-08-11:
  // "if mega track is enabled and I hit preview session it should show the
  // right one"). Preview-only — live boards follow the real signals.
  if (demo === "race" && demoIsMegaDay(nowMs)) track = "mega";

  const accent = TRACK_ACCENTS[track];

  // When this board is following Mega, scans arrive stamped with the MEGA
  // resource id — a Blue-scoped board would silently reject every one of them
  // and the feed would sit empty on the busiest day of the week. Widen the
  // accepted ids to include Mega whenever Mega is what we are showing.
  const scopeIds =
    track === "mega"
      ? [...config.scope.resourceIds, TRACK_RESOURCE_IDS.mega]
      : config.scope.resourceIds;

  // races-current reports nothing overnight on purpose, so a stale "Now
  // Checking In" cannot sit on a wall until morning. `?demo=race` substitutes a
  // fabricated session so the board can be reviewed outside operating hours —
  // deliberate, client-only, and gone on the next reload.
  const rawRace =
    status?.currentRaces?.[track] ??
    (demo === "race" ? demoCurrentRace(nowMs, TRACK_LABELS[track]) : null);

  // The session's own lifetime, and the scans' with it. Names are floored to
  // this session's call — so the moment the NEXT session is called, everyone
  // from the previous one drops without any bookkeeping.
  //
  // WHAT ENDS A SESSION ON THIS BOARD IS THE BRIEFING SEND, not a timer (owner
  // 2026-08-11: "send to room should be what clears the check in TV… don't clear
  // it automatically, just do it based on sending to room"). Once staff send a
  // group to a briefing room they have finished checking in, so the board's job
  // for that heat is done — which is a fact about the operation rather than about
  // elapsed minutes. A ten-minute rule cleared boards while people were still
  // walking up, and held them for ten minutes after a group had long gone.
  //
  // Undoing a send removes the marker, so a mis-send puts the heat straight back.
  const calledAtMs = rawRace?.calledAt ? Date.parse(rawRace.calledAt) : NaN;

  // THE HANDOVER. A send does two things to this board, in order: it announces
  // where the group is going, and then it lets go of the heat (owner 2026-08-11 —
  // "when we hit send a room I would like the track check-in TV to let them know
  // to proceed"). Announcing and clearing are the same event a minute apart, not
  // two decisions.
  //
  // MEGA vs ORDINARY falls out of the data rather than needing a mode: on a Mega
  // day both track boards read the one combined session, so both announce, and both
  // name the room it actually went to. On an ordinary day a board only ever sees its
  // own track's session, so only the board for that track reacts at all.
  const briefedAtMs = feed?.raceCheckin?.briefedAtMs ?? null;
  const briefedRoom = feed?.raceCheckin?.briefedRoom ?? null;
  const briefedAgoMs = briefedAtMs != null ? nowMs - briefedAtMs : null;
  const announcing =
    briefedAgoMs != null && briefedAgoMs >= -5_000 && briefedAgoMs < PROCEED_SHOW_MS;
  const sessionExpired = briefedAtMs !== null;
  const race = sessionExpired ? null : rawRace;
  const scanFloorMs = sessionExpired
    ? Number.POSITIVE_INFINITY
    : Number.isFinite(calledAtMs)
      ? calledAtMs - 60_000 // small grace: a scan landing as the call goes out
      : // No session to attach to ⇒ a name still lives at most SCAN_ORPHAN_MS.
        // This is a different question from "when does a session end": the rail's
        // Redis entries survive an hour, and with a floor of zero the feed board
        // re-listed every old scan whenever no session was current — which is how
        // Marcus outstayed his welcome (owner).
        nowMs - SCAN_ORPHAN_MS;
  const delay = findDelay(status?.trackStatus.tracks, track);

  // VIPs DO NOT SCAN IN — they are met and escorted (owner 2026-08-11). The
  // banner is driven by who is entered on the heat, computed server-side from
  // the roster, never by anybody swiping a licence at the desk.
  const vip = feed?.raceCheckin?.vipOnHeat ? feed.raceCheckin : null;

  // Racers arrive in bursts, so the rail carries SEVERAL at once rather than
  // interrupting the screen once per person.
  const scans = recentScans(
    nowMs,
    feed?.kioskEvents ?? [],
    scopeIds,
    SCAN_RAIL_WINDOW_MS,
    SCAN_RAIL_LIMIT,
  ).filter((sc) => sc.atMs >= scanFloorMs);
  // A heat has JUST been called. This is the moment the board has to be seen
  // from across the room — it is the only warning a racer gets that their race
  // is up, and someone half-watching from the arcade needs to catch it.
  const calledAgoMs = race?.calledAt ? nowMs - Date.parse(race.calledAt) : Number.POSITIVE_INFINITY;
  const justCalled =
    Number.isFinite(calledAgoMs) && calledAgoMs >= 0 && calledAgoMs < JUST_CALLED_MS;

  // Quiet for a while ⇒ standby: clear the rail and give the session the wall.
  //
  // ON MEGA THE SESSION BOARD CARRIES NO NAMES AT ALL (owner 2026-08-11: "take
  // the check in people off the session screen for mega"). The pair splits the
  // job — the feed board lists everyone, so names here would be a smaller
  // duplicate of the wall next to it. The flash goes with the rail: no rail,
  // nothing for the flash to announce.
  const railSuppressed = track === "mega" && config.megaRole === "session";
  const busy =
    !announcing && !railSuppressed && scans.length > 0 && nowMs - scans[0].atMs < STANDBY_AFTER_MS;

  // MEGA SPLIT (owner 2026-08-11). On a Mega day both boards read the same
  // single session, so a pair showing identical content wastes a screen. A
  // board whose megaRole is "checkin" becomes a dedicated live check-in feed —
  // a much bigger format where NAMES NEVER AGE OFF ("we'll have tons of room"):
  // the whole heat stays listed as they arrive. The other board keeps the
  // session. Per-screen setting in admin.
  if (track === "mega" && config.megaRole === "checkin") {
    const everyone = recentScans(
      nowMs,
      feed?.kioskEvents ?? [],
      scopeIds,
      FEED_WINDOW_MS,
      FEED_LIMIT,
    ).filter((sc) => sc.atMs >= scanFloorMs);
    return (
      <CheckinFeed
        accent={accent}
        race={race}
        scans={everyone}
        checkedIn={feed?.raceCheckin?.checkedIn ?? null}
        total={feed?.raceCheckin?.total ?? null}
        showRecordsQr={config.showRecordsQr}
      />
    );
  }

  // Somebody scanned for a heat that is not this one. Amber, not red: they have
  // not done anything wrong, they are just early or late, and the screen's job
  // is to tell them when to come back.
  const wrongRace = (feed?.kioskEvents ?? [])
    .filter(
      (e) =>
        e.kind === "racer-wrong-race" &&
        nowMs - e.atMs < WRONG_RACE_SHOW_MS &&
        nowMs - e.atMs > -5_000 &&
        eventInScope(e, scopeIds),
    )
    .sort((a, b) => b.atMs - a.atMs)[0];

  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden", background: "#000418" }}>
      {/* JUST CALLED. A full-frame accent flood breathing over everything, plus
          a thick border — deliberately hard to ignore, and it retires itself
          after JUST_CALLED_MS so the board is not shouting all night. */}
      {justCalled && (
        <>
          <div
            aria-hidden
            className="tv-breathe"
            style={{
              position: "absolute",
              inset: 0,
              background: `radial-gradient(80% 70% at 50% 50%, ${withAlpha(accent, 0.55)}, transparent 75%)`,
              zIndex: 2,
              pointerEvents: "none",
            }}
          />
          <div
            aria-hidden
            className="tv-breathe"
            style={{
              position: "absolute",
              inset: 0,
              border: `14px solid ${accent}`,
              boxShadow: `inset 0 0 120px ${withAlpha(accent, 0.7)}`,
              zIndex: 3,
              pointerEvents: "none",
            }}
          />
        </>
      )}

      {/* TRACK IDENTITY. A wash alone was not enough to tell the boards apart
          across a room, so the colour also owns a full-width bar along the top
          and a floor glow. Someone should know which board they are looking at
          before they read a single word. */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: 16,
          background: accent,
          boxShadow: `0 0 60px ${accent}`,
          zIndex: 1,
        }}
      />
      <div
        aria-hidden
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          height: 220,
          background: `linear-gradient(to top, ${withAlpha(accent, 0.35)}, transparent)`,
          pointerEvents: "none",
        }}
      />
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          background: `radial-gradient(75% 65% at 50% 40%, ${withAlpha(accent, 0.42)}, transparent 74%)`,
        }}
      />
      <div aria-hidden className="tv-sweep" style={{ position: "absolute", inset: 0 }} />

      <div
        style={{
          position: "absolute",
          inset: `${PAD_Y}px ${PAD_X}px`,
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* Track identity, with its status directly UNDERNEATH the name rather
            than across the room from it (owner 2026-08-11) — "Blue Track" and
            "running 12 min behind" are one thought and belong together. */}
        <header style={{ display: "flex", alignItems: "flex-start", gap: 16 }}>
          <span
            aria-hidden
            style={{
              width: 18,
              height: 18,
              borderRadius: "50%",
              background: accent,
              boxShadow: `0 0 24px ${accent}`,
              marginTop: 14,
            }}
          />
          <div>
            <div
              className="tv-display"
              style={{
                color: accent,
                fontSize: 52,
                letterSpacing: "0.04em",
                textShadow: `0 0 34px ${withAlpha(accent, 0.65)}`,
              }}
            >
              {TRACK_LABELS[track]}
            </div>
            <DelayLine delay={delay} />
          </div>
          {/* The heat ON TRACK right now, live from the timing system — the same
              clock /leaderboards shows (owner 2026-08-11: "add to the sign-in
              board view for each track"). Renders nothing between heats. */}
          <div style={{ marginLeft: "auto" }}>
            <LiveSessionChip track={track} accent={accent} />
          </div>
        </header>

        {announcing ? (
          <ProceedToBriefing room={briefedRoom} accent={accent} />
        ) : race ? (
          <CheckingIn
            race={race}
            accent={accent}
            justCalled={justCalled}
            nowMs={nowMs}
            windowMins={config.showCheckinCountdown ? config.checkinWindowMins : null}
            standby={!busy}
            // On Mega the count lives on the FEED board's header (owner) — the
            // session board carries no check-in state at all.
            checkedIn={railSuppressed ? null : (feed?.raceCheckin?.checkedIn ?? null)}
            total={railSuppressed ? null : (feed?.raceCheckin?.total ?? null)}
          />
        ) : (
          <Idle accent={accent} />
        )}

        {/* A scan should be felt, not just listed. The newest one flashes the
            whole screen once — keyed to the event id so it fires exactly once
            per person and cannot re-trigger on a re-render. */}
        {busy && !wrongRace && <ScanFlash key={scans[0].id} accent={accent} />}
        {wrongRace && <WrongRaceNotice event={wrongRace} />}
        {busy && !wrongRace && (
          <ScanRail scans={scans} accent={accent} raised={!!vip} nowMs={nowMs} />
        )}

        {/* Records QR, bottom-right, only when the board is calm. It is an
            invitation to linger, so it must never compete with a scan landing,
            a wrong-race notice, or a heat being called — those are all someone
            needing to act right now. */}
        {config.showRecordsQr && !busy && !wrongRace && !justCalled && (
          <div style={{ position: "absolute", right: 0, bottom: vip ? 110 : 0 }}>
            <RecordsQr url={recordsUrl} accent={accent} />
          </div>
        )}
        {vip && <VipInfieldBanner names={vip.vipFirstNames} />}
      </div>
    </div>
  );
}

/* ── the session ───────────────────────────────────────── */

/**
 * The session, and — unmissably — which time is on screen.
 *
 * Racing check-in opens 30 minutes before the heat, so a bare time reads as the
 * green flag to anyone who has not been here before, and they wander off. The
 * screen names it outright.
 */
function CheckingIn({
  race,
  accent,
  justCalled,
  nowMs,
  windowMins,
  standby,
  checkedIn,
  total,
}: {
  race: NonNullable<ReturnType<typeof useTrackStatus>>["currentRaces"]["blue"];
  accent: string;
  justCalled: boolean;
  nowMs: number;
  /** Null = the countdown is switched off in admin. */
  windowMins: number | null;
  standby: boolean;
  checkedIn: number | null;
  total: number | null;
}) {
  if (!race) return null;
  // The cutoff for the track this heat actually runs on. trackName is what the
  // timing system called it ("Blue Track", "Mega") — nextLevelTarget matches
  // loosely and returns null for Mega and for Pro heats (nothing above Pro).
  const qualTarget = nextLevelTarget(race.trackName ?? "", race.raceType);
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        gap: 18,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 26 }}>
        <span
          className={justCalled ? "tv-eyebrow tv-blink" : "tv-eyebrow"}
          style={{ color: justCalled ? "#fff" : accent, fontSize: justCalled ? 46 : 36 }}
        >
          {justCalled ? "Your race is called" : "Now checking in"}
        </span>
        {/* Progress through the heat. Reassuring for a party watching their
            group arrive, and the number the desk actually wants. Hidden rather
            than guessed at when the roster could not be read. */}
        {checkedIn != null && total != null && total > 0 && (
          <span
            className="tv-display tv-num"
            style={{
              fontSize: 40,
              color: checkedIn >= total ? "#46d68c" : "rgba(245,236,238,0.75)",
              padding: "6px 20px",
              borderRadius: 999,
              border: `2px solid ${checkedIn >= total ? "#46d68c" : "rgba(245,236,238,0.28)"}`,
            }}
          >
            {checkedIn} of {total} checked in
          </span>
        )}
      </div>

      <div
        className="tv-display tv-rise"
        style={{
          fontSize: 210,
          color: "#fff",
          lineHeight: 0.9,
          textShadow: `0 0 70px ${withAlpha(accent, 0.55)}`,
        }}
      >
        Session {race.heatNumber}
      </div>

      <div className="tv-display" style={{ fontSize: 84, color: withAlpha("#f5ecee", 0.84) }}>
        {race.raceType}
      </div>

      {/* THE LAP TO BEAT, before they drive it (owner 2026-08-11: "you must beat X
          to make it to intermediate"). Same constants the level-up decision uses,
          so the number on this wall and the text a racer gets afterwards cannot
          disagree. Renders nothing on Mega — the combined circuit has no cutoffs
          and its laps do not count toward levels, so a target here would be a
          promise the system never keeps. */}
      {qualTarget && (
        <div
          style={{
            display: "inline-flex",
            alignItems: "baseline",
            gap: 16,
            alignSelf: "flex-start",
            padding: "8px 26px",
            borderRadius: 999,
            border: `2px solid ${withAlpha(accent, 0.6)}`,
            background: withAlpha(accent, 0.14),
          }}
        >
          <span style={{ fontSize: 32, color: "rgba(245,236,238,0.75)" }}>Beat</span>
          <span className="tv-display tv-num" style={{ fontSize: 52, color: "#fff" }}>
            {(qualTarget.ms / 1000).toFixed(3)}
          </span>
          <span style={{ fontSize: 32, color: "rgba(245,236,238,0.75)" }}>
            to qualify {qualTarget.level}
          </span>
        </div>
      )}

      {/* A COUNTDOWN, not a clock time (owner 2026-08-11). Counted from the
          moment the heat was first called — the instant the racer's phone
          buzzed — because "6:42 left" moves people and "check in by 7:45" does
          not. The window is per-screen config, defaulting to 8 minutes.

          It never shows a negative number or a hard zero: staff will still
          check somebody in at 8:01, so a board announcing they have missed it
          would be both unkind and untrue. It becomes an instruction instead. */}
      {windowMins != null && (
        <Countdown calledAt={race.calledAt} nowMs={nowMs} windowMins={windowMins} accent={accent} />
      )}

      {/* Only while nobody is scanning — that is exactly when we are waiting on
          people to walk up, and the one moment this line is useful. */}
      {standby && (
        <div style={{ fontSize: 40, color: "rgba(245,236,238,0.55)" }}>
          Have your e-ticket ready
        </div>
      )}
    </div>
  );
}

/**
 * "PROCEED TO THE RED BRIEFING ROOM" — the whole wall, for a minute after a send.
 *
 * This is the one moment the board is giving an instruction rather than reporting
 * state, so it takes the screen: a group standing at the desk has just been told
 * where to go verbally, and this is what they look up and confirm against. The
 * room's own colour carries it, so "red" and "blue" are unmistakable across a room
 * even to somebody who has not read a word.
 */
function ProceedToBriefing({ room, accent }: { room: "red" | "blue" | null; accent: string }) {
  // A room we could not resolve still gets an instruction — "see the desk" is
  // useless, but "your briefing room" at least moves them off the check-in point.
  const roomAccent = room ? TRACK_ACCENTS[room] : accent;
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        gap: 26,
      }}
    >
      <div
        aria-hidden
        className="tv-breathe"
        style={{
          position: "absolute",
          inset: 0,
          background: `radial-gradient(80% 70% at 50% 50%, ${withAlpha(roomAccent, 0.5)}, transparent 74%)`,
          zIndex: 0,
          pointerEvents: "none",
        }}
      />
      <div style={{ position: "relative", zIndex: 1, display: "grid", gap: 22 }}>
        <span className="tv-eyebrow tv-blink" style={{ color: "#fff", fontSize: 46 }}>
          You&rsquo;re checked in
        </span>
        <div
          className="tv-display tv-rise"
          style={{ fontSize: 104, color: "#fff", lineHeight: 0.98 }}
        >
          Proceed to the
        </div>
        {room ? (
          <div
            className="tv-display tv-rise"
            style={{
              fontSize: 176,
              lineHeight: 0.92,
              color: roomAccent,
              textShadow: `0 0 70px ${withAlpha(roomAccent, 0.75)}`,
            }}
          >
            {room.toUpperCase()} ROOM
          </div>
        ) : (
          <div className="tv-display tv-rise" style={{ fontSize: 140, color: "#fff" }}>
            briefing room
          </div>
        )}
        <p style={{ fontSize: 46, color: "rgba(245,236,238,0.72)", margin: 0 }}>
          Your safety briefing starts shortly — take a seat.
        </p>
      </div>
    </div>
  );
}

function Idle({ accent }: { accent: string }) {
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        gap: 22,
      }}
    >
      <div className="tv-display" style={{ fontSize: 128, color: "#fff", lineHeight: 0.95 }}>
        No session
        <br />
        checking in
      </div>
      <p style={{ fontSize: 44, color: "rgba(245,236,238,0.6)", margin: 0 }}>
        The time on your e-ticket is your check-in cut-off — be checked in by then.
      </p>
      <div
        aria-hidden
        style={{
          width: 240,
          height: 5,
          borderRadius: 3,
          background: `linear-gradient(90deg, ${accent}, ${withAlpha(accent, 0)})`,
        }}
      />
    </div>
  );
}

/* ── the Mega check-in feed ───────────────────────────────────────────── */

/**
 * A whole board given to WHO IS CHECKED IN, for Mega days.
 *
 * The session context survives as one slim header; everything else is names,
 * big, wrapping across the full width, newest arriving with a rise and nobody
 * ever leaving. A racer walks up, scans, and finds themselves on a wall that
 * already lists their whole heat.
 */
function CheckinFeed({
  accent,
  race,
  scans,
  checkedIn,
  total,
  showRecordsQr,
}: {
  accent: string;
  race: { heatNumber: number; raceType: string } | null;
  scans: {
    id: string;
    firstName?: string;
    atMs: number;
    headsockDue?: boolean;
    birthday?: boolean;
  }[];
  checkedIn: number | null;
  total: number | null;
  showRecordsQr: boolean;
}) {
  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden", background: "#000418" }}>
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          background: `radial-gradient(80% 70% at 50% 20%, ${withAlpha(accent, 0.35)}, transparent 72%)`,
        }}
      />
      <div
        aria-hidden
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: 16,
          background: accent,
          boxShadow: `0 0 60px ${accent}`,
        }}
      />

      <div
        style={{
          position: "absolute",
          inset: `${PAD_Y}px ${PAD_X}px`,
          display: "flex",
          flexDirection: "column",
          gap: 30,
        }}
      >
        <header style={{ display: "flex", alignItems: "baseline", gap: 28 }}>
          <span className="tv-display" style={{ fontSize: 58, color: accent }}>
            Checked in
          </span>
          {race && (
            <span className="tv-display" style={{ fontSize: 40, color: "rgba(245,236,238,0.75)" }}>
              Mega · Session {race.heatNumber} · {race.raceType}
            </span>
          )}
          <span
            style={{ marginLeft: "auto", display: "inline-flex", gap: 24, alignItems: "center" }}
          >
            {/* Live clock for the heat on track — the feed board is the busiest
                wall on a Mega night and the first place people look for it. */}
            <LiveSessionChip track="mega" accent={accent} />
            {checkedIn != null && total != null && total > 0 && (
              <span
                className="tv-display tv-num"
                style={{
                  fontSize: 44,
                  color: checkedIn >= total ? "#46d68c" : "#fff",
                }}
              >
                {checkedIn} of {total}
              </span>
            )}
          </span>
        </header>

        {/* Bottom-right has room even with the strip below it (owner) — the
            waiting crowd at check-in is exactly the audience for lap records. */}
        {showRecordsQr && (
          <div style={{ position: "absolute", right: PAD_X, bottom: 130, zIndex: 1 }}>
            <RecordsQr url={recordsUrl} accent={accent} />
          </div>
        )}

        <ActionStrip scans={scans} accent={accent} />

        {scans.length === 0 ? (
          <div
            style={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <span className="tv-display" style={{ fontSize: 72, color: "rgba(245,236,238,0.5)" }}>
              Scan to check in
            </span>
          </div>
        ) : (
          <div
            style={{
              flex: 1,
              display: "flex",
              flexWrap: "wrap",
              alignContent: "flex-start",
              gap: 20,
            }}
          >
            {scans.map((s, i) => (
              <span
                key={s.id}
                // A birthday pill wears its own glowing lights (owner 2026-08-11)
                // — the animated halo has to be a class, box-shadow cannot
                // animate inline.
                className={`tv-display tv-rise${s.birthday ? " tv-bday-glow" : ""}`}
                style={{
                  fontSize: scans.length > 24 ? 44 : scans.length > 12 ? 54 : 66,
                  color: "#fff",
                  padding: "14px 32px",
                  borderRadius: 999,
                  border: s.birthday
                    ? `2px solid ${BIRTHDAY_PINK}`
                    : `2px solid ${withAlpha(accent, i === 0 ? 0.95 : 0.45)}`,
                  background: s.birthday
                    ? withAlpha(BIRTHDAY_PINK, 0.3)
                    : withAlpha(accent, i === 0 ? 0.35 : 0.14),
                  boxShadow:
                    !s.birthday && i === 0 ? `0 0 44px ${withAlpha(accent, 0.65)}` : undefined,
                  whiteSpace: "nowrap",
                }}
              >
                {s.firstName || "Racer"}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The feed board's bottom edge: what just happened, said to the person it
 * happened to (owner 2026-08-11: "use the bottom to flash headsock due and
 * welcome Racer, etc."). The newest scan gets a strip for a few seconds —
 * "WELCOME, MARCUS", or amber "AVA — HEADSOCK DUE · grab yours at the desk"
 * when a sock is waiting. Keyed to the scan id, so it plays once per person.
 *
 * (Racer photos belong here eventually, but the event rail is polled every two
 * seconds by every screen — base64 portraits would bloat it badly, so pictures
 * need their own fetch path before they ride this strip.)
 */
function ActionStrip({
  scans,
  accent,
}: {
  scans: {
    id: string;
    firstName?: string;
    atMs: number;
    headsockDue?: boolean;
    birthday?: boolean;
  }[];
  accent: string;
}) {
  const newest = scans[0];
  if (!newest) return null;
  const sock = newest.headsockDue === true;
  const color = sock ? "#f0b341" : accent;
  const name = (newest.firstName || "Racer").toUpperCase();
  return (
    <div
      key={newest.id}
      className="tv-rise"
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 0,
        padding: "22px 34px",
        display: "flex",
        alignItems: "center",
        gap: 22,
        background: "rgba(0,4,24,0.92)",
        borderTop: `4px solid ${color}`,
      }}
    >
      <span
        aria-hidden
        className="tv-blink"
        style={{
          width: 16,
          height: 16,
          borderRadius: "50%",
          background: color,
          boxShadow: `0 0 18px ${color}`,
        }}
      />
      <span className="tv-display" style={{ fontSize: 46, color }}>
        {sock ? `${name} — headsock due` : `Welcome, ${name}`}
      </span>
      {sock && (
        <span style={{ fontSize: 32, color: "rgba(245,236,238,0.75)" }}>
          Grab yours at the desk
        </span>
      )}
    </div>
  );
}

/* ── delay ────────────────────────────────────────────────────────────── */

/**
 * On time, or how far behind — sitting directly under the track name.
 *
 * A racer reads "Blue Track" and immediately wants to know whether it is
 * running late; putting the two at opposite ends of the screen made them look
 * like unrelated facts. Amber and blinking when behind, so it is noticed
 * without being alarming.
 */
function DelayLine({ delay }: { delay: DelayInfo | null }) {
  if (!delay) return null;
  const late = delay.delayMinutes > 0;
  const color = late ? "#f0b341" : "#46d68c";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 6 }}>
      <span
        aria-hidden
        className={late ? "tv-blink" : undefined}
        style={{ width: 12, height: 12, borderRadius: "50%", background: color }}
      />
      <span className="tv-display" style={{ fontSize: 34, color }}>
        {late
          ? `Running ${delay.delayFormatted || `${delay.delayMinutes} min`} behind`
          : "Running on time"}
      </span>
    </div>
  );
}

interface DelayInfo {
  delayMinutes: number;
  delayFormatted: string;
}

/** Match the track's row in the status feed by name ("Blue Track" → blue). */
function findDelay(
  tracks: { trackName: string; delayMinutes: number; delayFormatted: string }[] | undefined,
  track: TrackKey,
): DelayInfo | null {
  if (!tracks) return null;
  const hit = tracks.find((t) => new RegExp(`\b${track}\b`, "i").test(t.trackName));
  if (!hit) return null;
  return { delayMinutes: hit.delayMinutes ?? 0, delayFormatted: hit.delayFormatted ?? "" };
}

/** mm:ss, never negative. */
function fmtCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

function Countdown({
  calledAt,
  nowMs,
  windowMins,
  accent,
}: {
  calledAt: string | null | undefined;
  nowMs: number;
  windowMins: number;
  accent: string;
}) {
  const calledMs = calledAt ? Date.parse(calledAt) : NaN;
  // No call time means no countdown — better to say nothing than to count down
  // from a moment we are guessing at.
  if (!Number.isFinite(calledMs)) return null;

  const remaining = calledMs + windowMins * 60_000 - nowMs;
  const expired = remaining <= 0;
  // Amber inside the last minute: urgent without being a failure state.
  const color = expired ? "#f0b341" : remaining < 60_000 ? "#f0b341" : "#fff";

  return (
    <div style={{ marginTop: 18, display: "flex", alignItems: "baseline", gap: 24 }}>
      <span className="tv-display" style={{ fontSize: 54, color: accent }}>
        {expired ? "Check in now" : "Check in within"}
      </span>
      {!expired && (
        <span
          className={`tv-display tv-num${remaining < 60_000 ? " tv-blink" : ""}`}
          style={{ fontSize: 96, color, textShadow: `0 0 44px ${withAlpha(accent, 0.5)}` }}
        >
          {fmtCountdown(remaining)}
        </span>
      )}
      {expired && (
        <span style={{ fontSize: 42, color: "rgba(245,236,238,0.75)" }}>see the desk</span>
      )}
    </div>
  );
}

/**
 * One bright pulse across the whole screen when somebody checks in.
 *
 * Names appearing on a rail is information; a screen that visibly REACTS is
 * acknowledgement — the racer knows the scan took, and the group watching sees
 * their person land (owner 2026-08-11). Finite, unmounts itself, transform and
 * opacity only.
 */
function ScanFlash({ accent }: { accent: string }) {
  return (
    <div
      aria-hidden
      className="tv-scan-flash"
      style={{
        position: "absolute",
        inset: 0,
        background: `radial-gradient(70% 60% at 50% 80%, ${withAlpha(accent, 0.75)}, transparent 72%)`,
        pointerEvents: "none",
        zIndex: 4,
      }}
    />
  );
}

/* ── the live rail ────────────────────────────────────────────────────── */

/**
 * Who just checked in — several at once.
 *
 * Racers scan in bursts: a party of eight is through the desk in twenty
 * seconds. One full-screen welcome per person would queue over a minute of
 * takeovers and hide the session, so names land HERE, side by side, newest
 * first, while the session information stays on screen the whole time. Each
 * chip animates in on its own so an arriving racer still sees their moment.
 */
function ScanRail({
  scans,
  accent,
  raised,
  nowMs,
}: {
  scans: { id: string; firstName?: string; atMs: number; birthday?: boolean }[];
  accent: string;
  raised: boolean;
  nowMs: number;
}) {
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        // Sits above the VIP banner when both are up.
        bottom: raised ? 96 : 0,
        display: "flex",
        alignItems: "center",
        gap: 18,
        flexWrap: "wrap",
      }}
    >
      <span
        className="tv-eyebrow"
        style={{ color: "rgba(245,236,238,0.55)", fontSize: 26, letterSpacing: "0.24em" }}
      >
        Checked in
      </span>
      {scans.map((s, i) => {
        // The person who JUST scanned is the one looking at the screen, so for
        // a few seconds their name is bigger and lit; the rest are context.
        const fresh = i === 0 && nowMs - s.atMs < 6_000;
        return (
          <span
            key={s.id}
            className={`tv-display tv-rise${s.birthday ? " tv-bday-glow" : fresh ? " tv-breathe" : ""}`}
            style={{
              fontSize: fresh ? 64 : 46,
              color: "#fff",
              padding: fresh ? "14px 34px" : "12px 26px",
              borderRadius: 999,
              border: s.birthday
                ? `2px solid ${BIRTHDAY_PINK}`
                : `2px solid ${withAlpha(accent, fresh ? 0.95 : 0.55)}`,
              background: s.birthday
                ? withAlpha(BIRTHDAY_PINK, 0.32)
                : withAlpha(accent, fresh ? 0.38 : 0.16),
              boxShadow: !s.birthday && fresh ? `0 0 46px ${withAlpha(accent, 0.7)}` : undefined,
              // Newest first, and each one arrives a beat after the last so a
              // burst of scans reads as a wave rather than a jump.
              animationDelay: `${i * 90}ms`,
              whiteSpace: "nowrap",
            }}
          >
            {s.firstName || "Racer"}
          </span>
        );
      })}
    </div>
  );
}

/* ── wrong race ───────────────────────────────────────────────────────── */

/**
 * "That is not this heat."
 *
 * The failure this prevents: a racer scans, nothing visibly happens, and they
 * walk off believing they are checked in — then turn up for a heat that has
 * already run. Naming them, saying plainly that this is not their race, and
 * telling them when theirs is turns a silent dead end into an instruction.
 *
 * Amber rather than red. They have not done anything wrong.
 */
function WrongRaceNotice({ event }: { event: { firstName?: string; theirRaceLabel?: string } }) {
  const amber = "#f0b341";
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 0,
        padding: "26px 34px",
        background: "rgba(30,18,0,0.92)",
        borderTop: `4px solid ${amber}`,
        display: "flex",
        alignItems: "center",
        gap: 26,
      }}
    >
      <IconAlertTriangleFilled size={64} color={amber} />
      <div>
        <div className="tv-display" style={{ fontSize: 52, color: amber }}>
          {event.firstName ? `${event.firstName} — that’s not this heat` : "That’s not this heat"}
        </div>
        <div style={{ fontSize: 36, color: "rgba(245,236,238,0.8)", marginTop: 6 }}>
          {event.theirRaceLabel
            ? `Your race is ${event.theirRaceLabel}. Come back when it’s called.`
            : "See the desk and we’ll get you sorted."}
        </div>
      </div>
    </div>
  );
}

/* ── VIP ──────────────────────────────────────────────────────────────── */

/**
 * VIP parties do not go where everyone else goes — they head to the in-field
 * (owner 2026-08-11: "head to the in-field as a VIP", not "the VIP room in the
 * in-field"). One destination, named the way staff name it on the floor.
 *
 * Names them when we have names, because "Sarah — head to the in-field" is
 * unmistakably for them, where a generic banner is something a VIP party will
 * assume is meant for somebody else.
 */
function VipInfieldBanner({ names }: { names: string[] }) {
  const gold = "#d4af37";
  const who =
    names.length === 0
      ? "VIP party"
      : names.length <= 3
        ? `${names.join(", ")} — VIP`
        : `${names.slice(0, 2).join(", ")} + ${names.length - 2} more — VIP`;
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 0,
        padding: "22px 32px",
        display: "flex",
        alignItems: "center",
        gap: 22,
        background: "rgba(0,4,24,0.9)",
        borderTop: `3px solid ${gold}`,
      }}
    >
      <span
        aria-hidden
        className="tv-blink"
        style={{
          width: 16,
          height: 16,
          borderRadius: "50%",
          background: gold,
          boxShadow: `0 0 18px ${gold}`,
        }}
      />
      <span className="tv-display" style={{ fontSize: 44, color: gold }}>
        {who} — head to the in-field
      </span>
    </div>
  );
}
