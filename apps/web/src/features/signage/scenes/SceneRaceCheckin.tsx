"use client";

/**
 * The track check-in screen: who is checking in right now, and what time.
 *
 * THE ONE THING THIS SCREEN MUST GET RIGHT is that the time on it is the
 * CHECK-IN time, not the green flag. Racing check-in opens 30 minutes ahead of a
 * race (RACING_CHECKIN_LEAD_MIN), so a bare time on a wall reads as "your race
 * is at 7:45" to a guest who has never been here before — and they wander off.
 * The copy says which is which in as many words.
 *
 * DATA COMES FROM THE SAME PLACE THE WEBSITE'S DOES. `useTrackStatus()` polls
 * /api/track-status and /api/pandora/races-current?prefer=cache — the exact two
 * endpoints behind the e-tickets, the confirmation pages and the kiosk race
 * hub. That is deliberate: a wall that disagrees with the ticket in a guest's
 * hand is worse than no wall. Nothing here re-derives a session or a delay.
 */
import { useTrackStatus } from "@/hooks/useTrackStatus";
import { RACING_CHECKIN_LEAD_MIN } from "~/features/kiosk/checkin/itinerary";
import { withAlpha } from "../color";
import {
  TRACK_ACCENTS,
  TRACK_LABELS,
  effectiveTrack,
  trackFromResourceIds,
  type TrackKey,
} from "../track";
import { recentScans } from "../director/schedule";
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

export function SceneRaceCheckin({ feed, nowMs, config }: SceneProps) {
  const status = useTrackStatus();
  const megaEnabled = status?.trackStatus.megaTrackEnabled ?? false;

  const screenTrack = trackFromResourceIds(config.scope.resourceIds);
  const track = effectiveTrack(screenTrack, megaEnabled) ?? "blue";
  const accent = TRACK_ACCENTS[track];

  const race = status?.currentRaces?.[track] ?? null;
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
  // Quiet for a while ⇒ standby: clear the rail and give the session the wall.
  const busy = scans.length > 0 && nowMs - scans[0].atMs < STANDBY_AFTER_MS;

  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden", background: "#000418" }}>
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
        {/* Track and delay, small. They are context, not the message. */}
        <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <span
              aria-hidden
              style={{
                width: 18,
                height: 18,
                borderRadius: "50%",
                background: accent,
                boxShadow: `0 0 24px ${accent}`,
              }}
            />
            <span className="tv-eyebrow" style={{ color: "rgba(245,236,238,0.75)", fontSize: 30 }}>
              {TRACK_LABELS[track]}
            </span>
          </div>
          <DelayChip delay={delay} />
        </header>

        {race ? (
          <CheckingIn race={race} accent={accent} standby={!busy} />
        ) : (
          <Idle accent={accent} />
        )}

        {busy && <ScanRail scans={scans} accent={accent} raised={!!vip} />}
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
  standby,
}: {
  race: NonNullable<ReturnType<typeof useTrackStatus>>["currentRaces"]["blue"];
  accent: string;
  standby: boolean;
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
      <div className="tv-eyebrow" style={{ color: accent, fontSize: 36 }}>
        Now checking in
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

      <div style={{ marginTop: 18, display: "flex", alignItems: "baseline", gap: 24 }}>
        <span className="tv-display" style={{ fontSize: 54, color: accent }}>
          This is your check-in time
        </span>
        <span className="tv-num" style={{ fontSize: 44, color: "rgba(245,236,238,0.7)" }}>
          Race {fmtTime(race.scheduledStart)}
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
        Check-in opens {RACING_CHECKIN_LEAD_MIN} minutes before your race.
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

/** On time, or how far behind. Small and in the corner: it matters, but it is
 *  not what somebody walking up to the desk needs first. */
function DelayChip({ delay }: { delay: DelayInfo | null }) {
  if (!delay) return null;
  const late = delay.delayMinutes > 0;
  const color = late ? "#f0b341" : "#46d68c";
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "10px 22px",
        borderRadius: 999,
        border: `2px solid ${withAlpha(color, 0.45)}`,
        background: withAlpha(color, 0.1),
      }}
    >
      <span
        aria-hidden
        className={late ? "tv-blink" : undefined}
        style={{ width: 12, height: 12, borderRadius: "50%", background: color }}
      />
      <span className="tv-display" style={{ fontSize: 30, color }}>
        {late ? `${delay.delayFormatted || `${delay.delayMinutes} min`} behind` : "On time"}
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

/* ── VIP ──────────────────────────────────────────────────────────────── */

/**
 * VIP parties do not go where everyone else goes — they are met in the VIP room
 * in the in-field. The wording matches the SMS they already received
 * (VIP_WHERE_SMS in the check-in alerts cron), so the screen and the text on
 * their phone say the same thing.
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
        {who} — head to the VIP room in the in-field
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
