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
import {
  TRACK_ACCENTS,
  TRACK_LABELS,
  effectiveTrack,
  trackFromResourceIds,
  type TrackKey,
} from "../track";
import { recentScans, eventInScope } from "../director/schedule";
import { demoCurrentRace } from "../demo";
import type { SceneProps } from "../director/types";

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

/** How long a wrong-race notice stays up. Long enough to read twice. */
const WRONG_RACE_SHOW_MS = 12_000;

/** How long a newly-called heat gets the attention treatment. Long enough for
 *  someone at the far end of the arcade to look up and read it. */
const JUST_CALLED_MS = 45_000;

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

  const accent = TRACK_ACCENTS[track];

  // races-current reports nothing overnight on purpose, so a stale "Now
  // Checking In" cannot sit on a wall until morning. `?demo=race` substitutes a
  // fabricated session so the board can be reviewed outside operating hours —
  // deliberate, client-only, and gone on the next reload.
  const race =
    status?.currentRaces?.[track] ??
    (demo === "race" ? demoCurrentRace(nowMs, TRACK_LABELS[track]) : null);
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
    config.scope.resourceIds,
    SCAN_RAIL_WINDOW_MS,
    SCAN_RAIL_LIMIT,
  );
  // A heat has JUST been called. This is the moment the board has to be seen
  // from across the room — it is the only warning a racer gets that their race
  // is up, and someone half-watching from the arcade needs to catch it.
  const calledAgoMs = race?.calledAt ? nowMs - Date.parse(race.calledAt) : Number.POSITIVE_INFINITY;
  const justCalled =
    Number.isFinite(calledAgoMs) && calledAgoMs >= 0 && calledAgoMs < JUST_CALLED_MS;

  // Quiet for a while ⇒ standby: clear the rail and give the session the wall.
  const busy = scans.length > 0 && nowMs - scans[0].atMs < STANDBY_AFTER_MS;

  // Somebody scanned for a heat that is not this one. Amber, not red: they have
  // not done anything wrong, they are just early or late, and the screen's job
  // is to tell them when to come back.
  const wrongRace = (feed?.kioskEvents ?? [])
    .filter(
      (e) =>
        e.kind === "racer-wrong-race" &&
        nowMs - e.atMs < WRONG_RACE_SHOW_MS &&
        nowMs - e.atMs > -5_000 &&
        eventInScope(e, config.scope.resourceIds),
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

      {/* Track identity wash — the screen should read as "Blue" from the door. */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          background: `radial-gradient(70% 60% at 50% 40%, ${withAlpha(accent, 0.3)}, transparent 72%)`,
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
            <div className="tv-eyebrow" style={{ color: "rgba(245,236,238,0.75)", fontSize: 30 }}>
              {TRACK_LABELS[track]}
            </div>
            <DelayLine delay={delay} />
          </div>
        </header>

        {race ? (
          <CheckingIn
            race={race}
            accent={accent}
            justCalled={justCalled}
            standby={!busy}
            checkedIn={feed?.raceCheckin?.checkedIn ?? null}
            total={feed?.raceCheckin?.total ?? null}
          />
        ) : (
          <Idle accent={accent} />
        )}

        {wrongRace && <WrongRaceNotice event={wrongRace} />}
        {busy && !wrongRace && <ScanRail scans={scans} accent={accent} raised={!!vip} />}
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
  standby,
  checkedIn,
  total,
}: {
  race: NonNullable<ReturnType<typeof useTrackStatus>>["currentRaces"]["blue"];
  accent: string;
  justCalled: boolean;
  standby: boolean;
  checkedIn: number | null;
  total: number | null;
}) {
  if (!race) return null;
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

      {/* The time on the e-ticket is the DEADLINE, so it is stated as one. */}
      <div style={{ marginTop: 18, display: "flex", alignItems: "baseline", gap: 20 }}>
        <span className="tv-display" style={{ fontSize: 54, color: accent }}>
          Check in by
        </span>
        <span
          className="tv-display tv-num"
          style={{ fontSize: 72, color: "#fff", textShadow: `0 0 40px ${withAlpha(accent, 0.5)}` }}
        >
          {fmtTime(race.scheduledStart)}
        </span>
      </div>

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
}: {
  scans: { id: string; firstName?: string }[];
  accent: string;
  raised: boolean;
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
      {scans.map((s, i) => (
        <span
          key={s.id}
          className="tv-display tv-rise"
          style={{
            fontSize: 46,
            color: "#fff",
            padding: "12px 26px",
            borderRadius: 999,
            border: `2px solid ${withAlpha(accent, 0.55)}`,
            background: withAlpha(accent, 0.16),
            // Newest first, and each one arrives a beat after the last so a
            // burst of scans reads as a wave rather than a jump.
            animationDelay: `${i * 90}ms`,
            whiteSpace: "nowrap",
          }}
        >
          {s.firstName || "Racer"}
        </span>
      ))}
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

function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  return new Date(t).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
  });
}
