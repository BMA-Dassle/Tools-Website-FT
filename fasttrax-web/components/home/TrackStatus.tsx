"use client";

import { useTrackStatus } from "@/hooks/useTrackStatus";

function dotColor(status: string) {
  return status === "ok" ? "bg-green-400" : status === "delayed" ? "bg-yellow-400" : "bg-red-400";
}

export default function TrackStatus() {
  const data = useTrackStatus();

  if (!data) return null;

  return (
    <section className="bg-[#010A20] border-y border-white/10 py-4">
      <div className="max-w-7xl mx-auto px-4">
        <div className="flex flex-col sm:flex-row items-center gap-4 sm:gap-8">
          <span className="font-[var(--font-anton)] italic text-white/40 text-sm uppercase tracking-widest">
            Live Track Status
          </span>
          <div className="flex flex-wrap gap-4">
            {data.megaTrackEnabled && (
              <div
                className="flex items-center gap-3 bg-[#071027] border px-4 py-2 rounded-lg"
                style={{ borderColor: "rgba(134,82,255,0.4)" }}
              >
                <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
                <span className="font-[var(--font-poppins)] font-semibold text-white text-sm">
                  Mega Track
                </span>
                <span className="font-[var(--font-poppins)] text-xs font-bold" style={{ color: "rgb(134,82,255)" }}>
                  Active
                </span>
              </div>
            )}
            {data.tracks.map((t) => (
              <div
                key={t.trackName}
                className="flex items-center gap-3 bg-[#071027] border px-4 py-2 rounded-lg"
                style={{ borderColor: `${t.colors.trackIdentity}40` }}
              >
                <span className={`w-2 h-2 rounded-full ${dotColor(t.status)} animate-pulse`} />
                <span className="font-[var(--font-poppins)] font-semibold text-white text-sm">
                  {t.trackName}
                </span>
                <span
                  className="font-[var(--font-poppins)] text-xs font-bold"
                  style={{ color: t.colors.trackIdentity }}
                >
                  {t.delayFormatted}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
