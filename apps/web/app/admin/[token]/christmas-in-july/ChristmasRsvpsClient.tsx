"use client";

import { useMemo, useState } from "react";
import type { GroupEventRsvp } from "@/app/api/group-event/rsvp/route";

import { ADMIN_SANS, PORTAL_BLUE, PORTAL_DARK } from "~/components/features/admin-skin/theme";

/** Portal-skin shared inline styles (style-only re-skin, 2026-07-13). */
const cardStyle = {
  backgroundColor: PORTAL_DARK.card,
  border: `1px solid ${PORTAL_DARK.border}`,
  borderRadius: 8,
} as const;
const mutedText = { color: PORTAL_DARK.muted } as const;

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
    <div
      className="min-h-screen px-4 py-8"
      style={{
        fontFamily: ADMIN_SANS,
        background: PORTAL_DARK.bodyGradient,
        color: PORTAL_DARK.fg,
      }}
    >
      <div className="mx-auto max-w-6xl">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1
              className="uppercase tracking-widest"
              style={{ fontSize: "1.5rem", fontWeight: 700 }}
            >
              Christmas in July
            </h1>
            <p className="mt-1 text-sm" style={mutedText}>
              RSVPs &amp; booked races
            </p>
          </div>
          <button
            onClick={exportCsv}
            disabled={filtered.length === 0}
            className="rounded-lg px-4 py-2 text-sm hover:opacity-90 disabled:opacity-40"
            style={{ backgroundColor: PORTAL_BLUE, color: "#ffffff", fontWeight: 600 }}
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
            <div key={s.label} className="p-4" style={cardStyle}>
              <p className="text-2xl font-bold">{s.value}</p>
              <p className="text-xs" style={mutedText}>
                {s.label}
              </p>
            </div>
          ))}
        </div>

        {/* Center filter */}
        <div className="mb-4 flex flex-wrap gap-2">
          {CENTERS.map((c) => (
            <button
              key={c.id}
              onClick={() => setCenter(c.id)}
              className={`px-4 py-1.5 text-sm transition-colors ${
                center === c.id ? "" : "hover:bg-[#22345e]"
              }`}
              style={
                center === c.id
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
              {c.label}
            </button>
          ))}
        </div>

        {/* Table */}
        <div
          className="overflow-x-auto rounded-lg"
          style={{ backgroundColor: PORTAL_DARK.card, border: `1px solid ${PORTAL_DARK.border}` }}
        >
          <table className="w-full text-left text-sm">
            <thead
              className="text-xs uppercase tracking-wider"
              style={{ backgroundColor: PORTAL_DARK.muted2, color: PORTAL_DARK.muted }}
            >
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
                  <td colSpan={8} className="px-3 py-8 text-center" style={mutedText}>
                    No RSVPs yet.
                  </td>
                </tr>
              ) : (
                filtered.map((r) => {
                  const race = raceFor(r);
                  return (
                    <tr
                      key={r.email}
                      className="border-t hover:bg-[#22345e]"
                      style={{ borderColor: PORTAL_DARK.border }}
                    >
                      <td className="px-3 py-2 font-medium">{r.name}</td>
                      <td className="px-3 py-2 text-white/70">{r.company || "—"}</td>
                      <td className="px-3 py-2 text-white/70">
                        <div>{r.email}</div>
                        {r.phone && <div style={mutedText}>{fmtPhone(r.phone)}</div>}
                      </td>
                      <td className="px-3 py-2 text-white/70">
                        {CENTER_LABEL[r.location ?? ""] ?? "—"}
                      </td>
                      <td className="px-3 py-2 text-white/70">{1 + (Number(r.guests) || 0)}</td>
                      <td className="px-3 py-2">
                        {race ? (
                          <span className="font-medium text-emerald-300">{race}</span>
                        ) : (
                          <span style={mutedText}>—</span>
                        )}
                      </td>
                      <td className="px-3 py-2" style={mutedText}>
                        {r.smsConsent ? "Yes" : "No"}
                      </td>
                      <td className="px-3 py-2" style={mutedText}>
                        {fmtWhen(r.updatedAt)}
                      </td>
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
