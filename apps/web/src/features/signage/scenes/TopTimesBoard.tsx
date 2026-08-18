"use client";

/**
 * THE TOP-TIMES WALL — fastest laps over a window, by tier.
 *
 * The other face of the scores wall. `SceneRaceResults` shows the race that
 * just came back in; this shows the hall of fame for today, the last seven
 * days, or the month so far. Both are the `race-results` scene, told apart by
 * `resultsBoard.role`, and both hang in the same frame (results-chrome) so a
 * pair four feet apart reads as one system rather than two designs.
 *
 * ALL THREE TIERS AT ONCE (owner 2026-08-17), never one tier per slot. A racer
 * walking out of the pits should find their own tier immediately instead of
 * waiting for the board to come round to it — which on a three-window rotation
 * could be two minutes.
 *
 * WHAT ROTATES IS THE WINDOW (and the class, when juniors have raced): one
 * panel per slot, picked off the shared clock in `panelAt` so a pair of boards
 * cannot disagree about which one is up.
 *
 * NOTHING HERE BLINKS, same rule as the results board next door — guests read
 * this standing still, and every looping animation on a TV canvas costs a
 * registration in TV_MOTION_PERIODS_MS. There is no motion on this board at all.
 */
import { TRACK_ACCENTS, TRACK_LABELS, type TrackKey } from "../track";
import { withAlpha } from "../color";
import { TvBrandLogo } from "../components/TvBrandLogo";
import {
  Footer,
  Header,
  BRONZE,
  DIM,
  FOOTER_H,
  GOLD,
  GROUND,
  HEADER_H,
  LINE,
  PAD_X,
  SILVER,
} from "./results-chrome";
import { RANGE_LABELS, type TopTimesPanel } from "../top-times";
import type { SignageVenue } from "../constants";

/** Gap between tier columns, matching the results board's own GAP. */
const GAP = 34;

/** The medal colours, P1–P3. Everything below is the ordinary dim number —
 *  a podium that highlights eight places highlights nothing. */
const MEDALS = [GOLD, SILVER, BRONZE];

export function TopTimesBoard({
  track,
  venue,
  panel,
}: {
  track: TrackKey;
  venue: SignageVenue;
  panel: TopTimesPanel;
}) {
  const accent = TRACK_ACCENTS[track];
  // Junior panels say so in the title; adult is unqualified, because
  // unqualified means adult everywhere else in the building.
  const title = panel.cls === "junior" ? "Junior Fastest Laps" : "Fastest Laps";

  return (
    <div style={{ position: "absolute", inset: 0, background: GROUND }}>
      <Header
        track={track}
        venue={venue}
        title={title}
        rightLabel="Window"
        rightValue={RANGE_LABELS[panel.range]}
      />

      <div
        style={{
          position: "absolute",
          top: HEADER_H,
          left: 0,
          right: 0,
          bottom: FOOTER_H,
          display: "flex",
          gap: GAP,
          padding: `28px ${PAD_X}px 24px`,
          boxSizing: "border-box",
        }}
      >
        {panel.columns.map((col) => (
          <TierColumn key={col.label} label={col.label} color={col.color} rows={col.rows} />
        ))}
      </div>

      <Footer
        left={
          <>
            {TRACK_LABELS[track]}
            <span style={{ color: DIM, fontWeight: 500 }}>
              {" · "}
              {RANGE_LABELS[panel.range]}
            </span>
          </>
        }
        right={
          <>
            {/* The one instruction on the board: how to get on it. */}
            <span style={{ marginRight: 22, color: withAlpha(accent, 0.95) }}>
              Beat a time to make the board
            </span>
            <TvBrandLogo venue={venue} height={44} />
          </>
        }
      />
    </div>
  );
}

/**
 * One tier's column.
 *
 * Columns flex to equal width rather than being sized from a constant: a track
 * whose junior catalog has a single generic "Junior" group (Red) renders ONE
 * column, and Mega has no junior Starter at all. A fixed three-up grid would
 * leave those boards with holes in them.
 */
function TierColumn({
  label,
  color,
  rows,
}: {
  label: string;
  color: string;
  rows: Array<{ position: number; name: string; score: string }>;
}) {
  return (
    <div
      style={{
        flex: "1 1 0",
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        background: "rgba(7,16,39,0.5)",
        border: `2px solid ${withAlpha(color, 0.55)}`,
        borderRadius: 14,
        overflow: "hidden",
      }}
    >
      {/* The label NEVER sits on a fill of its own colour. A tint that fails to
          apply — which is exactly what happened when withAlpha met this
          catalog's rgb() strings — leaves the text invisible; a dark bar with a
          coloured rule under it cannot fail that way, and it matches the
          /leaderboards card the same records feed already draws. */}
      <div
        style={{
          padding: "16px 24px",
          borderBottom: `4px solid ${color}`,
          background: "rgba(0,4,24,0.72)",
          flex: "0 0 auto",
        }}
      >
        <div
          className="tv-display"
          style={{
            fontSize: 40,
            color,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {label}
        </div>
      </div>

      <div style={{ flex: "1 1 auto", display: "flex", flexDirection: "column", padding: "4px 0" }}>
        {rows.map((r, i) => (
          <Row key={`${r.position}-${r.name}`} row={r} rank={i} last={i === rows.length - 1} />
        ))}
      </div>
    </div>
  );
}

function Row({
  row,
  rank,
  last,
}: {
  row: { position: number; name: string; score: string };
  rank: number;
  last: boolean;
}) {
  const medal = MEDALS[rank] ?? null;
  return (
    <div
      style={{
        flex: "1 1 0",
        display: "flex",
        alignItems: "center",
        gap: 16,
        padding: `0 22px`,
        borderBottom: last ? "none" : `1px solid ${LINE}`,
        minHeight: 0,
      }}
    >
      <div
        className="tv-num"
        style={{
          width: 52,
          flex: "0 0 auto",
          fontSize: 34,
          fontWeight: 700,
          color: medal ?? DIM,
          textAlign: "right",
        }}
      >
        {row.position}
      </div>
      <div
        style={{
          flex: "1 1 auto",
          minWidth: 0,
          fontSize: 36,
          fontWeight: medal ? 700 : 500,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {row.name}
      </div>
      <div
        className="tv-num"
        style={{
          flex: "0 0 auto",
          fontSize: 36,
          fontWeight: 700,
          color: medal ?? "inherit",
        }}
      >
        {row.score}
      </div>
    </div>
  );
}
