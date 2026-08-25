"use client";

/**
 * WHERE EVERY SESSION IS — one component, every screen that shows it.
 *
 * THIS EXISTS BECAUSE THEY DRIFTED (owner 2026-08-24: "why don't they all share
 * a shared type system?" / "they need to not drift"). Three scenes had grown
 * three renderers for the identical six rows — the pit sign's `Idle`, the
 * briefing room's `IdleStageRail`, the camera board's `RailPane` — each with its
 * own tone map and its own type scale. So a colour added to one wall never
 * reached the other two, and a briefing TV ended up with none of the treatment
 * its camera board had.
 *
 * THERE WAS A FOURTH, and it was missed: the Mega SESSION TRACKER, which is a
 * whole pit sign rather than a pane and so did not look like one of the rails
 * (owner 2026-08-25: "did mega session tracker get the updates we did to the
 * other boards?"). It had kept the fixed-pixel type this file was warned off,
 * a second tone map, its own M:SS, and none of the numbers the walls gained —
 * the time of day, the check-in clock, the briefing verdict, who is going
 * straight back out. It renders here now like everything else; only its
 * full-screen chrome is its own.
 *
 * `buildStageRail` already made the surfaces agree on WHAT to say and
 * `briefVerdict` on what to advise. This is the third leg: how it LOOKS. One
 * tone map, one scale per density, one header, one back-to-back panel.
 *
 * ─── TWO DENSITIES, AND ONLY TWO ─────────────────────────────────────────
 *
 *   wall     pit signs and briefing rooms — big screens read across a building
 *   compact  camera boards, whose rail is 58% of a small panel
 *
 * Compact trims exactly three things and NOTHING structural: the word
 * "Session" (the row label already says what it is), the level's long form
 * (`shortLevel`), and any row detail that has a short form. It never drops a
 * row, a colour or the verdict — a screen showing five of six stages would put
 * the walls back to describing different nights.
 */
import type { CSSProperties } from "react";
import { withAlpha } from "../color";
import { shortLevel, type StageRow } from "../briefing/stage-rail";
import { TRACK_ACCENTS } from "../track";
import type { TvFeed } from "../types";

export type RailDensity = "wall" | "compact";

/** ONE tone map. The only place a rail row's colour is decided. */
const TONE: Record<StageRow["tone"], string> = {
  none: "rgba(245,236,238,0.62)",
  good: "#46d68c",
  warn: "#f0b341",
  alert: "#ff4d4d",
};

const GOOD = "#46d68c";
const WARN = "#f0b341";

/**
 * THE STAGE LABEL NEVER WRAPS (owner 2026-08-25: "I don't like that room drops
 * below blue on all these" — CHECKING IN and BLUE ROOM were breaking onto a
 * second line, which pushes that one row taller and knocks the whole rail out
 * of rhythm).
 *
 * MEASURED IN `em`, NOT `vw`, AND THAT IS THE POINT. The column was `11vw`,
 * which is a guess about a viewport pretending to be a guess about type: at
 * 1080p that is 211px holding a 36.5px label, and the longest label in the set
 * — "CHECKING IN", 11 characters of Exo 2 Bold with 0.08em tracking — measures
 * about 7.25em, or 264px. It wrapped on a real television, not just in a
 * windowed preview.
 *
 * `flex-basis` in `em` resolves against THIS span's own font-size, which is the
 * density's clamped label size. So the column tracks the type automatically:
 * change a clamp, or add a density, and the column follows with no second
 * number to keep in step. 9em leaves headroom over the 7.25em worst case for
 * the fallback face, which is wider than Exo 2 if the webfont has not landed.
 *
 * The width is shared by both densities on purpose — it is a property of the
 * longest word in `StageLabel`, not of the screen. A NEW LABEL LONGER THAN
 * "CHECKING IN" NEEDS THIS NUMBER CHECKED; the test pins the nowrap, not the
 * arithmetic.
 */
const LABEL_COL = { flex: "0 0 9em", whiteSpace: "nowrap" } as const;

interface Scale {
  pad: string;
  gap: string;
  rowGap: string;
  label: string;
  value: string;
  type: string;
  detail: string;
  track: string;
  chip: string;
  clock: string;
  clockCap: string;
  b2bHead: string;
  b2bName: string;
  /** The "→ RED ROOM" pill beside a lane row's session. */
  pill: string;
  pillPad: string;
  edge: number;
}

/**
 * ONE SCALE PER DENSITY, so a size cannot be nudged on one screen alone.
 *
 * ⚠️ EVERY SIZE IS VIEWPORT-RELATIVE, AND THAT IS NOT A STYLE CHOICE. These are
 * 1080p wall televisions; a windowed preview on a laptop is the exception, not
 * the target. The first cut of this table used fixed pixels lifted from a
 * windowed screenshot and the camera boards rendered at their floor — unreadable
 * across a room (owner 2026-08-24: "everything got extreme small on the camera
 * TVs, I warned about this!").
 *
 * COMPACT IS NOT SMALL TYPE. It is FEWER WORDS — no "Session", short levels,
 * short details — at type only a step below the wall boards. The camera rail is
 * 58% of its screen where a wall rail is all of one, so the step is the width
 * it lost, nothing more. The `min` in each clamp is a floor for a shrunken
 * preview window, never the size a TV should land on.
 */
const SCALE: Record<RailDensity, Scale> = {
  wall: {
    pad: "2.4vh 2.2vw",
    gap: "1.8vh",
    rowGap: "1vh",
    label: "clamp(18px, 1.9vw, 38px)",
    value: "clamp(28px, 3.1vw, 62px)",
    type: "clamp(16px, 1.7vw, 34px)",
    detail: "clamp(17px, 1.85vw, 37px)",
    track: "clamp(22px, 2.4vw, 48px)",
    chip: "clamp(16px, 1.7vw, 34px)",
    clock: "clamp(44px, 6vw, 120px)",
    clockCap: "clamp(14px, 1.5vw, 30px)",
    b2bHead: "clamp(16px, 1.7vw, 34px)",
    b2bName: "clamp(20px, 2.2vw, 44px)",
    pill: "clamp(15px, 1.6vw, 32px)",
    pillPad: "0.25vh 0.9vw",
    edge: 7,
  },
  compact: {
    pad: "2.6vh 2vw",
    gap: "2vh",
    rowGap: "0.9vh",
    label: "clamp(15px, 1.55vw, 31px)",
    value: "clamp(22px, 2.5vw, 50px)",
    type: "clamp(13px, 1.4vw, 28px)",
    detail: "clamp(14px, 1.55vw, 31px)",
    track: "clamp(18px, 2vw, 40px)",
    chip: "clamp(13px, 1.4vw, 28px)",
    clock: "clamp(38px, 5.2vw, 104px)",
    clockCap: "clamp(13px, 1.3vw, 26px)",
    b2bHead: "clamp(13px, 1.4vw, 28px)",
    b2bName: "clamp(17px, 1.8vw, 36px)",
    pill: "clamp(12px, 1.3vw, 26px)",
    pillPad: "0.2vh 0.7vw",
    edge: 5,
  },
};

export interface StageRailViewProps {
  rows: StageRow[];
  density: RailDensity;
  /** The track's own colour — the left edge, the eyebrow and the live clock. */
  accent: string;
  /** "Blue Track". Omitted on a screen whose chrome already names the track. */
  trackLabel?: string;
  /**
   * IS THE TRACK RUNNING TO TIME — "On Time" / "+6 late" (owner 2026-08-24:
   * "we're missing the delay status on these screens"). Passed as finished
   * words so this component never becomes a second opinion about lateness;
   * `late` only decides the colour.
   */
  punctual?: { label: string; late: boolean } | null;
  /** Time left on the race out there, already formatted. */
  clock?: { text: string; caption: string; paused?: boolean } | null;
  /** Racers going straight back out — the feed's returning roster. */
  returning?: TvFeed["checkinReturning"];
  /** Renders a track key as a short name, for the back-to-back destinations. */
  trackShort?: (track: string) => string;
  /**
   * THE TIME OF DAY (owner 2026-08-24: "I'd like to have the current time on
   * each screen somewhere"). Passed already formatted, in VENUE time — a TV
   * player's own locale once put a wall clock four hours out, so no screen in
   * this estate formats a time of day for itself.
   */
  timeOfDay?: string | null;
  /**
   * The CALLED heat's printed check-in time — the moment a guest was told to be
   * at the desk. Shown on that row alone (owner: "for the called race, show the
   * check in time, doesn't need to show on others"): every other stage is
   * somewhere a group already is, and a schedule beside it would be noise.
   */
  calledCheckinAt?: string | null;
  style?: CSSProperties;
}

export function StageRailView({
  rows,
  density,
  accent,
  trackLabel,
  punctual,
  clock,
  returning,
  trackShort,
  timeOfDay,
  calledCheckinAt,
  style,
}: StageRailViewProps) {
  const s = SCALE[density];
  const compact = density === "compact";
  const showHead = !!trackLabel || !!clock || !!punctual || !!timeOfDay;
  /**
   * IS THIS TRACK FED BY TWO ROOMS — read off the rows themselves rather than
   * taken as a prop, because the SAME fact decides both halves of the answer and
   * a caller who set one and forgot the other would put the drift straight back.
   *
   * The builder splits Briefing into a row per room exactly when two rooms serve
   * the track, and that is exactly when a lane row's room stops being obvious.
   * On a split night the rail already sits inside its own room's screen, where
   * "→ RED ROOM" on every row is the wall reading itself back.
   */
  const twoRooms = rows.some((r) => r.labelTint != null);
  return (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        background: "#0a0e14",
        borderLeft: `${s.edge}px solid ${accent}`,
        padding: s.pad,
        display: "flex",
        flexDirection: "column",
        gap: s.gap,
        // FILLS WHAT IT IS GIVEN. The briefing room's first cut centred six rows
        // in a very wide screen and left most of it black.
        justifyContent: "space-between",
        ...style,
      }}
    >
      {showHead && (
        <div style={{ display: "flex", alignItems: "baseline", gap: 14, flexWrap: "wrap" }}>
          {trackLabel && (
            <span
              className="tv-eyebrow"
              style={{ fontSize: s.track, letterSpacing: "0.14em", color: accent }}
            >
              {trackLabel}
            </span>
          )}
          {punctual && (
            <span
              className="tv-eyebrow"
              style={{
                fontSize: s.chip,
                letterSpacing: "0.1em",
                padding: compact ? "2px 8px" : "3px 12px",
                borderRadius: 999,
                color: punctual.late ? WARN : GOOD,
                border: `2px solid ${withAlpha(punctual.late ? WARN : GOOD, 0.55)}`,
                background: withAlpha(punctual.late ? WARN : GOOD, 0.12),
              }}
            >
              {punctual.label}
            </span>
          )}
          {timeOfDay && (
            <span
              className="tv-eyebrow"
              style={{
                fontSize: s.chip,
                letterSpacing: "0.1em",
                color: "rgba(245,236,238,0.5)",
                marginLeft: clock ? undefined : "auto",
              }}
            >
              {timeOfDay}
            </span>
          )}
          {clock && (
            <span style={{ marginLeft: "auto", textAlign: "right" }}>
              <span
                className="tv-display"
                style={{
                  display: "block",
                  fontSize: s.clock,
                  lineHeight: 0.95,
                  color: clock.paused ? WARN : "#fff",
                }}
              >
                {clock.text}
              </span>
              <span
                className="tv-eyebrow"
                style={{
                  fontSize: s.clockCap,
                  letterSpacing: "0.12em",
                  color: "rgba(245,236,238,0.55)",
                }}
              >
                {clock.caption}
              </span>
            </span>
          )}
        </div>
      )}

      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-evenly",
          gap: s.rowGap,
        }}
      >
        {rows.map((r, i) => {
          const empty = r.value === "—";
          // Compact drops the word, never the number: the label column already
          // says which stage this is.
          const value = compact && r.heatNumber != null ? String(r.heatNumber) : r.value;
          const type = compact ? shortLevel(r.type) : r.type;
          const detail = compact ? (r.detailShort ?? r.detail) : r.detail;
          return (
            <div
              key={r.label}
              style={{
                display: "flex",
                alignItems: "baseline",
                gap: compact ? 9 : 14,
                flexWrap: "wrap",
                minWidth: 0,
                /**
                 * A HAIRLINE BETWEEN THE BANDS, on the wall boards only.
                 *
                 * A stage row is a long line — label, session, level, pill,
                 * detail — spread across a whole television, and the eye has to
                 * carry left to right across a lot of empty middle. The Mega
                 * tracker had these before it joined this component and lost
                 * them in the move; putting them HERE rather than back in that
                 * one board means the pit sign, the briefing TV and the tracker
                 * band alike, which is the whole point of the shared renderer.
                 *
                 * Not on compact: the camera rail is 58% of a small panel with
                 * its rows already tight, where a rule per row reads as noise.
                 */
                ...(compact || i === 0
                  ? null
                  : { borderTop: "1px solid rgba(245,236,238,0.12)", paddingTop: s.rowGap }),
              }}
            >
              <span
                className="tv-eyebrow"
                style={{
                  ...LABEL_COL,
                  fontSize: s.label,
                  letterSpacing: "0.08em",
                  // A ROOM ROW WEARS ITS OWN DOOR'S COLOUR. Staff say "red room"
                  // and "blue room" pointing at the doors; the colour is how the
                  // two rows are told apart at a glance from across the pit.
                  color: r.labelTint ? TRACK_ACCENTS[r.labelTint] : "rgba(245,236,238,0.45)",
                }}
              >
                {r.label}
              </span>
              <span
                className="tv-display"
                style={{
                  fontSize: s.value,
                  lineHeight: 1,
                  color: empty ? "rgba(245,236,238,0.28)" : "#fff",
                }}
              >
                {value}
              </span>
              {type && (
                <span
                  className="tv-eyebrow"
                  style={{ fontSize: s.type, color: "rgba(245,236,238,0.55)" }}
                >
                  {type}
                </span>
              )}
              {/*
                THE ROOM THIS RACE COMES BACK TO (owner 2026-08-17: "for mega
                keep a pill next to the race on what room they will be returning
                to"). Beside the session and not out at the right-hand edge,
                because it is part of naming the group — a Mega night runs two
                rooms into one lane, and the room is the half of "Session 25"
                that says whose it is.

                Never beside a "—": a pill floating next to an empty stage would
                be about nobody.
              */}
              {twoRooms && r.room && !empty && (
                <span
                  className="tv-display"
                  style={{
                    fontSize: s.pill,
                    whiteSpace: "nowrap",
                    color: "#fff",
                    padding: s.pillPad,
                    borderRadius: 9,
                    border: `2px solid ${TRACK_ACCENTS[r.room]}`,
                    background: withAlpha(TRACK_ACCENTS[r.room], 0.2),
                    boxShadow: `0 0 22px ${withAlpha(TRACK_ACCENTS[r.room], 0.45)}`,
                  }}
                >
                  {compact ? `→ ${r.room.toUpperCase()}` : `→ ${r.room.toUpperCase()} ROOM`}
                </span>
              )}
              {r.label === "Checking in" && calledCheckinAt && !empty && (
                <span
                  className="tv-eyebrow"
                  style={{ fontSize: s.type, color: "rgba(245,236,238,0.55)" }}
                >
                  {compact ? calledCheckinAt : `check-in ${calledCheckinAt}`}
                </span>
              )}
              {detail && (
                <span
                  className="tv-eyebrow"
                  style={{ fontSize: s.detail, color: TONE[r.tone], letterSpacing: "0.05em" }}
                >
                  {detail}
                </span>
              )}
            </div>
          );
        })}
      </div>

      {returning && returning.groups.length > 0 && (
        <BackToBack
          returning={returning}
          scale={s}
          compact={compact}
          trackShort={trackShort ?? ((t) => t)}
        />
      )}
    </div>
  );
}

/**
 * WHO IS GOING STRAIGHT BACK OUT (owner 2026-08-24: "who is coming off session
 * 35 and moving to blue 37?").
 *
 * The old card counted heads and named the destination; the question staff
 * actually ask is WHICH PEOPLE, because those are the ones who skip check-in
 * and walk to holding. Grouped by destination rather than listed flat: two
 * racers off one heat can be joining different tracks, and merging them would
 * send somebody to the wrong fence.
 */
function BackToBack({
  returning,
  scale,
  compact,
  trackShort,
}: {
  returning: NonNullable<TvFeed["checkinReturning"]>;
  scale: Scale;
  compact: boolean;
  trackShort: (track: string) => string;
}) {
  const from = returning.fromSession;
  return (
    <div
      style={{
        borderTop: "1px solid rgba(245,236,238,0.15)",
        paddingTop: compact ? 10 : 14,
        display: "flex",
        flexDirection: "column",
        gap: compact ? 6 : 8,
        flexShrink: 0,
      }}
    >
      <span className="tv-eyebrow" style={{ fontSize: scale.b2bHead, color: WARN }}>
        {compact ? "Straight back out" : "Going straight back out"}
      </span>
      {returning.groups.map((g) => (
        <div
          key={`${g.session ?? "?"}-${g.track}`}
          style={{ display: "flex", alignItems: "baseline", gap: 14, flexWrap: "wrap" }}
        >
          <span
            className="tv-display"
            style={{ fontSize: scale.b2bName, color: "#fff", minWidth: 0 }}
          >
            {g.names.join(" · ")}
          </span>
          <span
            className="tv-eyebrow"
            style={{ fontSize: scale.b2bHead, color: WARN, letterSpacing: "0.06em" }}
          >
            {compact
              ? `${from ?? "?"} → ${trackShort(g.track)} ${g.session ?? "—"}`
              : `off ${from ?? "?"} → join ${trackShort(g.track)} ${g.session ?? "—"}`}
          </span>
        </div>
      ))}
    </div>
  );
}
