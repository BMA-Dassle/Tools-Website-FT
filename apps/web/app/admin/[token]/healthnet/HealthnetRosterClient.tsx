"use client";

import { useMemo, useState } from "react";

import {
  ADMIN_SANS,
  PORTAL_BLUE,
  PORTAL_BLUE_SOFT,
  PORTAL_DARK,
} from "~/components/features/admin-skin/theme";

/** Portal-skin shared inline styles (style-only re-skin, 2026-07-13). */
const cardStyle = {
  backgroundColor: PORTAL_DARK.card,
  border: `1px solid ${PORTAL_DARK.border}`,
  borderRadius: 8,
} as const;
const mutedText = { color: PORTAL_DARK.muted } as const;

export type RosterRow = {
  name: string;
  email: string;
  phone: string;
  racing: string;
  gelBlaster: string;
  laserTag: string;
  /** Raw ISO times (naive ET) for chronological sorting; "" when not booked. */
  racingTime: string;
  gelTime: string;
  laserTime: string;
  freeflow: string;
  checkedIn: boolean;
  confirmedAt: string;
  firstTime: string;
  conflict: string;
  conflictResolution: string;
  conflictStayWith: string;
};

type Filter = "all" | "act-in" | "act-out" | "conflicts";

const FILTER_LABELS: Record<Filter, string> = {
  all: "All guests",
  "act-in": "Checked in w/ attraction",
  "act-out": "Not checked in w/ attraction",
  conflicts: "Conflicts",
};

function fmtPhone(p: string): string {
  const d = p.replace(/\D/g, "");
  if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  return p || "";
}

/** Has a reservation that requires a check-in (racing / gel blaster / laser tag).
 *  Free-flow activities (bowling, arcade, food) don't reserve a time, so they
 *  don't count toward the "required to check in" tally. */
const hasReservation = (r: RosterRow) => !!(r.racing || r.gelBlaster || r.laserTag);
const inGelLaser = (r: RosterRow) => !!(r.gelBlaster || r.laserTag);

type SortKey =
  | "name"
  | "phone"
  | "racing"
  | "gelBlaster"
  | "laserTag"
  | "freeflow"
  | "checkedIn"
  | "conflict";

/** Sort value for a column. Activity columns use the raw ISO time so they order
 *  chronologically; text columns use their lowercased string. */
function sortValue(r: RosterRow, key: SortKey): string {
  switch (key) {
    case "name":
      return r.name.toLowerCase();
    case "phone":
      return r.phone.replace(/\D/g, "");
    case "racing":
      return r.racingTime;
    case "gelBlaster":
      return r.gelTime;
    case "laserTag":
      return r.laserTime;
    case "freeflow":
      return r.freeflow.toLowerCase();
    case "conflict":
      return r.conflict.toLowerCase();
    case "checkedIn":
      return r.checkedIn ? "1" : "0";
  }
}

export default function HealthnetRosterClient({ rows }: { rows: RosterRow[] }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({
    key: "name",
    dir: "asc",
  });

  const counts = useMemo(
    () => ({
      total: rows.length,
      checkedIn: rows.filter((r) => r.checkedIn).length,
      // People with a reservation (racing/gel/laser) = those required to check in,
      // and how many of them have. Unique people, so anyone in both gel + laser
      // counts once.
      rezTotal: rows.filter(hasReservation).length,
      rezCheckedIn: rows.filter((r) => hasReservation(r) && r.checkedIn).length,
      racing: rows.filter((r) => r.racing).length,
      racingIn: rows.filter((r) => r.racing && r.checkedIn).length,
      gelLaser: rows.filter(inGelLaser).length,
      gelLaserIn: rows.filter((r) => inGelLaser(r) && r.checkedIn).length,
      conflicts: rows.filter((r) => r.conflict).length,
    }),
    [rows],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (filter === "act-in" && !(hasReservation(r) && r.checkedIn)) return false;
      if (filter === "act-out" && !(hasReservation(r) && !r.checkedIn)) return false;
      if (filter === "conflicts" && !r.conflict) return false;
      if (!q) return true;
      return (
        r.name.toLowerCase().includes(q) || r.email.toLowerCase().includes(q) || r.phone.includes(q)
      );
    });
  }, [rows, query, filter]);

  const sorted = useMemo(() => {
    const { key, dir } = sort;
    const sign = dir === "asc" ? 1 : -1;
    // Name is never blank and checkedIn is a boolean; every other column can be
    // empty and those blanks always sort to the bottom, regardless of direction.
    const blankLast = key !== "name" && key !== "checkedIn";
    return [...filtered].sort((a, b) => {
      const av = sortValue(a, key);
      const bv = sortValue(b, key);
      if (blankLast) {
        if (!av && !bv) return a.name.localeCompare(b.name);
        if (!av) return 1;
        if (!bv) return -1;
      }
      const c = av < bv ? -1 : av > bv ? 1 : 0;
      return c !== 0 ? sign * c : a.name.localeCompare(b.name);
    });
  }, [filtered, sort]);

  function toggleSort(key: SortKey) {
    setSort((s) =>
      s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" },
    );
  }

  // Human label for the active view — shown on the printed sheet header.
  const printLabel = query.trim()
    ? `${FILTER_LABELS[filter]} · "${query.trim()}"`
    : FILTER_LABELS[filter];

  function exportCsv() {
    const head = [
      "Name",
      "Email",
      "Phone",
      "Racing",
      "Gel Blaster",
      "Laser Tag",
      "Free-flow",
      "Checked In",
      "Confirmed At",
      "Conflict",
      "Resolution",
      "Stay With",
    ];
    const esc = (v: string) => `"${(v || "").replace(/"/g, '""')}"`;
    const lines = sorted.map((r) =>
      [
        r.name,
        r.email,
        fmtPhone(r.phone),
        r.racing,
        r.gelBlaster,
        r.laserTag,
        r.freeflow,
        r.checkedIn ? "YES" : "NO",
        r.confirmedAt,
        r.conflict,
        r.conflictResolution,
        r.conflictStayWith,
      ]
        .map(esc)
        .join(","),
    );
    const csv = [head.map(esc).join(","), ...lines].join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "healthnet-roster.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  const chip = (label: string, value: number, color: string, total?: number) => (
    <div className="p-4 text-center" style={cardStyle}>
      <div className="text-2xl font-bold" style={{ color }}>
        {value}
        {total != null && (
          <span className="text-base font-medium" style={mutedText}>
            {" "}
            / {total}
          </span>
        )}
      </div>
      <div className="text-xs uppercase tracking-wide" style={mutedText}>
        {label}
      </div>
    </div>
  );

  const filterBtn = (key: Filter, label: string) => (
    <button
      type="button"
      onClick={() => setFilter(key)}
      className={`px-4 py-1.5 text-sm transition-colors ${
        filter === key ? "" : "hover:bg-[#22345e]"
      }`}
      style={
        filter === key
          ? {
              backgroundColor: PORTAL_BLUE,
              border: `1px solid ${PORTAL_BLUE}`,
              borderRadius: 8,
              color: "#ffffff",
              fontWeight: 600,
            }
          : {
              backgroundColor: "transparent",
              border: `1px solid ${PORTAL_DARK.border}`,
              borderRadius: 8,
              color: PORTAL_DARK.muted,
              fontWeight: 500,
            }
      }
    >
      {label}
    </button>
  );

  // Sortable column header — click to sort by that field, click again to flip
  // direction. Activity columns sort chronologically (raw ISO time).
  const sortTh = (key: SortKey, label: string) => (
    <th className="px-3 py-2 font-semibold">
      <button
        type="button"
        onClick={() => toggleSort(key)}
        className="inline-flex items-center gap-1 uppercase tracking-wide hover:text-white"
        title={`Sort by ${label}`}
      >
        {label}
        <span
          className="text-[9px] leading-none"
          style={{ color: sort.key === key ? PORTAL_DARK.fg : PORTAL_DARK.muted }}
        >
          {sort.key === key ? (sort.dir === "asc" ? "▲" : "▼") : "↕"}
        </span>
      </button>
    </th>
  );

  return (
    <div
      className="hn-root min-h-screen px-4 py-8 print:p-0"
      style={{
        fontFamily: ADMIN_SANS,
        background: PORTAL_DARK.bodyGradient,
        color: PORTAL_DARK.fg,
      }}
    >
      <div className="mx-auto max-w-6xl print:hidden">
        <div className="mb-1 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1
              className="uppercase tracking-widest"
              style={{ fontSize: "1.5rem", fontWeight: 700 }}
            >
              Healthcare Network Team Day
            </h1>
            <p className="mt-1 text-sm" style={mutedText}>
              Friday, June 19 · 9 AM – 2 PM · HeadPinz Fort Myers
            </p>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => window.print()}
              className="rounded-lg px-4 py-2 text-sm font-semibold hover:bg-[#22345e]"
              style={{
                backgroundColor: PORTAL_DARK.card,
                border: `1px solid ${PORTAL_DARK.border}`,
                color: PORTAL_DARK.fg,
              }}
            >
              Print / PDF
            </button>
            <button
              type="button"
              onClick={exportCsv}
              className="rounded-lg px-4 py-2 text-sm font-semibold hover:bg-[#22345e]"
              style={{
                backgroundColor: PORTAL_DARK.card,
                border: `1px solid ${PORTAL_DARK.border}`,
                color: PORTAL_DARK.fg,
              }}
            >
              Export CSV
            </button>
          </div>
        </div>

        <div className="my-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {chip("RSVPs", counts.total, PORTAL_DARK.fg)}
          {chip("Checked in", counts.checkedIn, "#4ade80")}
          {chip("Attraction · in", counts.rezCheckedIn, PORTAL_BLUE, counts.rezTotal)}
          {chip("Racing", counts.racingIn, PORTAL_BLUE_SOFT, counts.racing)}
          {chip("Gel + Laser", counts.gelLaserIn, "#c084fc", counts.gelLaser)}
          {chip("Conflicts", counts.conflicts, "#f87171")}
        </div>

        <div className="mb-3 flex flex-wrap items-center gap-2">
          <input
            type="search"
            aria-label="Search by name, email, or phone"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name / email / phone…"
            className="w-full max-w-xs rounded-lg px-3 py-2 text-sm outline-none placeholder:text-[#98a2b3]/60 focus:ring-1 focus:ring-[#60a5fa]"
            style={{
              backgroundColor: PORTAL_DARK.inputBg,
              border: `1px solid ${PORTAL_DARK.inputBorder}`,
              color: PORTAL_DARK.fg,
            }}
          />
          <div className="flex flex-wrap gap-1.5">
            {filterBtn("all", `All (${counts.total})`)}
            {filterBtn("act-in", `Checked in w/ attraction (${counts.rezCheckedIn})`)}
            {filterBtn(
              "act-out",
              `Not checked in w/ attraction (${counts.rezTotal - counts.rezCheckedIn})`,
            )}
            {filterBtn("conflicts", `Conflicts (${counts.conflicts})`)}
          </div>
          <span className="ml-auto text-sm" style={mutedText}>
            {sorted.length} shown
          </span>
        </div>

        {/* Mobile: stacked tiles (no sideways scroll) */}
        <div className="space-y-3 md:hidden">
          {sorted.map((r) => (
            <div key={r.email} className="p-4" style={cardStyle}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-semibold">{r.name}</div>
                  <div className="truncate text-xs" style={mutedText}>
                    {r.email}
                  </div>
                </div>
                {r.checkedIn ? (
                  <span className="shrink-0 rounded-full bg-green-500/15 px-2 py-0.5 text-xs font-semibold text-green-300">
                    ✓ In
                  </span>
                ) : (
                  <span
                    className="shrink-0 rounded-full px-2 py-0.5 text-xs font-medium"
                    style={{ backgroundColor: PORTAL_DARK.muted2, color: PORTAL_DARK.muted }}
                  >
                    Not yet
                  </span>
                )}
              </div>
              <div className="mt-3 space-y-1 text-sm">
                <div className="flex justify-between gap-3">
                  <span style={mutedText}>Phone</span>
                  <span className="text-right text-white/90">{fmtPhone(r.phone) || "—"}</span>
                </div>
                {r.racing && (
                  <div className="flex justify-between gap-3">
                    <span style={mutedText}>Racing</span>
                    <span className="text-right text-white/90">{r.racing}</span>
                  </div>
                )}
                {r.gelBlaster && (
                  <div className="flex justify-between gap-3">
                    <span style={mutedText}>Gel Blaster</span>
                    <span className="text-right text-white/90">{r.gelBlaster}</span>
                  </div>
                )}
                {r.laserTag && (
                  <div className="flex justify-between gap-3">
                    <span style={mutedText}>Laser Tag</span>
                    <span className="text-right text-white/90">{r.laserTag}</span>
                  </div>
                )}
                {r.freeflow && (
                  <div className="flex justify-between gap-3">
                    <span style={mutedText}>Free-flow</span>
                    <span className="text-right text-white/70">{r.freeflow}</span>
                  </div>
                )}
              </div>
              {r.conflict && (
                <div className="mt-3 rounded-lg border border-red-400/20 bg-red-500/10 p-2 text-xs">
                  <div className="font-medium text-red-300">{r.conflict}</div>
                  <div className="text-white/70">
                    {r.conflictResolution ? `→ ${r.conflictResolution}` : "unresolved"}
                  </div>
                  {r.conflictStayWith && (
                    <div className="mt-0.5" style={mutedText}>
                      stay with: {r.conflictStayWith}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
          {sorted.length === 0 && (
            <p className="p-6 text-center" style={{ ...cardStyle, color: PORTAL_DARK.muted }}>
              No guests match.
            </p>
          )}
        </div>

        {/* Tablet/desktop: full table */}
        <div
          className="hidden overflow-x-auto rounded-lg md:block"
          style={{ backgroundColor: PORTAL_DARK.card, border: `1px solid ${PORTAL_DARK.border}` }}
        >
          <table className="w-full min-w-[760px] border-collapse text-sm">
            <thead>
              <tr
                className="text-left text-xs uppercase tracking-wide"
                style={{ backgroundColor: PORTAL_DARK.muted2, color: PORTAL_DARK.muted }}
              >
                {sortTh("name", "Name")}
                {sortTh("phone", "Phone")}
                {sortTh("racing", "Racing")}
                {sortTh("gelBlaster", "Gel Blaster")}
                {sortTh("laserTag", "Laser Tag")}
                {sortTh("freeflow", "Free-flow")}
                {sortTh("checkedIn", "Check-in")}
                {sortTh("conflict", "Conflict / fix")}
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => (
                <tr
                  key={r.email}
                  className="border-t align-top"
                  style={{ borderColor: PORTAL_DARK.border }}
                >
                  <td className="px-3 py-2">
                    <div className="font-medium">{r.name}</div>
                    <div className="text-xs" style={mutedText}>
                      {r.email}
                    </div>
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-white/80">
                    {fmtPhone(r.phone) || "—"}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-white/80">{r.racing || "—"}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-white/80">
                    {r.gelBlaster || "—"}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-white/80">{r.laserTag || "—"}</td>
                  <td className="px-3 py-2 text-xs" style={mutedText}>
                    {r.freeflow || "—"}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {r.checkedIn ? (
                      <span className="rounded-full bg-green-500/15 px-2 py-0.5 text-xs font-semibold text-green-300">
                        ✓ Checked in
                      </span>
                    ) : (
                      <span
                        className="rounded-full px-2 py-0.5 text-xs font-medium"
                        style={{ backgroundColor: PORTAL_DARK.muted2, color: PORTAL_DARK.muted }}
                      >
                        Not yet
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {r.conflict ? (
                      <>
                        <div className="font-medium text-red-300">{r.conflict}</div>
                        {r.conflictResolution ? (
                          <div className="text-white/80">→ {r.conflictResolution}</div>
                        ) : (
                          <div style={mutedText}>unresolved</div>
                        )}
                        {r.conflictStayWith && (
                          <div className="mt-0.5 text-white/50">
                            stay with: {r.conflictStayWith}
                          </div>
                        )}
                      </>
                    ) : (
                      <span style={mutedText}>—</span>
                    )}
                  </td>
                </tr>
              ))}
              {sorted.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-3 py-8 text-center" style={mutedText}>
                    No guests match.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <p className="mt-3 text-xs" style={mutedText}>
          &ldquo;Checked in&rdquo; = guest completed the confirm/check-in flow. Reload to refresh.
        </p>
      </div>

      {/* Print / PDF sheet — black-on-white, shows exactly the current filter +
          search result. "Print / PDF" → browser print dialog → Save as PDF. */}
      <div className="hidden print:block">
        <style>{`
          @media print {
            @page { margin: 0.5in; }
            /* Inline portal-skin styles on the root would otherwise win over
               the old print:bg-white/print:text-black utilities. */
            .hn-root { background: #fff !important; color: #000 !important; }
            .hn-print table { width: 100%; border-collapse: collapse; }
            .hn-print th, .hn-print td {
              border: 1px solid #999; padding: 4px 6px; text-align: left;
              vertical-align: top; font-size: 11px; color: #000;
            }
            .hn-print thead { display: table-header-group; }
            .hn-print tr { break-inside: avoid; }
          }
        `}</style>
        <div className="hn-print">
          <div style={{ marginBottom: 10 }}>
            <h1 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>
              Healthcare Network Team Day — Check-in
            </h1>
            <div style={{ fontSize: 12 }}>
              Friday, June 19 · {printLabel} · {sorted.length} guest
              {sorted.length === 1 ? "" : "s"}
            </div>
          </div>
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Phone</th>
                <th>Racing</th>
                <th>Gel</th>
                <th>Laser</th>
                <th>Free-flow</th>
                <th>In</th>
                <th>Conflict / fix</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => (
                <tr key={r.email}>
                  <td>{r.name}</td>
                  <td>{fmtPhone(r.phone) || "—"}</td>
                  <td>{r.racing || "—"}</td>
                  <td>{r.gelBlaster || "—"}</td>
                  <td>{r.laserTag || "—"}</td>
                  <td>{r.freeflow || "—"}</td>
                  <td>{r.checkedIn ? "✓" : ""}</td>
                  <td>
                    {r.conflict
                      ? `${r.conflict}${r.conflictResolution ? ` → ${r.conflictResolution}` : ""}`
                      : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {sorted.length === 0 && (
            <p style={{ fontSize: 12, marginTop: 8 }}>No guests match this view.</p>
          )}
        </div>
      </div>
    </div>
  );
}
