"use client";

import { IconDownload, IconRefresh, IconSearch } from "@tabler/icons-react";
import { PORTAL_BLUE, PORTAL_DARK } from "~/components/features/admin-skin/theme";
import { INPUT_STYLE } from "~/components/features/reservations-admin/theme";
import { shiftYmd, type SaleSourceId } from "~/features/web-sales";
import {
  DATE_PRESETS,
  matchPreset,
  presetRange,
  toggle,
  type BoardFilters,
  type DatePreset,
} from "./filters";

export interface SourceMeta {
  id: SaleSourceId;
  label: string;
  statusFilters: ReadonlyArray<{ value: string; label: string }>;
  venues: ReadonlyArray<{ key: string; label: string }>;
}

const PRESET_LABEL: Record<DatePreset, string> = {
  today: "Today",
  yesterday: "Yesterday",
  "7d": "7 days",
  "30d": "30 days",
  mtd: "Month to date",
};

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      style={{
        fontSize: 12,
        fontWeight: 600,
        padding: "5px 11px",
        borderRadius: 999,
        cursor: "pointer",
        color: active ? "#fff" : PORTAL_DARK.muted,
        background: active ? PORTAL_BLUE : "transparent",
        border: `1px solid ${active ? PORTAL_BLUE : PORTAL_DARK.border}`,
      }}
    >
      {children}
    </button>
  );
}

/**
 * Everything that narrows the board.
 *
 * All of it is URL-backed (see `filters.ts`) so a filtered view is linkable and
 * survives a reload. The source row hides itself while only one adapter is
 * registered, which keeps the board looking exactly like the single-product one
 * it replaces until there is genuinely a choice to make.
 */
export default function FilterBar({
  filters,
  sources,
  todayYmd,
  busy,
  onChange,
  onRefresh,
  csvHref,
}: {
  filters: BoardFilters;
  sources: SourceMeta[];
  todayYmd: string;
  busy: boolean;
  onChange: (next: BoardFilters) => void;
  onRefresh: () => void;
  csvHref: string;
}) {
  const active = matchPreset({ from: filters.from, to: filters.to }, todayYmd, shiftYmd);

  // Only offer statuses and venues that a selected source actually has. With no
  // source filter, offer the union — the alternative is a menu of values that
  // silently match nothing.
  const inScope = filters.sources.length > 0 ? sources.filter((s) => filters.sources.includes(s.id)) : sources;
  const showSourceRow = sources.length > 1;

  return (
    <div style={{ display: "grid", gap: 10 }}>
      {/* Row 1 — dates, search, actions */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        {DATE_PRESETS.map((p) => (
          <Chip
            key={p}
            active={active === p}
            onClick={() => onChange({ ...filters, ...presetRange(p, todayYmd, shiftYmd) })}
          >
            {PRESET_LABEL[p]}
          </Chip>
        ))}

        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: PORTAL_DARK.muted }}>
          <span className="sr-only">From</span>
          <input
            type="date"
            value={filters.from}
            max={filters.to}
            onChange={(e) => onChange({ ...filters, from: e.target.value })}
            style={{ ...INPUT_STYLE, width: 148 }}
          />
        </label>
        <span style={{ color: PORTAL_DARK.muted, fontSize: 12 }}>to</span>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: PORTAL_DARK.muted }}>
          <span className="sr-only">To</span>
          <input
            type="date"
            value={filters.to}
            min={filters.from}
            onChange={(e) => onChange({ ...filters, to: e.target.value })}
            style={{ ...INPUT_STYLE, width: 148 }}
          />
        </label>

        <div style={{ position: "relative", flex: "1 1 260px", minWidth: 220 }}>
          <IconSearch
            size={15}
            style={{ position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)", color: PORTAL_DARK.muted }}
            aria-hidden
          />
          <label className="sr-only" htmlFor="web-sales-search">
            Search sales
          </label>
          <input
            id="web-sales-search"
            type="search"
            value={filters.q}
            onChange={(e) => onChange({ ...filters, q: e.target.value })}
            placeholder="email · phone · name · HPW code · Square id"
            style={{ ...INPUT_STYLE, width: "100%", paddingLeft: 28 }}
          />
        </div>

        <button
          type="button"
          onClick={onRefresh}
          disabled={busy}
          title="Refresh"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: 12,
            padding: "6px 11px",
            borderRadius: 8,
            cursor: busy ? "default" : "pointer",
            opacity: busy ? 0.5 : 1,
            color: PORTAL_DARK.fg,
            background: "transparent",
            border: `1px solid ${PORTAL_DARK.border}`,
          }}
        >
          <IconRefresh size={15} aria-hidden />
          Refresh
        </button>

        <a
          href={csvHref}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: 12,
            padding: "6px 11px",
            borderRadius: 8,
            textDecoration: "none",
            color: PORTAL_DARK.fg,
            background: "transparent",
            border: `1px solid ${PORTAL_DARK.border}`,
          }}
        >
          <IconDownload size={15} aria-hidden />
          CSV
        </a>
      </div>

      {/* Row 2 — source, status, venue, needs-attention */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        {showSourceRow &&
          sources.map((s) => (
            <Chip
              key={s.id}
              active={filters.sources.includes(s.id)}
              onClick={() => onChange({ ...filters, sources: toggle(filters.sources, s.id) })}
            >
              {s.label}
            </Chip>
          ))}

        <label style={{ fontSize: 12, color: PORTAL_DARK.muted }}>
          <span className="sr-only">Status</span>
          <select
            value={filters.statuses[0] ?? ""}
            onChange={(e) => onChange({ ...filters, statuses: e.target.value ? [e.target.value] : [] })}
            style={{ ...INPUT_STYLE, minWidth: 150 }}
          >
            <option value="">All statuses</option>
            {inScope.length === 1
              ? inScope[0].statusFilters.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))
              : inScope.map((src) => (
                  <optgroup key={src.id} label={src.label}>
                    {src.statusFilters.map((s) => (
                      <option key={`${src.id}:${s.value}`} value={s.value}>
                        {s.label}
                      </option>
                    ))}
                  </optgroup>
                ))}
          </select>
        </label>

        {inScope
          .flatMap((s) => s.venues)
          // Two sources can serve the same center; show each venue once.
          .filter((v, i, all) => all.findIndex((o) => o.key === v.key) === i)
          .map((v) => (
            <Chip
              key={v.key}
              active={filters.venues.includes(v.key)}
              onClick={() => onChange({ ...filters, venues: toggle(filters.venues, v.key) })}
            >
              {v.label}
            </Chip>
          ))}

        <Chip
          active={filters.problemsOnly}
          onClick={() => onChange({ ...filters, problemsOnly: !filters.problemsOnly })}
        >
          Needs attention
        </Chip>
      </div>
    </div>
  );
}
