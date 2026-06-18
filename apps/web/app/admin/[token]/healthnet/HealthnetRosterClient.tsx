"use client";

import { useMemo, useState } from "react";

export type RosterRow = {
  name: string;
  email: string;
  phone: string;
  racing: string;
  gelBlaster: string;
  laserTag: string;
  freeflow: string;
  checkedIn: boolean;
  confirmedAt: string;
  firstTime: string;
  conflict: string;
  conflictResolution: string;
  conflictStayWith: string;
};

type Filter = "all" | "in" | "out";

function fmtPhone(p: string): string {
  const d = p.replace(/\D/g, "");
  if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  return p || "";
}

export default function HealthnetRosterClient({ rows }: { rows: RosterRow[] }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");

  const counts = useMemo(
    () => ({
      total: rows.length,
      checkedIn: rows.filter((r) => r.checkedIn).length,
      withPhone: rows.filter((r) => r.phone).length,
      racing: rows.filter((r) => r.racing).length,
      conflicts: rows.filter((r) => r.conflict).length,
    }),
    [rows],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (filter === "in" && !r.checkedIn) return false;
      if (filter === "out" && r.checkedIn) return false;
      if (!q) return true;
      return (
        r.name.toLowerCase().includes(q) || r.email.toLowerCase().includes(q) || r.phone.includes(q)
      );
    });
  }, [rows, query, filter]);

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
    const lines = filtered.map((r) =>
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

  const chip = (label: string, value: number, color: string) => (
    <div className="rounded-xl border border-white/10 bg-white/5 p-4 text-center">
      <div className="text-2xl font-bold" style={{ color }}>
        {value}
      </div>
      <div className="text-xs uppercase tracking-wide text-white/50">{label}</div>
    </div>
  );

  const filterBtn = (key: Filter, label: string) => (
    <button
      type="button"
      onClick={() => setFilter(key)}
      className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
        filter === key
          ? "bg-white text-[#0a1120]"
          : "border border-white/20 text-white/70 hover:bg-white/10"
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="min-h-screen bg-[#0a1120] px-4 py-8 text-white">
      <div className="mx-auto max-w-6xl">
        <div className="mb-1 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="font-display text-2xl uppercase tracking-widest">
              Healthcare Network Team Day
            </h1>
            <p className="mt-1 text-sm text-white/50">
              Friday, June 19 · 9 AM – 2 PM · HeadPinz Fort Myers
            </p>
          </div>
          <button
            type="button"
            onClick={exportCsv}
            className="rounded-lg border border-white/20 px-4 py-2 text-sm font-semibold hover:bg-white/10"
          >
            Export CSV
          </button>
        </div>

        <div className="my-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
          {chip("RSVPs", counts.total, "#ffffff")}
          {chip("Checked in", counts.checkedIn, "#4ade80")}
          {chip("Have phone", counts.withPhone, "#22d3ee")}
          {chip("Racing", counts.racing, "#60a5fa")}
          {chip("Conflicts", counts.conflicts, "#f87171")}
        </div>

        <div className="mb-3 flex flex-wrap items-center gap-2">
          <input
            type="search"
            aria-label="Search by name, email, or phone"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name / email / phone…"
            className="w-full max-w-xs rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white outline-none placeholder:text-white/30 focus:border-white/40"
          />
          <div className="flex flex-wrap gap-1.5">
            {filterBtn("all", `All (${counts.total})`)}
            {filterBtn("in", `Checked in (${counts.checkedIn})`)}
            {filterBtn("out", `Not yet (${counts.total - counts.checkedIn})`)}
          </div>
          <span className="ml-auto text-sm text-white/50">{filtered.length} shown</span>
        </div>

        {/* Mobile: stacked tiles (no sideways scroll) */}
        <div className="space-y-3 md:hidden">
          {filtered.map((r) => (
            <div key={r.email} className="rounded-xl border border-white/10 bg-white/5 p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-semibold text-white">{r.name}</div>
                  <div className="truncate text-xs text-white/40">{r.email}</div>
                </div>
                {r.checkedIn ? (
                  <span className="shrink-0 rounded-full bg-green-500/15 px-2 py-0.5 text-xs font-semibold text-green-300">
                    ✓ In
                  </span>
                ) : (
                  <span className="shrink-0 rounded-full bg-white/10 px-2 py-0.5 text-xs font-medium text-white/50">
                    Not yet
                  </span>
                )}
              </div>
              <div className="mt-3 space-y-1 text-sm">
                <div className="flex justify-between gap-3">
                  <span className="text-white/50">Phone</span>
                  <span className="text-right text-white/90">{fmtPhone(r.phone) || "—"}</span>
                </div>
                {r.racing && (
                  <div className="flex justify-between gap-3">
                    <span className="text-white/50">Racing</span>
                    <span className="text-right text-white/90">{r.racing}</span>
                  </div>
                )}
                {r.gelBlaster && (
                  <div className="flex justify-between gap-3">
                    <span className="text-white/50">Gel Blaster</span>
                    <span className="text-right text-white/90">{r.gelBlaster}</span>
                  </div>
                )}
                {r.laserTag && (
                  <div className="flex justify-between gap-3">
                    <span className="text-white/50">Laser Tag</span>
                    <span className="text-right text-white/90">{r.laserTag}</span>
                  </div>
                )}
                {r.freeflow && (
                  <div className="flex justify-between gap-3">
                    <span className="text-white/50">Free-flow</span>
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
                    <div className="mt-0.5 text-white/50">stay with: {r.conflictStayWith}</div>
                  )}
                </div>
              )}
            </div>
          ))}
          {filtered.length === 0 && (
            <p className="rounded-xl border border-white/10 bg-white/5 p-6 text-center text-white/40">
              No guests match.
            </p>
          )}
        </div>

        {/* Tablet/desktop: full table */}
        <div className="hidden overflow-x-auto rounded-lg border border-white/10 md:block">
          <table className="w-full min-w-[760px] border-collapse text-sm">
            <thead>
              <tr className="bg-white/5 text-left text-xs uppercase tracking-wide text-white/50">
                <th className="px-3 py-2 font-semibold">Name</th>
                <th className="px-3 py-2 font-semibold">Phone</th>
                <th className="px-3 py-2 font-semibold">Racing</th>
                <th className="px-3 py-2 font-semibold">Gel Blaster</th>
                <th className="px-3 py-2 font-semibold">Laser Tag</th>
                <th className="px-3 py-2 font-semibold">Free-flow</th>
                <th className="px-3 py-2 font-semibold">Check-in</th>
                <th className="px-3 py-2 font-semibold">Conflict / fix</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.email} className="border-t border-white/10 align-top">
                  <td className="px-3 py-2">
                    <div className="font-medium text-white">{r.name}</div>
                    <div className="text-xs text-white/40">{r.email}</div>
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-white/80">
                    {fmtPhone(r.phone) || "—"}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-white/80">{r.racing || "—"}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-white/80">
                    {r.gelBlaster || "—"}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-white/80">{r.laserTag || "—"}</td>
                  <td className="px-3 py-2 text-xs text-white/50">{r.freeflow || "—"}</td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {r.checkedIn ? (
                      <span className="rounded-full bg-green-500/15 px-2 py-0.5 text-xs font-semibold text-green-300">
                        ✓ Checked in
                      </span>
                    ) : (
                      <span className="rounded-full bg-white/10 px-2 py-0.5 text-xs font-medium text-white/50">
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
                          <div className="text-white/40">unresolved</div>
                        )}
                        {r.conflictStayWith && (
                          <div className="mt-0.5 text-white/50">
                            stay with: {r.conflictStayWith}
                          </div>
                        )}
                      </>
                    ) : (
                      <span className="text-white/30">—</span>
                    )}
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-3 py-8 text-center text-white/40">
                    No guests match.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <p className="mt-3 text-xs text-white/40">
          &ldquo;Checked in&rdquo; = guest completed the confirm/check-in flow. Reload to refresh.
        </p>
      </div>
    </div>
  );
}
