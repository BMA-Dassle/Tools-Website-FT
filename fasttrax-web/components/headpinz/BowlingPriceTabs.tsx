"use client";

import { useState } from "react";

/**
 * Tabbed presentation for the group-event bowling price tables.
 *
 * Replaces the previous "stack three tall tables in a row" layout
 * on /hp/{fort-myers,naples}/group-events. The page was burning
 * roughly 3× more vertical space than the data needed — most
 * customers only care about ONE lane type at a time, so showing
 * one table at a time with a tab strip is the obvious win.
 *
 * Each tab keeps the per-table accent color used across the rest
 * of the page (coral = Classic, purple = VIP, blue = Pinz
 * Exclusive) so the brand chroma carries through.
 *
 * Reused across both centers — the shape of the data is identical;
 * only the per-row prices differ.
 */

interface PriceRow {
  /** "Mon–Thu" / "Fri–Sun" */
  period: string;
  /** 1.5 hours */
  h15: string;
  /** 2 hours */
  h2: string;
  /** 3 hours */
  h3: string;
}

export interface BowlingPriceTable {
  title: string;
  subtitle: string;
  /** Brand accent — drives tab underline, header bg, price color. */
  color: string;
  rows: PriceRow[];
}

export default function BowlingPriceTabs({ tables }: { tables: BowlingPriceTable[] }) {
  const [activeIdx, setActiveIdx] = useState(0);
  const active = tables[activeIdx];
  if (!active) return null;

  return (
    <div className="rounded-2xl border border-[#123075]/30 bg-white/[0.03] overflow-hidden mb-8">
      {/* Tab strip — equal-width buttons so titles wrap nicely on
          narrow screens. Active tab gets the table's accent color
          as a soft tint + bottom underline; inactive tabs read as
          muted greys so the active one pops. */}
      <div
        role="tablist"
        aria-label="Bowling pricing tiers"
        className="flex flex-col sm:flex-row border-b border-white/10 bg-black/30"
      >
        {tables.map((t, i) => {
          const isActive = i === activeIdx;
          return (
            <button
              key={t.title}
              role="tab"
              type="button"
              aria-selected={isActive}
              aria-controls={`bowling-tab-panel-${i}`}
              id={`bowling-tab-${i}`}
              onClick={() => setActiveIdx(i)}
              className="flex-1 px-3 py-3 sm:py-4 text-xs sm:text-sm font-heading font-black uppercase tracking-wider transition-all cursor-pointer"
              style={{
                color: isActive ? "#fff" : "rgba(255,255,255,0.5)",
                backgroundColor: isActive ? `${t.color}20` : "transparent",
                borderBottom: isActive ? `2px solid ${t.color}` : "2px solid transparent",
                letterSpacing: "0.5px",
              }}
            >
              {t.title}
            </button>
          );
        })}
      </div>

      {/* Subtitle bar — describes what's included for the active
          tier. Lives outside the table so it's prominent and the
          table itself can stay tightly packed. */}
      <div
        id={`bowling-tab-panel-${activeIdx}`}
        role="tabpanel"
        aria-labelledby={`bowling-tab-${activeIdx}`}
        className="px-5 py-3 border-b border-white/10"
        style={{ backgroundColor: `${active.color}12` }}
      >
        <p className="font-body text-white/55 text-xs">{active.subtitle}</p>
      </div>

      {/* Price grid — same markup as the old BowlingPriceTable so
          existing styles + horizontal-scroll behavior on narrow
          screens carry over verbatim. */}
      <div className="overflow-x-auto">
        <table className="w-full text-left font-body text-sm" style={{ minWidth: "520px" }}>
          <thead>
            <tr style={{ backgroundColor: `${active.color}88` }}>
              <th className="px-4 py-3 text-white font-bold uppercase tracking-wider text-xs">Time Period</th>
              <th className="px-4 py-3 text-white font-bold uppercase tracking-wider text-xs text-center">1.5 Hours</th>
              <th className="px-4 py-3 text-white font-bold uppercase tracking-wider text-xs text-center">2 Hours</th>
              <th className="px-4 py-3 text-white font-bold uppercase tracking-wider text-xs text-center">3 Hours</th>
            </tr>
          </thead>
          <tbody>
            {active.rows.map((r, i) => (
              <tr
                key={r.period}
                style={{ backgroundColor: i % 2 === 0 ? "rgba(10,22,40,0.6)" : "rgba(10,22,40,0.3)" }}
              >
                <td className="px-4 py-3 text-white/80 font-medium">{r.period}</td>
                <td className="px-4 py-3 font-semibold text-center" style={{ color: active.color }}>{r.h15}</td>
                <td className="px-4 py-3 font-semibold text-center" style={{ color: active.color }}>{r.h2}</td>
                <td className="px-4 py-3 font-semibold text-center" style={{ color: active.color }}>{r.h3}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
