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
    <div className="rounded-lg border border-slate-200 bg-white px-4 py-3 text-center">
      <div className="text-2xl font-bold" style={{ color }}>
        {value}
      </div>
      <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
    </div>
  );

  const filterBtn = (key: Filter, label: string) => (
    <button
      type="button"
      onClick={() => setFilter(key)}
      className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
        filter === key ? "bg-slate-900 text-white" : "bg-white text-slate-600 hover:bg-slate-100"
      }`}
    >
      {label}
    </button>
  );

  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      <div className="mb-1 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Healthcare Network Team Day</h1>
          <p className="text-sm text-slate-500">
            Friday, June 19 · 9 AM – 2 PM · HeadPinz Fort Myers
          </p>
        </div>
        <button
          type="button"
          onClick={exportCsv}
          className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
        >
          Export CSV
        </button>
      </div>

      <div className="my-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {chip("RSVPs", counts.total, "#0f172a")}
        {chip("Checked in", counts.checkedIn, "#16a34a")}
        {chip("Have phone", counts.withPhone, "#0d9aa0")}
        {chip("Racing", counts.racing, "#2563eb")}
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          type="search"
          aria-label="Search by name, email, or phone"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search name / email / phone…"
          className="w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-500"
        />
        <div className="flex gap-1.5">
          {filterBtn("all", `All (${counts.total})`)}
          {filterBtn("in", `Checked in (${counts.checkedIn})`)}
          {filterBtn("out", `Not yet (${counts.total - counts.checkedIn})`)}
        </div>
        <span className="ml-auto text-sm text-slate-500">{filtered.length} shown</span>
      </div>

      <div className="overflow-x-auto rounded-lg border border-slate-200">
        <table className="w-full min-w-[760px] border-collapse text-sm">
          <thead>
            <tr className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="px-3 py-2 font-semibold">Name</th>
              <th className="px-3 py-2 font-semibold">Phone</th>
              <th className="px-3 py-2 font-semibold">Racing</th>
              <th className="px-3 py-2 font-semibold">Gel Blaster</th>
              <th className="px-3 py-2 font-semibold">Laser Tag</th>
              <th className="px-3 py-2 font-semibold">Free-flow</th>
              <th className="px-3 py-2 font-semibold">Check-in</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr key={r.email} className="border-t border-slate-100 align-top">
                <td className="px-3 py-2">
                  <div className="font-medium text-slate-900">{r.name}</div>
                  <div className="text-xs text-slate-400">{r.email}</div>
                </td>
                <td className="px-3 py-2 whitespace-nowrap text-slate-700">
                  {fmtPhone(r.phone) || "—"}
                </td>
                <td className="px-3 py-2 whitespace-nowrap">{r.racing || "—"}</td>
                <td className="px-3 py-2 whitespace-nowrap">{r.gelBlaster || "—"}</td>
                <td className="px-3 py-2 whitespace-nowrap">{r.laserTag || "—"}</td>
                <td className="px-3 py-2 text-xs text-slate-500">{r.freeflow || "—"}</td>
                <td className="px-3 py-2 whitespace-nowrap">
                  {r.checkedIn ? (
                    <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-semibold text-green-700">
                      ✓ Checked in
                    </span>
                  ) : (
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500">
                      Not yet
                    </span>
                  )}
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center text-slate-400">
                  No guests match.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="mt-3 text-xs text-slate-400">
        &ldquo;Checked in&rdquo; = guest completed the confirm/check-in flow. Reload to refresh.
      </p>
    </main>
  );
}
