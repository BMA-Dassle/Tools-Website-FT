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
import type { SceneProps } from "../director/types";

const PAD_X = 96;
const PAD_Y = 54;

export function SceneRaceCheckin({ feed, config }: SceneProps) {
  const status = useTrackStatus();
  const megaEnabled = status?.trackStatus.megaTrackEnabled ?? false;

  const screenTrack = trackFromResourceIds(config.scope.resourceIds);
  const track = effectiveTrack(screenTrack, megaEnabled) ?? "blue";
  const accent = TRACK_ACCENTS[track];

  const race = status?.currentRaces?.[track] ?? null;
  const delay = findDelay(status?.trackStatus.tracks, track);

  // VIPs DO NOT SCAN IN — they are met and escorted (owner 2026-08-11). So the
  // banner is driven by who is entered on the heat, computed server-side from
  // the roster, never by anybody swiping a licence at the desk.
  const vip = feed?.raceCheckin?.vipOnHeat ? feed.raceCheckin : null;

  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden", background: "#000418" }}>
      {/* Track identity wash — the screen should read as "Blue" from the door. */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          background: `radial-gradient(70% 60% at 50% 30%, ${withAlpha(accent, 0.32)}, transparent 70%)`,
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
        {/* ── track + delay ─────────────────────────────────────────────── */}
        <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
            <span
              aria-hidden
              style={{
                width: 22,
                height: 22,
                borderRadius: "50%",
                background: accent,
                boxShadow: `0 0 26px ${accent}`,
              }}
            />
            <span className="tv-display" style={{ fontSize: 46, color: "#fff" }}>
              {TRACK_LABELS[track]}
            </span>
          </div>
          <DelayChip delay={delay} />
        </header>

        {race ? <CheckingIn race={race} accent={accent} /> : <Idle accent={accent} track={track} />}

        {vip && <VipInfieldBanner names={vip.vipFirstNames} />}
      </div>
    </div>
  );
}

/* ── the session ──────────────────────────────────────────────────────── */

function CheckingIn({
  race,
  accent,
}: {
  race: NonNullable<ReturnType<typeof useTrackStatus>>["currentRaces"]["blue"];
  accent: string;
}) {
  if (!race) return null;
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
      <div className="tv-eyebrow" style={{ color: accent, fontSize: 34 }}>
        Now checking in
      </div>

      <div
        className="tv-display tv-rise"
        style={{
          fontSize: 148,
          color: "#fff",
          textShadow: `0 0 60px ${withAlpha(accent, 0.6)}`,
          lineHeight: 0.94,
        }}
      >
        Session {race.heatNumber}
      </div>

      <div className="tv-display" style={{ fontSize: 72, color: withAlpha("#f5ecee", 0.86) }}>
        {race.raceType}
      </div>

      {/* THE POINT OF THE SCREEN. Names the time it is showing, so nobody reads
          a check-in slot as a green flag. */}
      <div
        className="tv-glass"
        style={{
          marginTop: 12,
          padding: "26px 34px",
          borderLeft: `8px solid ${accent}`,
          maxWidth: 1180,
        }}
      >
        <div
          className="tv-display"
          style={{ fontSize: 52, color: "#fff", letterSpacing: "0.02em" }}
        >
          This is your check-in time
        </div>
        <div style={{ fontSize: 38, color: "rgba(245,236,238,0.72)", marginTop: 10 }}>
          Check in now — your race starts at{" "}
          <span className="tv-num" style={{ color: "#fff", fontWeight: 700 }}>
            {fmtTime(race.scheduledStart)}
          </span>
          . Please have your e-ticket ready.
        </div>
      </div>
    </div>
  );
}

function Idle({ accent, track }: { accent: string; track: TrackKey }) {
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        gap: 20,
      }}
    >
      <div className="tv-eyebrow" style={{ color: accent, fontSize: 34 }}>
        {TRACK_LABELS[track]} check-in
      </div>
      <div className="tv-display" style={{ fontSize: 112, color: "#fff", lineHeight: 0.96 }}>
        No session
        <br />
        checking in yet
      </div>
      <p style={{ fontSize: 42, color: "rgba(245,236,238,0.7)", maxWidth: 1200, margin: 0 }}>
        Check-in opens {RACING_CHECKIN_LEAD_MIN} minutes before your race. Watch this screen for
        your session.
      </p>
    </div>
  );
}

/* ── delay ────────────────────────────────────────────────────────────── */

function DelayChip({ delay }: { delay: DelayInfo | null }) {
  if (!delay) return null;
  const late = delay.delayMinutes > 0;
  const color = late ? "#f0b341" : "#46d68c";
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 14,
        padding: "14px 26px",
        borderRadius: 999,
        border: `2px solid ${withAlpha(color, 0.5)}`,
        background: withAlpha(color, 0.12),
      }}
    >
      <span
        aria-hidden
        className={late ? "tv-blink" : undefined}
        style={{ width: 14, height: 14, borderRadius: "50%", background: color }}
      />
      <span className="tv-display" style={{ fontSize: 34, color }}>
        {late ? `Running ${delay.delayFormatted || `${delay.delayMinutes} min`} behind` : "On time"}
      </span>
    </div>
  );
}

interface DelayInfo {
  delayMinutes: number;
  delayFormatted: string;
}

function findDelay(
  tracks: { trackName: string; delayMinutes: number; delayFormatted: string }[] | undefined,
  track: TrackKey,
): DelayInfo | null {
  if (!tracks) return null;
  const hit = tracks.find((t) => new RegExp(`\\b${track}\\b`, "i").test(t.trackName));
  if (!hit) return null;
  return { delayMinutes: hit.delayMinutes ?? 0, delayFormatted: hit.delayFormatted ?? "" };
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
