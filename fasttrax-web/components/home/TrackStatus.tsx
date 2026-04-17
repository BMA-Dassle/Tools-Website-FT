"use client";

import { useTrackStatus, type CurrentRace } from "@/hooks/useTrackStatus";

function dotColor(status: string) {
  return status === "ok" ? "bg-green-400" : status === "delayed" ? "bg-yellow-400" : "bg-red-400";
}

function formatShortTime(iso: string) {
  try {
    return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });
  } catch { return ""; }
}

function CheckingInTag({ race }: { race: CurrentRace }) {
  const time = race.scheduledStart ? formatShortTime(race.scheduledStart) : "";
  return (
    <span className="text-amber-400 text-[11px] font-bold animate-pulse">
      Now Checking In: {race.raceType} Heat #{race.heatNumber}{time ? ` · ${time}` : ""}
    </span>
  );
}

export default function TrackStatus() {
  const result = useTrackStatus();

  if (!result) return null;
  const { trackStatus: data, currentRaces } = result;

  return (
    <section className="bg-[#010A20] border-y border-white/10 py-4">
      <div className="max-w-7xl mx-auto px-4">
        <div className="flex flex-col sm:flex-row items-center gap-4 sm:gap-8">
          <span className="font-heading font-bold text-white/40 text-sm uppercase tracking-widest">
            Live Track Status
          </span>
          <div className="flex flex-wrap gap-4">
            {data.megaTrackEnabled ? (
              <div
                className="flex items-center gap-3 bg-[#071027] border px-4 py-2 rounded-lg"
                style={{ borderColor: "rgba(134,82,255,0.4)" }}
              >
                <div className="flex flex-col">
                  <div className="flex items-center gap-3">
                    <span className={`w-2 h-2 rounded-full ${dotColor(data.tracks[0]?.status || "ok")} animate-pulse`} />
                    <span className="font-body font-semibold text-white text-sm">
                      Mega Track
                    </span>
                    <span className="font-body text-xs font-bold" style={{ color: "rgb(134,82,255)" }}>
                      {data.tracks[0]?.delayFormatted || "On Time"}
                    </span>
                  </div>
                  {currentRaces.mega && <CheckingInTag race={currentRaces.mega} />}
                </div>
              </div>
            ) : (
              data.tracks.map((t) => {
                const key = t.trackName.toLowerCase().replace(/\s+track/i, "") as "blue" | "red" | "mega";
                const race = currentRaces[key] || null;
                return (
                  <div
                    key={t.trackName}
                    className="flex items-center gap-3 bg-[#071027] border px-4 py-2 rounded-lg"
                    style={{ borderColor: `${t.colors.trackIdentity}40` }}
                  >
                    <div className="flex flex-col">
                      <div className="flex items-center gap-3">
                        <span className={`w-2 h-2 rounded-full ${dotColor(t.status)} animate-pulse`} />
                        <span className="font-body font-semibold text-white text-sm">
                          {t.trackName}
                        </span>
                        <span
                          className="font-body text-xs font-bold"
                          style={{ color: t.colors.trackIdentity }}
                        >
                          {t.delayFormatted}
                        </span>
                      </div>
                      {race && <CheckingInTag race={race} />}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
