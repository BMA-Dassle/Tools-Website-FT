"use client";

import { useMemo, useState } from "react";
import type { GroupEventRsvp } from "@/app/api/group-event/rsvp/route";

const CENTERS = [
  { id: "all", label: "All centers" },
  { id: "fort-myers", label: "Fort Myers" },
  { id: "naples", label: "Naples" },
] as const;
type CenterId = (typeof CENTERS)[number]["id"];

const CENTER_LABEL: Record<string, string> = {
  "fort-myers": "Fort Myers",
  naples: "Naples",
};

function fmtTime(iso?: string): string {
  if (!iso) return "";
  const tp = iso.replace(/Z$/, "").split("T")[1];
  if (!tp) return "";
  const [h, m] = tp.split(":").map(Number);
  const hr = ((h + 11) % 12) + 1;
  return `${hr}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

function fmtPhone(p?: string): string {
  if (!p) return "";
  const d = p.replace(/\D/g, "");
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : p;
}

function fmtWhen(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** The booked race for a guest, if any ("Red Track · 4:30 PM"). */
function raceFor(r: GroupEventRsvp): string {
  const race = r.reservations?.find((x) => x.type === "racing");
  if (!race) return "";
  return `${race.track ? `${race.track} Track` : "Race"}${race.time ? ` · ${fmtTime(race.time)}` : ""}`;
}

export default function ChristmasRsvpsClient({ rows }: { rows: GroupEventRsvp[] }) {
  const [center, setCenter] = useState<CenterId>("all");

  const filtered = useMemo(
    () => (center === "all" ? rows : rows.filter((r) => r.location === center)),
    [rows, center],
  );

  const counts = useMemo(() => {
    const racers = filtered.filter((r) => r.reservations?.some((x) => x.type === "racing")).length;
    const heads = filtered.reduce((sum, r) => sum + 1 + (Number(r.guests) || 0), 0);
    return { rsvps: filtered.length, racers, heads };
  }, [filtered]);

  function exportCsv() {
    const header = [
      "Name",
      "Company",
      "Email",
      "Phone",
      "Center",
      "Guests",
      "Headcount",
      "Race",
      "SMS Opt-in",
      "RSVP'd",
    ];
    const lines = filtered.map((r) =>
      [
        r.name ?? "",
        r.company ?? "",
        r.email ?? "",
        fmtPhone(r.phone),
        CENTER_LABEL[r.location ?? ""] ?? r.location ?? "",
        String(Number(r.guests) || 0),
        String(1 + (Number(r.guests) || 0)),
        raceFor(r),
        r.smsConsent ? "Yes" : "No",
        r.updatedAt ?? "",
      ]
        .map((v) => `"${String(v).replace(/"/g, '""')}"`)
        .join(","),
    );
    const csv = [header.join(","), ...lines].join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `christmas-in-july-rsvps-${center}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="min-h-screen bg-[#0a1120] px-4 py-8 text-white">
      <div className="mx-auto max-w-6xl">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="font-display text-2xl uppercase tracking-widest">Christmas in July</h1>
            <p className="mt-1 text-sm text-white/50">RSVPs &amp; booked races</p>
          </div>
          <button
            onClick={exportCsv}
            disabled={filtered.length === 0}
            className="rounded-lg border border-white/20 px-4 py-2 text-sm font-semibold hover:bg-white/10 disabled:opacity-40"
          >
            Export CSV
          </button>
        </div>

        {/* Summary */}
        <div className="mb-6 grid grid-cols-3 gap-3">
          {[
            { label: "RSVPs", value: counts.rsvps },
            { label: "Total headcount", value: counts.heads },
            { label: "Booked a race", value: counts.racers },
          ].map((s) => (
            <div key={s.label} className="rounded-xl border border-white/10 bg-white/5 p-4">
              <p className="text-2xl font-bold">{s.value}</p>
              <p className="text-xs text-white/50">{s.label}</p>
            </div>
          ))}
        </div>

        {/* Center filter */}
        <div className="mb-4 flex gap-2">
          {CENTERS.map((c) => (
            <button
              key={c.id}
              onClick={() => setCenter(c.id)}
              className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
                center === c.id
                  ? "bg-white text-[#0a1120]"
                  : "border border-white/20 text-white/70 hover:bg-white/10"
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>

        {/* Table */}
        <div className="overflow-x-auto rounded-xl border border-white/10">
          <table className="w-full text-left text-sm">
            <thead className="bg-white/5 text-xs uppercase tracking-wider text-white/50">
              <tr>
                <th className="px-3 py-2">Name</th>
                <th className="px-3 py-2">Company</th>
                <th className="px-3 py-2">Contact</th>
                <th className="px-3 py-2">Center</th>
                <th className="px-3 py-2">Party</th>
                <th className="px-3 py-2">Race</th>
                <th className="px-3 py-2">SMS</th>
                <th className="px-3 py-2">RSVP&rsquo;d</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-3 py-8 text-center text-white/40">
                    No RSVPs yet.
                  </td>
                </tr>
              ) : (
                filtered.map((r) => {
                  const race = raceFor(r);
                  return (
                    <tr key={r.email} className="border-t border-white/5 hover:bg-white/5">
                      <td className="px-3 py-2 font-medium">{r.name}</td>
                      <td className="px-3 py-2 text-white/70">{r.company || "—"}</td>
                      <td className="px-3 py-2 text-white/70">
                        <div>{r.email}</div>
                        {r.phone && <div className="text-white/40">{fmtPhone(r.phone)}</div>}
                      </td>
                      <td className="px-3 py-2 text-white/70">
                        {CENTER_LABEL[r.location ?? ""] ?? "—"}
                      </td>
                      <td className="px-3 py-2 text-white/70">{1 + (Number(r.guests) || 0)}</td>
                      <td className="px-3 py-2">
                        {race ? (
                          <span className="font-medium text-emerald-300">{race}</span>
                        ) : (
                          <span className="text-white/30">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-white/50">{r.smsConsent ? "Yes" : "No"}</td>
                      <td className="px-3 py-2 text-white/40">{fmtWhen(r.updatedAt)}</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
