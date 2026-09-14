"use client";

import { useState } from "react";
import { MEASURE_TEST_IDS, type PacingSeries } from "~/features/crm/kpi/contracts";
import { dayAtX, moneyK, pacingGeometry, shortDay } from "./model";

/**
 * "Booked vs same day last year" — the prototype's `pacingChart()`
 * (crm-shared.js:336-358), rebuilt over real data.
 *
 * ONE AXIS. Both lines are the same measure (cumulative booked cents, basis
 * `bmi`), so they share a scale and can honestly be compared; a second y-axis
 * here would be the classic way to make any two lines look related.
 *
 * The scale is DERIVED, not the prototype's hard-coded $125k: it rounds up
 * past the tallest of {goal, this year, last year} so a strong month cannot be
 * clipped by the frame.
 *
 * Beyond today the `ty` line STOPS rather than running flat to the end of the
 * month — a flat tail reads as "we stopped selling", which is a claim about
 * days that have not happened. The future is shaded instead.
 *
 * Two series ⇒ a legend is not optional. The end of each line is also directly
 * labelled, so identity never rests on colour alone, and the `<details>` table
 * gives the same numbers to anyone who cannot use a hover.
 */

export interface PacingChartProps {
  series: PacingSeries;
  /** "2026" / "2025" — legend and tooltip labels. */
  thisYearLabel: string;
  lastYearLabel: string;
  /** Spoken description of the whole chart. */
  caption: string;
}

interface Hover {
  day: number;
  x: number;
}

export function PacingChart({ series, thisYearLabel, lastYearLabel, caption }: PacingChartProps) {
  const [hover, setHover] = useState<Hover | null>(null);
  const geo = pacingGeometry(series);
  const { box } = geo;
  const days = series.points.length;

  if (days === 0) {
    return <p className="xs muted">No days in this window.</p>;
  }

  const onMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const svg = e.currentTarget.querySelector("svg");
    if (!svg) return;
    const r = svg.getBoundingClientRect();
    if (r.width === 0) return;
    const x = ((e.clientX - r.left) / r.width) * box.w;
    setHover({ day: dayAtX(geo, x, days), x });
  };

  const point = hover ? series.points[hover.day - 1] : null;
  const hoverX = hover ? geo.xOf(hover.day) : 0;

  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="legend">
        <span>
          <i style={{ background: "var(--s1)" }} />
          {thisYearLabel}
        </span>
        <span>
          <i style={{ background: "var(--s2)" }} />
          {lastYearLabel}
        </span>
        {geo.goalY !== null ? (
          <span>
            <i style={{ background: "transparent", borderColor: "var(--muted2)" }} />
            Goal
          </span>
        ) : null}
      </div>

      <div
        className="chart-wrap"
        data-testid={MEASURE_TEST_IDS.pacing}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        <svg
          className="chart pacing"
          viewBox={`0 0 ${box.w} ${box.h}`}
          role="img"
          aria-label={caption}
        >
          <defs>
            <linearGradient id="crm-pacing-area" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="var(--s1)" stopOpacity=".38" />
              <stop offset="1" stopColor="var(--s1)" stopOpacity="0" />
            </linearGradient>
          </defs>

          <g className="grid">
            {geo.ticks.map((t) => (
              <line key={t} x1={box.left} x2={box.w - box.right} y1={geo.yOf(t)} y2={geo.yOf(t)} />
            ))}
          </g>
          <g>
            {geo.ticks.map((t) => (
              <text key={t} x={box.left - 6} y={geo.yOf(t) + 4} textAnchor="end">
                {moneyK(t)}
              </text>
            ))}
          </g>
          <g>
            {geo.dayTicks.map((d) => (
              <text key={d} x={geo.xOf(d)} y={box.h - 8} textAnchor="middle">
                {shortDay(series.points[d - 1]?.date ?? "")}
              </text>
            ))}
          </g>

          {/* Everything after today is not data yet. */}
          {geo.todayX !== null && geo.todayX < box.w - box.right ? (
            <rect
              x={geo.todayX}
              y={box.top}
              width={box.w - box.right - geo.todayX}
              height={box.h - box.top - box.bottom}
              fill="var(--border2)"
              opacity=".25"
            />
          ) : null}

          {geo.goalY !== null ? (
            <>
              <line
                className="goal"
                x1={box.left}
                x2={box.w - box.right}
                y1={geo.goalY}
                y2={geo.goalY}
              />
              <text x={box.w - box.right} y={geo.goalY - 5} textAnchor="end">
                Goal {moneyK(series.goalCents)}
              </text>
            </>
          ) : null}

          {geo.areaPath ? <path d={geo.areaPath} fill="url(#crm-pacing-area)" /> : null}
          <path d={geo.lyPath} className="l2" fill="none" strokeWidth={2} strokeDasharray="5 4" />
          <path
            d={geo.tyPath}
            className="l1"
            fill="none"
            strokeWidth={2.5}
            strokeLinejoin="round"
          />

          {geo.todayX !== null ? (
            <>
              <line
                x1={geo.todayX}
                x2={geo.todayX}
                y1={box.top}
                y2={box.h - box.bottom}
                stroke="var(--muted2)"
                strokeDasharray="3 3"
              />
              <circle
                cx={geo.todayX}
                cy={geo.yOf(geo.tyNow)}
                r={5}
                className="f1"
                stroke="var(--card)"
                strokeWidth={2.5}
              />
              <text className="lbl" x={geo.todayX + 8} y={geo.yOf(geo.tyNow) + 4}>
                {moneyK(geo.tyNow)} {thisYearLabel}
              </text>
              <text x={geo.todayX + 8} y={geo.yOf(geo.lyNow) + 16}>
                {moneyK(geo.lyNow)} same day {lastYearLabel}
              </text>
            </>
          ) : null}

          <text x={box.w - box.right - 4} y={geo.yOf(geo.lyFinished) - 8} textAnchor="end">
            {lastYearLabel} finished {moneyK(geo.lyFinished)}
          </text>

          {hover ? (
            <line
              x1={hoverX}
              x2={hoverX}
              y1={box.top}
              y2={box.h - box.bottom}
              stroke="var(--fg)"
              opacity=".25"
            />
          ) : null}
        </svg>

        {point ? (
          <div
            className="chart-tip"
            style={{ display: "block", left: `${(hoverX / box.w) * 100}%`, top: "22%" }}
          >
            <b>{shortDay(point.date)}</b> · {thisYearLabel}{" "}
            {point.tyCents === null ? "—" : moneyK(point.tyCents)} · {lastYearLabel}{" "}
            {moneyK(point.lyCents)}
          </div>
        ) : null}
      </div>

      <details>
        <summary className="xs muted">Show the numbers</summary>
        <div className="scroll-x">
          <table className="tbl" data-testid={MEASURE_TEST_IDS.pacingTable}>
            <caption className="xs muted">{caption}</caption>
            <thead>
              <tr>
                <th scope="col">Day</th>
                <th scope="col" className="num">
                  {thisYearLabel}
                </th>
                <th scope="col" className="num">
                  {lastYearLabel}
                </th>
              </tr>
            </thead>
            <tbody>
              {series.points.map((p) => (
                <tr key={p.date}>
                  <th scope="row">{shortDay(p.date)}</th>
                  <td className="num">{p.tyCents === null ? "—" : moneyK(p.tyCents)}</td>
                  <td className="num">{moneyK(p.lyCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
