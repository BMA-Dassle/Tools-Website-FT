"use client";

/**
 * THE SCORES WALL — the race that just came back in.
 *
 * Hangs at a track's kart return, so the group walking out of the pits reads
 * its own result on the way past. That placement is what settles two design
 * arguments this board would otherwise have with the briefing room's
 * welcome-back wall:
 *
 *   LAP TIMES ARE ON THIS ONE. The welcome-back board deliberately has none
 *   (owner 2026-08-11) — it is a greeting, and it points people at the scores.
 *   This IS the scores, so it carries times, positions, karts and laps.
 *
 *   "WHO QUALIFIED" IS A HEADLINE, not a column to scan for. Levelling up is
 *   the thing a racer came for, so it gets its own panel with the names big,
 *   and the standings rows carry a matching green rule so the two halves of
 *   the board obviously agree.
 *
 * NOTHING ON THIS BOARD BLINKS. Guests read it standing still; a flashing
 * results table would be noise, and every looping flash on this canvas costs a
 * registration in TV_MOTION_PERIODS_MS (see the rulebook at the top of
 * app/tv/tv.css). There is deliberately no motion here at all.
 *
 * Every state it can be in is designed: a qualifying race, a race where nobody
 * cleared the time, a Pro grid with nothing above it, a 20-kart Mega grid, a
 * screen whose track has not been picked, and the first race of the day not
 * having finished yet. It never renders an error and never renders blank.
 */
import { formatLap } from "~/features/racing/qualify";
import { fmtTime12, toEtWallClock } from "~/features/kiosk/checkin/itinerary";
import { TRACK_ACCENTS, TRACK_LABELS, type TrackKey } from "../track";
import { withAlpha } from "../color";
import { TvBrandLogo } from "../components/TvBrandLogo";
import type { SignageVenue } from "../constants";
import type { ResultsBoardDriver, ResultsBoardView } from "../results-board";
import type { SceneProps } from "../director/types";

/* ── canvas geometry, authored at 1920×1080 ───────────────────────────── */

const PAD_X = 46;
const HEADER_H = 168;
const FOOTER_H = 92;
/** The qualifying panel's width in the single-column layout. */
const PANEL_W = 656;
const GAP = 34;

const GEL = "#46d68c";
/** Motorsport's purple for the fastest lap of the race. This is the palette's
 *  own Mega violet rather than a new colour — see app/tv/tv.css tokens. */
const FAST = "#a06bff";
const GOLD = "#d4af37";
const SILVER = "#cfd6e0";
const BRONZE = "#d08a4a";
const DIM = "rgba(245,236,238,0.58)";
const LINE = "rgba(255,255,255,0.12)";

/** Above this many rows the single column would have to shrink past reading
 *  distance, so the layout splits. Mirrors WIDE_GRID_FROM in results-board.ts,
 *  which is what actually sets `view.wide`. */
const COL_SPLIT = 2;

export function SceneRaceResults({ feed, config, venue }: SceneProps) {
  const track = config.resultsBoard?.track ?? null;
  const view = feed?.raceResults ?? null;

  // A board nobody has pointed at a track yet. Says so, quietly, rather than
  // adopting one — a scores wall showing the wrong track's names is worse than
  // one showing none.
  if (!track) return <SetupNotice />;
  if (!view) return <IdleBoard track={track} venue={venue} />;

  return view.wide ? (
    <WideBoard view={view} venue={venue} />
  ) : (
    <NarrowBoard view={view} venue={venue} />
  );
}

/* ── shared chrome ────────────────────────────────────────────────────── */

function Header({
  track,
  venue,
  title,
  rightLabel,
  rightValue,
}: {
  track: TrackKey;
  venue: SignageVenue;
  title: string;
  rightLabel: string;
  rightValue: string;
}) {
  const accent = TRACK_ACCENTS[track];
  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        height: HEADER_H,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: `0 ${PAD_X}px`,
        boxSizing: "border-box",
        background: `linear-gradient(180deg, ${withAlpha(accent, 0.26)}, ${withAlpha(accent, 0.08)})`,
        borderBottom: `7px solid ${accent}`,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 28, minWidth: 0 }}>
        {/* The mark, not the word (owner 2026-08-11 "use actual logos") — and at
            TV distance a logo is recognised rather than read. TvBrandLogo falls
            back to a wordmark rather than a broken-image glyph. */}
        <TvBrandLogo venue={venue} height={78} />
        <div
          style={{ width: 14, height: 104, borderRadius: 7, background: accent, flex: "0 0 auto" }}
        />
        <div style={{ minWidth: 0 }}>
          <div className="tv-eyebrow">{TRACK_LABELS[track]}</div>
          <div
            className="tv-display"
            style={{
              fontSize: 72,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {title}
          </div>
        </div>
      </div>
      <div style={{ textAlign: "right", flex: "0 0 auto", paddingLeft: 24 }}>
        <div className="tv-eyebrow" style={{ color: DIM }}>
          {rightLabel}
        </div>
        <div className="tv-num" style={{ fontSize: 54, fontWeight: 700 }}>
          {rightValue}
        </div>
      </div>
    </div>
  );
}

function Footer({ left, right }: { left: React.ReactNode; right: React.ReactNode }) {
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 0,
        height: FOOTER_H,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: `0 ${PAD_X}px`,
        boxSizing: "border-box",
        borderTop: `1px solid ${LINE}`,
        background: "rgba(7,16,39,0.5)",
        gap: 32,
      }}
    >
      <div
        style={{
          fontSize: 30,
          fontWeight: 600,
          minWidth: 0,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {left}
      </div>
      <div
        className="tv-num"
        style={{
          fontSize: 23,
          color: DIM,
          flex: "0 0 auto",
          display: "flex",
          alignItems: "center",
        }}
      >
        {right}
      </div>
    </div>
  );
}

/** The finish time, as a wall reads it.
 *
 *  TIME RULE (lesson 51a47370): naive-ET everywhere on a wall. These stamps are
 *  real epoch ms rather than naive strings, so they go through toEtWallClock,
 *  which handles the Z-stamped case correctly. Never `new Date` + timeZone. */
function finishTime(endedAtMs: number): string {
  return fmtTime12(toEtWallClock(new Date(endedAtMs).toISOString())) || "—";
}

function racerCount(view: ResultsBoardView): string {
  const n = view.drivers.length;
  return `${n} racer${n === 1 ? "" : "s"}`;
}

/* ── standings ────────────────────────────────────────────────────────── */

const COLS_WIDE = { pos: 62, kart: 52, lap: 168 };
const COLS_NARROW = { pos: 78, kart: 62, lap: 200, laps: 96 };

function posColor(position: number): string | undefined {
  if (position === 1) return GOLD;
  if (position === 2) return SILVER;
  if (position === 3) return BRONZE;
  return undefined;
}

function StandingsHead({ compact }: { compact: boolean }) {
  const c = compact ? COLS_WIDE : COLS_NARROW;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: compact ? 14 : 20,
        padding: `0 ${compact ? 16 : 22}px 12px`,
        fontSize: 21,
        letterSpacing: "0.18em",
        textTransform: "uppercase",
        color: DIM,
        fontWeight: 650,
      }}
    >
      <span style={{ flex: `0 0 ${c.pos}px` }}>Pos</span>
      <span style={{ flex: `0 0 ${c.kart}px` }}>Kart</span>
      <span style={{ flex: "1 1 auto" }}>Racer</span>
      <span style={{ flex: `0 0 ${c.lap}px`, textAlign: "right" }}>Best lap</span>
      {!compact && (
        <span style={{ flex: `0 0 ${COLS_NARROW.laps}px`, textAlign: "right" }}>Laps</span>
      )}
    </div>
  );
}

function Row({
  d,
  compact,
  fastestName,
}: {
  d: ResultsBoardDriver;
  compact: boolean;
  fastestName: string | null;
}) {
  const c = compact ? COLS_WIDE : COLS_NARROW;
  const isFastest = fastestName !== null && d.name === fastestName;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: compact ? 14 : 20,
        padding: `0 ${compact ? 16 : 22}px`,
        background: d.qualified ? withAlpha(GEL, 0.13) : "rgba(255,255,255,0.045)",
        borderRadius: 14,
        borderLeft: `6px solid ${d.qualified ? GEL : "transparent"}`,
        flex: "1 1 0",
        minHeight: 0,
      }}
    >
      <div
        className="tv-display tv-num"
        style={{ flex: `0 0 ${c.pos}px`, fontSize: compact ? 38 : 46, color: posColor(d.position) }}
      >
        {d.position > 0 ? d.position : "—"}
      </div>
      <div
        className="tv-num"
        style={{
          flex: `0 0 ${c.kart}px`,
          height: compact ? 46 : 54,
          borderRadius: 10,
          border: "2px solid rgba(255,255,255,0.22)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: compact ? 23 : 27,
          fontWeight: 700,
        }}
      >
        {d.kart || "—"}
      </div>
      <div
        style={{
          flex: "1 1 auto",
          minWidth: 0,
          fontSize: compact ? 34 : 41,
          fontWeight: 600,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {d.name}
      </div>
      {/* NO PER-ROW LEVEL PILL. On a Starter grid nearly everybody qualifies —
          the first live board showed nine identical "INTERMEDIATE" pills down
          one column (owner 2026-08-15: "that's a lot"). A word repeated on
          every row carries no information; the green rule and tint already say
          who qualified, and the panel beside it names them. */}
      <div
        className="tv-num"
        style={{
          flex: `0 0 ${c.lap}px`,
          textAlign: "right",
          fontSize: d.bestMs === null ? (compact ? 24 : 30) : compact ? 35 : 43,
          fontWeight: d.bestMs === null ? 500 : 700,
          color: d.bestMs === null ? DIM : isFastest ? FAST : undefined,
        }}
      >
        {d.bestMs === null ? "no lap" : formatLap(d.bestMs)}
      </div>
      {!compact && (
        <div
          className="tv-num"
          style={{
            flex: `0 0 ${COLS_NARROW.laps}px`,
            textAlign: "right",
            fontSize: 28,
            color: DIM,
          }}
        >
          {d.laps}
        </div>
      )}
    </div>
  );
}

function Standings({
  drivers,
  compact,
  fastestName,
}: {
  drivers: ResultsBoardDriver[];
  compact: boolean;
  fastestName: string | null;
}) {
  return (
    <div style={{ flex: "1 1 0", minWidth: 0, display: "flex", flexDirection: "column" }}>
      <StandingsHead compact={compact} />
      <div style={{ display: "flex", flexDirection: "column", gap: 7, flex: "1 1 auto" }}>
        {drivers.map((d) => (
          <Row key={`${d.position}-${d.name}`} d={d} compact={compact} fastestName={fastestName} />
        ))}
      </div>
    </div>
  );
}

/* ── the single-column board ──────────────────────────────────────────── */

function NarrowBoard({ view, venue }: { view: ResultsBoardView; venue: SignageVenue }) {
  return (
    <div style={{ position: "absolute", inset: 0, background: "#000418" }}>
      <Header
        track={view.track}
        venue={venue}
        title={view.heatLabel}
        rightLabel="Finished"
        rightValue={finishTime(view.endedAtMs)}
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
          padding: `32px ${PAD_X}px 0`,
          boxSizing: "border-box",
        }}
      >
        <Standings
          drivers={view.drivers}
          compact={false}
          fastestName={view.fastest?.name ?? null}
        />
        <QualifyPanel view={view} />
      </div>
      <Footer left={resultsFootLine(view)} right={<TvBrandLogo venue={venue} height={44} />} />
    </div>
  );
}

/** The quiet line under the standings.
 *
 *  "Results final" is the load-bearing half: this board holds the last race
 *  until the next one lands, so it must always be possible to tell WHICH race
 *  is on the wall and that it is not still being updated. The finish time is
 *  repeated from the header on purpose — the header can be read from across the
 *  room and this line from in front of it, and a stale-looking board is exactly
 *  what a timestamp answers. */
function resultsFootLine(view: ResultsBoardView): string {
  return `Results final · ${racerCount(view)} · ${finishTime(view.endedAtMs)}`;
}

/* ── the right-hand panel, in its three moods ─────────────────────────── */

function QualifyPanel({ view }: { view: ResultsBoardView }) {
  return (
    <div
      style={{
        flex: `0 0 ${PANEL_W}px`,
        display: "flex",
        flexDirection: "column",
        background: "rgba(7,16,39,0.62)",
        border: `1px solid ${LINE}`,
        borderRadius: 26,
        padding: "30px 32px",
        boxSizing: "border-box",
        minHeight: 0,
      }}
    >
      {view.target === null ? (
        <ProPanel view={view} />
      ) : view.qualified.length > 0 ? (
        <MovedUpPanel view={view} />
      ) : (
        <SoClosePanel view={view} />
      )}
    </div>
  );
}

/**
 * How the qualified names are laid out, given how many there are.
 *
 * TWO COLUMNS ABOVE SIX, and that is the actual fix for the clipped panel the
 * owner hit on the first live board (Blue Starter, heat 53: NINE of ten
 * qualified and the ninth name was sliced in half). A single column of nine,
 * plus a subtitle that wraps to two lines, overflows the panel by a few pixels
 * — and shrinking the type to fix that just moves the cliff to ten. Halving
 * the row count is what actually holds, and a Starter grid where nearly
 * everybody clears the time is the NORMAL case here, not the edge.
 *
 * Same discipline as the briefing board's pillScale: sized for the worst grid,
 * not the emptiest one.
 */
function nameScale(count: number): { font: number; padY: number; gap: number; cols: number } {
  if (count <= 3) return { font: 38, padY: 15, gap: 13, cols: 1 };
  if (count <= 6) return { font: 31, padY: 11, gap: 10, cols: 1 };
  if (count <= 10) return { font: 29, padY: 10, gap: 9, cols: 2 };
  if (count <= 16) return { font: 25, padY: 8, gap: 8, cols: 2 };
  return { font: 21, padY: 6, gap: 6, cols: 2 };
}

function PanelHead({
  eyebrow,
  head,
  headColor,
  sub,
}: {
  eyebrow: string;
  head: string;
  headColor?: string;
  sub: React.ReactNode;
}) {
  return (
    <>
      <div className="tv-eyebrow">{eyebrow}</div>
      <div className="tv-display" style={{ fontSize: 62, margin: "10px 0 4px", color: headColor }}>
        {head}
      </div>
      <div style={{ fontSize: 26, color: DIM, marginBottom: 22 }}>{sub}</div>
    </>
  );
}

function MovedUpPanel({ view }: { view: ResultsBoardView }) {
  const scale = nameScale(view.qualified.length);
  const level = view.target?.level ?? "";
  return (
    <>
      <PanelHead
        eyebrow="Who qualified"
        head={`${view.qualified.length} moved up`}
        headColor={GEL}
        sub={
          <>
            Beat{" "}
            <b style={{ color: "#f5ecee", fontWeight: 700 }} className="tv-num">
              {formatLap(view.target?.ms ?? 0)}
            </b>{" "}
            in {view.raceType ?? TRACK_LABELS[view.track]} to reach{" "}
            <b style={{ color: "#f5ecee", fontWeight: 700 }}>{level}</b>
          </>
        }
      />
      {/* NAMES ONLY (owner 2026-08-15). Each racer's time is already in the
          standings a few inches to the left, on the same row as their position
          and kart — repeating it here bought nothing and cost the width that
          was making long names ellipsise. What this panel is FOR is the list of
          who moved up, and a name is the whole of that. */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${scale.cols}, minmax(0, 1fr))`,
          gap: scale.gap,
          alignContent: "start",
          minHeight: 0,
          overflow: "hidden",
        }}
      >
        {view.qualified.map((d) => (
          <div
            key={d.name}
            style={{
              background: withAlpha(GEL, 0.15),
              border: `2px solid ${withAlpha(GEL, 0.5)}`,
              borderRadius: 14,
              padding: `${scale.padY}px 18px`,
              fontSize: scale.font,
              fontWeight: 650,
              minWidth: 0,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {d.name}
          </div>
        ))}
      </div>
      {view.closest && (
        <PanelFoot
          label="Closest miss"
          value={
            <>
              {view.closest.name} —{" "}
              <em
                style={{ fontStyle: "normal", color: "#00e2e5", fontWeight: 800 }}
                className="tv-num"
              >
                {(view.closest.gapMs / 1000).toFixed(3)}
              </em>{" "}
              off {view.target?.level}
            </>
          }
        />
      )}
    </>
  );
}

/**
 * Nobody cleared it.
 *
 * Deliberately NOT headlined "0 qualified". This board hangs where the group
 * walks past it thirty seconds after getting out of the kart, and a wall whose
 * headline is their failure is a bad way to end a race. Same tone as the
 * briefing board's "Didn't qualify — next time!": name how close they were, and
 * point at the next race.
 */
function SoClosePanel({ view }: { view: ResultsBoardView }) {
  // The two nearest misses — enough to feel like a chase, few enough that the
  // fourth-place racer is not publicly enumerated as also-ran.
  const nearest = view.drivers
    .filter((d) => d.bestMs !== null)
    .map((d) => ({ d, gap: (d.bestMs as number) - (view.target?.ms ?? 0) }))
    .filter((x) => x.gap > 0)
    .sort((a, b) => a.gap - b.gap)
    .slice(0, 2);

  return (
    <>
      <PanelHead
        eyebrow="Who qualified"
        head={nearest.length > 0 ? "So close" : "Next time"}
        sub={
          <>
            Beat{" "}
            <b style={{ color: "#f5ecee", fontWeight: 700 }} className="tv-num">
              {formatLap(view.target?.ms ?? 0)}
            </b>{" "}
            in {view.raceType ?? TRACK_LABELS[view.track]} to reach{" "}
            <b style={{ color: "#f5ecee", fontWeight: 700 }}>{view.target?.level}</b>
          </>
        }
      />
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 14,
          minHeight: 0,
          overflow: "hidden",
        }}
      >
        {nearest.map(({ d, gap }) => (
          <div
            key={d.name}
            style={{
              background: "rgba(255,255,255,0.05)",
              border: "2px solid rgba(255,255,255,0.2)",
              borderRadius: 16,
              padding: "16px 22px",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 16,
            }}
          >
            <div
              style={{
                fontSize: 39,
                fontWeight: 650,
                minWidth: 0,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {d.name}
            </div>
            <div
              className="tv-num"
              style={{ fontSize: 37, fontWeight: 800, color: "#00e2e5", flex: "0 0 auto" }}
            >
              +{(gap / 1000).toFixed(3)}
            </div>
          </div>
        ))}
      </div>
      <PanelFoot
        label="Next time"
        value={
          <>
            Nobody cleared it this heat —{" "}
            <em style={{ fontStyle: "normal", color: "#00e2e5", fontWeight: 800 }}>
              book another race
            </em>
          </>
        }
      />
    </>
  );
}

/** A Pro grid: the top of either ladder, so there is nothing to qualify for.
 *  The panel becomes the fast lap and the podium rather than an empty box. */
function ProPanel({ view }: { view: ResultsBoardView }) {
  return (
    <>
      <PanelHead
        eyebrow="Pro grid"
        head={view.fastest ? "Fast lap" : "Final standings"}
        headColor={view.fastest ? FAST : undefined}
        sub="Top of the ladder — nothing left to qualify for"
      />
      {view.fastest && (
        <div
          style={{
            background: withAlpha(FAST, 0.15),
            border: `2px solid ${withAlpha(FAST, 0.5)}`,
            borderRadius: 16,
            padding: "16px 22px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 16,
          }}
        >
          <div
            style={{
              fontSize: 39,
              fontWeight: 650,
              minWidth: 0,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {view.fastest.name}
          </div>
          <div
            className="tv-num"
            style={{ fontSize: 37, fontWeight: 800, color: FAST, flex: "0 0 auto" }}
          >
            {formatLap(view.fastest.bestMs)}
          </div>
        </div>
      )}
      <div style={{ marginTop: 26, minHeight: 0, overflow: "hidden" }}>
        <div
          style={{
            fontSize: 20,
            letterSpacing: "0.16em",
            textTransform: "uppercase",
            color: DIM,
            fontWeight: 650,
            marginBottom: 10,
          }}
        >
          Podium
        </div>
        {view.podium.map((d) => (
          <div
            key={d.name}
            style={{
              fontSize: 31,
              fontWeight: 600,
              display: "flex",
              gap: 14,
              alignItems: "baseline",
              marginBottom: 4,
            }}
          >
            <span className="tv-num" style={{ color: posColor(d.position), fontWeight: 800 }}>
              {d.position}
            </span>
            <span
              style={{
                minWidth: 0,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {d.name}
            </span>
          </div>
        ))}
      </div>
    </>
  );
}

function PanelFoot({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ marginTop: "auto", paddingTop: 20, borderTop: `1px solid ${LINE}` }}>
      <div
        style={{
          fontSize: 20,
          letterSpacing: "0.16em",
          textTransform: "uppercase",
          color: DIM,
          fontWeight: 650,
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 31, fontWeight: 600, marginTop: 4 }}>{value}</div>
    </div>
  );
}

/* ── the two-column board (Mega, and any big grid) ────────────────────── */

function WideBoard({ view, venue }: { view: ResultsBoardView; venue: SignageVenue }) {
  const half = Math.ceil(view.drivers.length / COL_SPLIT);
  const left = view.drivers.slice(0, half);
  const right = view.drivers.slice(half);
  const fastestName = view.fastest?.name ?? null;

  return (
    <div style={{ position: "absolute", inset: 0, background: "#000418" }}>
      <Header
        track={view.track}
        venue={venue}
        title={view.heatLabel}
        rightLabel="Finished"
        rightValue={finishTime(view.endedAtMs)}
      />
      <div
        style={{
          position: "absolute",
          top: HEADER_H,
          left: 0,
          right: 0,
          bottom: FOOTER_H,
          display: "flex",
          flexDirection: "column",
          padding: `32px ${PAD_X}px 0`,
          boxSizing: "border-box",
        }}
      >
        <div style={{ display: "flex", gap: 30, flex: "1 1 auto", minHeight: 0 }}>
          <Standings drivers={left} compact fastestName={fastestName} />
          {right.length > 0 && <Standings drivers={right} compact fastestName={fastestName} />}
        </div>
        <QualifyBand view={view} />
      </div>
      <Footer left={resultsFootLine(view)} right={<TvBrandLogo venue={venue} height={44} />} />
    </div>
  );
}

/** On a big grid the qualifying panel becomes a band, so the standings get the
 *  full width. Same three moods as the panel, compressed to one line. */
function QualifyBand({ view }: { view: ResultsBoardView }) {
  const qualified = view.qualified;
  const good = view.target !== null && qualified.length > 0;
  const accent = view.target === null ? FAST : good ? GEL : "rgba(255,255,255,0.28)";

  let title: string;
  let names: string;
  if (view.target === null) {
    title = "Pro grid";
    names = view.fastest
      ? `Fast lap — ${view.fastest.name} ${formatLap(view.fastest.bestMs)}`
      : "Top of the ladder — nothing left to qualify for";
  } else if (good) {
    title = `${qualified.length} moved up to ${view.target.level}`;
    names = qualified.map((d) => d.name).join("  ·  ");
  } else {
    title = "So close";
    names = view.closest
      ? `Closest — ${view.closest.name}, ${(view.closest.gapMs / 1000).toFixed(3)} off ${view.target.level}`
      : "Nobody cleared it this heat — next time!";
  }

  return (
    <div
      style={{
        flex: "0 0 auto",
        marginTop: 22,
        display: "flex",
        alignItems: "center",
        gap: 26,
        background:
          view.target === null
            ? withAlpha(FAST, 0.13)
            : good
              ? withAlpha(GEL, 0.13)
              : "rgba(255,255,255,0.05)",
        border: `2px solid ${accent}`,
        borderRadius: 18,
        padding: "16px 26px",
      }}
    >
      <div
        className="tv-display"
        style={{ fontSize: 34, flex: "0 0 auto", color: good ? GEL : undefined }}
      >
        {title}
      </div>
      <div
        style={{
          fontSize: 32,
          fontWeight: 620,
          flex: "1 1 auto",
          minWidth: 0,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {names}
      </div>
      {view.target !== null && (
        <div className="tv-num" style={{ fontSize: 26, color: DIM, flex: "0 0 auto" }}>
          beat {formatLap(view.target.ms)}
        </div>
      )}
    </div>
  );
}

/* ── the two states with no race in them ──────────────────────────────── */

function Shell({
  track,
  venue,
  title,
  rightLabel,
  rightValue,
  big,
  small,
  footLeft,
}: {
  track: TrackKey;
  venue: SignageVenue;
  title: string;
  rightLabel: string;
  rightValue: string;
  big: React.ReactNode;
  small: string;
  footLeft: string;
}) {
  return (
    <div style={{ position: "absolute", inset: 0, background: "#000418" }}>
      <Header
        track={track}
        venue={venue}
        title={title}
        rightLabel={rightLabel}
        rightValue={rightValue}
      />
      <div
        style={{
          position: "absolute",
          top: HEADER_H,
          left: 0,
          right: 0,
          bottom: FOOTER_H,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          textAlign: "center",
          padding: "0 120px",
        }}
      >
        <div className="tv-display" style={{ fontSize: 92, marginBottom: 18 }}>
          {big}
        </div>
        <div style={{ fontSize: 34, color: DIM, maxWidth: 1200 }}>{small}</div>
      </div>
      <Footer left={footLeft} right={<TvBrandLogo venue={venue} height={44} />} />
    </div>
  );
}

/**
 * No race has finished on this track today that we can name.
 *
 * The ONLY empty state in normal service: once a race has run, its result
 * stays up until the next one lands (the capture keeps it for 48h), because a
 * scores wall that goes blank between heats is worse than one showing a
 * ten-minute-old result — and every result on this board is stamped with its
 * own finish time, so nobody is misled about which race they are reading.
 */
function IdleBoard({ track, venue }: { track: TrackKey; venue: SignageVenue }) {
  return (
    <Shell
      track={track}
      venue={venue}
      title="Race Results"
      rightLabel="Today"
      rightValue="—"
      big={
        <>
          Results appear here
          <br />
          after each race
        </>
      }
      small="Final standings, best laps, and who moved up a level — posted within a minute of the chequered flag."
      footLeft={TRACK_LABELS[track]}
    />
  );
}

/** Provisioned but nobody has picked a track. Staff-facing, and it names the
 *  exact place to fix it rather than just refusing. */
function SetupNotice() {
  return (
    <div style={{ position: "absolute", inset: 0, background: "#000418" }}>
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          textAlign: "center",
          padding: "0 160px",
        }}
      >
        <div className="tv-eyebrow">Race results screen</div>
        <div className="tv-display" style={{ fontSize: 76, margin: "18px 0 20px" }}>
          Pick a track
        </div>
        <div style={{ fontSize: 32, color: DIM, maxWidth: 1100 }}>
          This screen has no track yet. Choose Blue, Red or Mega on the signage admin page and it
          will start showing that track&apos;s results.
        </div>
      </div>
    </div>
  );
}
