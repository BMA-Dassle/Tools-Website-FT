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
      {/* Tab strip.
          Mobile: vertical pill segmented control with explicit
          borders + filled active background — reads unambiguously
          as a switcher. Desktop: equal-width row with bottom
          underline + soft tint, same as before. */}
      <div
        role="tablist"
        aria-label="Bowling pricing tiers"
        className="flex flex-col sm:flex-row gap-2 sm:gap-0 p-2 sm:p-0 sm:border-b sm:border-white/10 bg-black/30"
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
              className="flex-1 flex items-center justify-center gap-2 px-3 py-3 sm:py-4 text-xs sm:text-sm font-heading font-black uppercase tracking-wider transition-all cursor-pointer rounded-lg sm:rounded-none border sm:border-0 sm:border-b-2"
              style={{
                color: isActive ? "#fff" : "rgba(255,255,255,0.7)",
                backgroundColor: isActive ? `${t.color}30` : "rgba(255,255,255,0.04)",
                borderColor: isActive ? t.color : "rgba(255,255,255,0.12)",
                letterSpacing: "0.5px",
              }}
            >
              {/* Color dot — extra cue on mobile that this is a switcher
                  with three options, each with its own brand chroma. */}
              <span
                aria-hidden="true"
                className="inline-block w-2 h-2 rounded-full shrink-0"
                style={{
                  backgroundColor: t.color,
                  opacity: isActive ? 1 : 0.6,
                }}
              />
              <span>{t.title}</span>
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
                style={{
                  backgroundColor: i % 2 === 0 ? "rgba(10,22,40,0.6)" : "rgba(10,22,40,0.3)",
                  borderLeft: `3px solid ${active.color}`,
                }}
              >
                <td className="px-4 py-3 text-white font-semibold">{r.period}</td>
                <td className="px-4 py-3 text-white font-bold text-base text-center">{r.h15}</td>
                <td className="px-4 py-3 text-white font-bold text-base text-center">{r.h2}</td>
                <td className="px-4 py-3 text-white font-bold text-base text-center">{r.h3}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
