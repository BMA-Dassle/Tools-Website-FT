"use client";

import { useState } from "react";
import { MEASURE_TEST_IDS, type MonthlyGoalRow } from "~/features/crm/kpi/contracts";
import { monthlyGeometry, moneyK } from "./model";

/**
 * "Goal vs last year, by month" — the prototype's `monthlyChart()`
 * (crm-shared.js:367). Three marks per month: last year filled, the goal as an
 * OUTLINE, this year's actual filled.
 *
 * The goal is an outline on purpose. It is a target, not an outcome, and a
 * third solid hue beside two real ones invites the eye to compare all three as
 * though they were the same kind of thing. Outline vs fill also survives
 * greyscale and colour-blindness, which is why the legend can name three
 * series on a two-hue palette.
 *
 * A month that has not started shows NO actual bar — not a zero one. Zero is a
 * claim ("we sold nothing in December"); absence is the truth ("December has
 * not happened").
 */

export interface MonthlyChartProps {
  rows: readonly MonthlyGoalRow[];
  year: number;
  caption: string;
}

export function MonthlyChart({ rows, year, caption }: MonthlyChartProps) {
  const [hover, setHover] = useState<number | null>(null);
  const geo = monthlyGeometry(rows);
  const { box } = geo;
  const base = geo.yOf(0);
  const hovered = hover === null ? null : geo.bars.find((b) => b.month === hover);

  return (
    <div className="stack" style={{ gap: 8 }} data-testid={MEASURE_TEST_IDS.monthly}>
      <div className="chart-wrap">
        <svg className="chart" viewBox={`0 0 ${box.w} ${box.h}`} role="img" aria-label={caption}>
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

          {geo.bars.map((b) => (
            <g
              key={b.month}
              onMouseEnter={() => setHover(b.month)}
              onMouseLeave={() => setHover(null)}
            >
              {/* A full-height hit target, so a short bar is still hoverable. */}
              <rect
                x={b.ly.x - 2}
                y={box.top}
                width={b.goal.w * 3 + 8}
                height={base - box.top}
                fill="transparent"
              />
              <rect
                x={b.ly.x}
                y={b.ly.y}
                width={b.ly.w}
                height={b.ly.h}
                rx={2}
                className="f2"
                opacity=".75"
              />
              <rect
                x={b.goal.x}
                y={b.goal.y}
                width={b.goal.w}
                height={b.goal.h}
                rx={2}
                fill="none"
                stroke="var(--muted)"
                strokeWidth={1.2}
              />
              {b.actual ? (
                <rect
                  x={b.actual.x}
                  y={b.actual.y}
                  width={b.actual.w}
                  height={b.actual.h}
                  rx={2}
                  className="f1"
                />
              ) : null}
              <text x={b.cx} y={box.h - 8} textAnchor="middle">
                {b.label}
              </text>
            </g>
          ))}
        </svg>

        {hovered ? (
          <div
            className="chart-tip"
            style={{ display: "block", left: `${(hovered.cx / box.w) * 100}%`, top: "6%" }}
          >
            <b>
              {hovered.label} {year}
            </b>{" "}
            · goal {moneyK(hovered.row.goalCents)} · LY {moneyK(hovered.row.lastYearCents)} ·{" "}
            {hovered.row.actualCents === null
              ? "not started"
              : `actual ${moneyK(hovered.row.actualCents)}`}
          </div>
        ) : null}
      </div>

      <div className="legend">
        <span>
          <i style={{ background: "var(--s2)", opacity: 0.75 }} />
          Last year
        </span>
        <span>
          <i style={{ border: "1.5px solid var(--muted)", background: "transparent" }} />
          Goal
        </span>
        <span>
          <i style={{ background: "var(--s1)" }} />
          Actual {year}
        </span>
      </div>
    </div>
  );
}
