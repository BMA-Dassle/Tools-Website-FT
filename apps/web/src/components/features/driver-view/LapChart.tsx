/**
 * A heat's lap times, drawn.
 *
 * A LINE, NOT BARS, and the axis does not start at zero. Lap times cluster in a
 * narrow band — 31s to 53s in a real Starter heat — so a zero-based bar chart
 * flattens every difference that matters into indistinguishable columns. Bars
 * with a truncated baseline would exaggerate instead of flatten, which is worse:
 * it is the classic misleading chart. A line with a clearly labelled non-zero
 * axis is the honest form for this data.
 *
 * Y INCREASES UPWARD, so a faster lap sits lower. That reads oddly for half a
 * second and is then unambiguous, which is better than inverting the axis and
 * being subtly wrong for everyone who glances at it.
 *
 * ROLLOUT LAPS BREAK THE LINE. They have no time at all, and joining across them
 * would draw a segment that never happened.
 *
 * SELECTIVE LABELS: best, slowest, last. Every point labelled is unreadable, and
 * the exact numbers are in the table directly beneath — the chart is for the
 * SHAPE of a drive (where they found time, where they lost it), not for reading
 * values off.
 *
 * Pure and server-rendered: no state, no client JS.
 */
import type { DriverLap } from "~/features/racing/driver-view/types";
import { formatLapTime, summarise } from "~/features/racing/driver-view/laps";
import { c, font } from "./tokens";

const W = 720;
const H = 240;
const PAD = { left: 46, right: 16, top: 18, bottom: 30 };

export function LapChart({ laps, accent = c.cyan }: { laps: DriverLap[]; accent?: string }) {
  const s = summarise(laps);
  // Two timed laps is the floor for a line to mean anything.
  if (s.timed.length < 2) return null;

  const times = s.timed.map((l) => l.lapTimeMs as number);
  const lo = Math.min(...times);
  const hi = Math.max(...times);
  // Pad the band so the fastest and slowest are not welded to the frame, and
  // guard the degenerate case where every lap is identical.
  const span = Math.max(hi - lo, 500);
  const yMin = lo - span * 0.18;
  const yMax = hi + span * 0.18;

  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const x = (lapNumber: number) =>
    PAD.left + ((lapNumber - 1) / Math.max(1, s.laps.length - 1)) * plotW;
  const y = (ms: number) => PAD.top + plotH - ((ms - yMin) / (yMax - yMin)) * plotH;

  // Gridlines on round seconds inside the band — never more than four, or the
  // grid competes with the data.
  const ticks: number[] = [];
  const stepMs = niceStep((yMax - yMin) / 3);
  for (let t = Math.ceil(yMin / stepMs) * stepMs; t <= yMax; t += stepMs) ticks.push(t);

  // Break the polyline wherever a rollout lap sits, so nothing is drawn across it.
  const runs: DriverLap[][] = [];
  let run: DriverLap[] = [];
  for (const l of s.laps) {
    if (l.lapTimeMs === null) {
      if (run.length) runs.push(run);
      run = [];
    } else run.push(l);
  }
  if (run.length) runs.push(run);

  const best = s.best;
  const worst = s.worst;
  const last = s.last;
  const labelled = new Set<string>();
  for (const l of [best, worst, last]) if (l) labelled.add(l.passingId);

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      role="img"
      aria-label={`Lap times: ${s.timed.length} laps, best ${formatLapTime(best?.lapTimeMs ?? null)}`}
      style={{ display: "block" }}
    >
      {ticks.map((t) => (
        <g key={t}>
          <line
            x1={PAD.left}
            y1={y(t)}
            x2={W - PAD.right}
            y2={y(t)}
            stroke={c.ink}
            strokeOpacity={0.07}
            strokeWidth={1}
          />
          <text
            x={PAD.left - 8}
            y={y(t) + 3.5}
            textAnchor="end"
            fontFamily={font.display}
            fontSize={11}
            fill={c.ink}
            fillOpacity={0.42}
          >
            {(t / 1000).toFixed(0)}
          </text>
        </g>
      ))}

      {/* baseline */}
      <line
        x1={PAD.left}
        y1={PAD.top + plotH}
        x2={W - PAD.right}
        y2={PAD.top + plotH}
        stroke={c.ink}
        strokeOpacity={0.16}
      />

      {runs.map((r, i) => (
        <polyline
          key={i}
          points={r.map((l) => `${x(l.lapNumber)},${y(l.lapTimeMs as number)}`).join(" ")}
          fill="none"
          stroke={accent}
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      ))}

      {s.timed.map((l) => {
        const isBest = best?.passingId === l.passingId;
        return (
          <circle
            key={l.passingId}
            cx={x(l.lapNumber)}
            cy={y(l.lapTimeMs as number)}
            r={isBest ? 7 : 4.5}
            fill={isBest ? c.violet : accent}
            stroke={c.ground}
            strokeWidth={2}
          />
        );
      })}

      {s.timed
        .filter((l) => labelled.has(l.passingId))
        .map((l) => {
          const isBest = best?.passingId === l.passingId;
          const py = y(l.lapTimeMs as number);
          // Best sits at the bottom of the band, so its label goes below it;
          // everything else goes above, where there is room.
          const dy = isBest ? 18 : -12;
          return (
            <text
              key={`lbl-${l.passingId}`}
              x={x(l.lapNumber)}
              y={py + dy}
              textAnchor="middle"
              fontFamily={font.display}
              fontSize={13}
              fontWeight={isBest ? 800 : 700}
              fill={isBest ? c.violet : c.ink}
              fillOpacity={isBest ? 1 : 0.72}
            >
              {formatLapTime(l.lapTimeMs)}
            </text>
          );
        })}

      {/* x axis: first, best and last lap numbers only */}
      {[s.laps[0], best, last]
        .filter((l): l is DriverLap => Boolean(l))
        .map((l) => (
          <text
            key={`x-${l.passingId}`}
            x={x(l.lapNumber)}
            y={H - 8}
            textAnchor="middle"
            fontFamily={font.display}
            fontSize={11}
            fill={c.ink}
            fillOpacity={0.42}
          >
            {l.lapNumber}
          </text>
        ))}
    </svg>
  );
}

/** A gridline step a human would choose: 1, 2, 5, 10, 20, 30 or 60 seconds. */
function niceStep(roughMs: number): number {
  const candidates = [1000, 2000, 5000, 10_000, 20_000, 30_000, 60_000];
  for (const c0 of candidates) if (roughMs <= c0) return c0;
  return 60_000;
}

/**
 * A driver's shape at row height, for the standings table.
 *
 * No axis, no labels — it exists to answer "did they build a rhythm or bounce
 * around?" at a glance, next to the numbers that give the detail.
 */
export function LapSparkline({ laps, accent = c.cyan }: { laps: DriverLap[]; accent?: string }) {
  const s = summarise(laps);
  if (s.timed.length < 2) return null;
  const times = s.timed.map((l) => l.lapTimeMs as number);
  const lo = Math.min(...times);
  const hi = Math.max(...times);
  const span = Math.max(hi - lo, 1);
  const w = 90;
  const h = 22;
  const pts = s.timed
    .map((l, i) => {
      const px = (i / Math.max(1, s.timed.length - 1)) * w;
      const py = h - ((((l.lapTimeMs as number) - lo) / span) * (h - 4) + 2);
      return `${px.toFixed(1)},${py.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width={w} height={h} aria-hidden style={{ display: "block" }}>
      <polyline
        points={pts}
        fill="none"
        stroke={accent}
        strokeOpacity={0.75}
        strokeWidth={1.6}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
