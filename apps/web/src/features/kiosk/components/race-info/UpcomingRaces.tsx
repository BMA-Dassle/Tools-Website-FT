"use client";

/**
 * Race Info hub — "Upcoming Races" sub-screen (view-only).
 *
 * Live race status on top (Now Checking In + per-track delay, same feed as
 * the website's TrackStatus widget), then today's availability grid:
 * Blue/Red track filter (Mega replaces both on Mega Tuesdays), Adult and
 * Junior as separate labeled sections, compact booking-grid-sized cards.
 * Starter heats render bright with live spots-left per the real restriction
 * engine; Intermediate/Pro render greyed "Returning drivers only"
 * (useRaceGridDisplay carries those rules). NOTHING here is tappable — the
 * Book Now bar on the hub landing is the booking entry.
 */
import { useState } from "react";
import { IconLock } from "@tabler/icons-react";
import { useTrackStatus, type CurrentRace } from "@/hooks/useTrackStatus";
import { useKioskConfig } from "../../KioskConfigContext";
import {
  useRaceGridDisplay,
  type DisplayHeat,
  type DisplayTrack,
} from "../../hooks/useRaceGridDisplay";

const TRACK_ACCENT: Record<DisplayTrack, string> = {
  Red: "#e53935",
  Blue: "#4fa9ff",
  Mega: "#8652ff",
};

function checkinLabel(race: CurrentRace): string {
  let time = "";
  try {
    time = new Date(race.scheduledStart).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: "America/New_York",
    });
  } catch {
    /* keep empty */
  }
  return `Now Checking In · ${race.raceType} Heat #${race.heatNumber}${time ? ` · ${time}` : ""}`;
}

/** Live status band — kiosk-scaled port of components/home/TrackStatus. */
function StatusBand() {
  const result = useTrackStatus();
  if (!result) return null;
  const { trackStatus, currentRaces } = result;
  const races = [currentRaces.mega, currentRaces.blue, currentRaces.red].filter(
    (r): r is CurrentRace => !!r,
  );

  return (
    <div className="rounded-[28px] border border-[#f0b341]/30 bg-[#f0b341]/5 p-[28px]">
      {races.length > 0 && (
        <div className="mb-[20px] flex flex-col gap-[8px]">
          {races.map((race) => (
            <div
              key={race.sessionId}
              className="k-display animate-pulse text-[32px] text-[#f0b341]"
            >
              {checkinLabel(race)}
            </div>
          ))}
        </div>
      )}
      <div className="flex gap-[20px]">
        {trackStatus.tracks.map((t) => (
          <div
            key={t.trackName}
            className="flex flex-1 items-center gap-[16px] rounded-[18px] border px-[24px] py-[16px]"
            style={{ borderColor: `${t.colors.trackIdentity}55`, background: "rgba(0,0,0,0.25)" }}
          >
            <span
              className="h-[16px] w-[16px] shrink-0 rounded-full"
              style={{
                background:
                  t.status === "ok" ? "#46d68c" : t.status === "delayed" ? "#f0b341" : "#e53935",
                boxShadow: `0 0 14px ${
                  t.status === "ok" ? "#46d68c" : t.status === "delayed" ? "#f0b341" : "#e53935"
                }`,
              }}
            />
            <span className="flex-1 text-[28px] font-semibold text-white">{t.trackName}</span>
            <span className="k-num text-[26px] font-bold" style={{ color: t.colors.trackIdentity }}>
              {t.delayFormatted || "On Time"}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function HeatCard({ heat }: { heat: DisplayHeat }) {
  const accent = TRACK_ACCENT[heat.track];
  const greyed =
    heat.status === "full" || heat.status === "restricted" || heat.status === "returning-only";
  const pct = heat.capacity > 0 ? heat.freeSpots / heat.capacity : 0;
  const barColor = pct <= 0.15 ? "#e53935" : pct <= 0.3 ? "#f0b341" : "#46d68c";

  return (
    <div
      className={`relative overflow-hidden rounded-[18px] border bg-[#071027] px-[22px] py-[18px] ${
        greyed ? "opacity-40 grayscale" : ""
      }`}
      style={{ borderColor: "rgba(255,255,255,0.1)" }}
    >
      <span
        className="absolute bottom-0 left-0 top-0 w-[7px]"
        style={{ background: accent }}
        aria-hidden="true"
      />
      <div className="flex items-baseline justify-between gap-[8px] pl-[10px]">
        <span className="k-display k-num whitespace-nowrap text-[31px]">{heat.timeLabel}</span>
        <span
          className="rounded-full px-[11px] py-[3px] text-[16px] font-bold uppercase tracking-wide"
          style={{ background: `${accent}29`, color: accent }}
        >
          {heat.track}
        </span>
      </div>
      <div className="mt-[4px] pl-[10px] text-[22px] font-semibold text-white/65 capitalize">
        {heat.tier}
      </div>
      {greyed ? (
        <div className="mt-[14px] flex items-center gap-[8px] pl-[10px] text-[19px] font-bold uppercase tracking-wide text-white/50">
          {heat.status === "returning-only" && <IconLock size={20} aria-hidden="true" />}
          {heat.statusLabel}
        </div>
      ) : (
        <div className="mt-[14px] pl-[10px]">
          <div className="h-[8px] overflow-hidden rounded-full bg-white/10">
            <div
              className="h-full rounded-full"
              style={{ width: `${Math.max(6, pct * 100)}%`, background: barColor }}
            />
          </div>
          <div className="k-num mt-[6px] text-[19px] font-semibold text-white/70">
            {heat.freeSpots} spot{heat.freeSpots === 1 ? "" : "s"} left
          </div>
        </div>
      )}
    </div>
  );
}

function HeatSection({ label, heats }: { label: string; heats: DisplayHeat[] }) {
  if (heats.length === 0) return null;
  return (
    <div>
      <div className="mb-[16px] flex items-center gap-[20px]">
        <span className="k-eyebrow">{label}</span>
        <span className="h-px flex-1 bg-white/10" aria-hidden="true" />
      </div>
      <div className="grid grid-cols-3 gap-[16px]">
        {heats.map((h) => (
          <HeatCard key={h.key} heat={h} />
        ))}
      </div>
    </div>
  );
}

export function UpcomingRaces() {
  const { config } = useKioskConfig();
  const { heats, tracks, isLoading, isError } = useRaceGridDisplay(config?.center ?? "fort-myers");
  const [trackFilter, setTrackFilter] = useState<DisplayTrack | null>(null);
  const activeFilter = trackFilter && tracks.includes(trackFilter) ? trackFilter : null;

  const visible = activeFilter ? heats.filter((h) => h.track === activeFilter) : heats;
  const adult = visible.filter((h) => h.category === "adult");
  const junior = visible.filter((h) => h.category === "junior");

  return (
    <div className="flex flex-col gap-[32px] pb-[48px]">
      <StatusBand />

      {/* Track filter — only when today spans more than one track. */}
      {tracks.length > 1 && (
        <div className="flex gap-[16px]">
          <button
            type="button"
            className={`k-chip k-tap flex-1 ${activeFilter === null ? "sel" : ""}`}
            onClick={() => setTrackFilter(null)}
          >
            All tracks
          </button>
          {tracks.map((t) => (
            <button
              key={t}
              type="button"
              className={`k-chip k-tap flex-1 ${activeFilter === t ? "sel" : ""}`}
              style={activeFilter === t ? { borderColor: TRACK_ACCENT[t] } : undefined}
              onClick={() => setTrackFilter((cur) => (cur === t ? null : t))}
            >
              <span style={{ color: TRACK_ACCENT[t] }}>{t} Track</span>
            </button>
          ))}
        </div>
      )}

      {isLoading && heats.length === 0 ? (
        <div className="py-[80px] text-center text-[30px] text-white/50">
          Loading today&rsquo;s races…
        </div>
      ) : isError ? (
        <div className="py-[80px] text-center text-[30px] text-white/50">
          Race times aren&rsquo;t loading right now — our crew at the front desk has the full
          schedule.
        </div>
      ) : visible.length === 0 ? (
        <div className="py-[80px] text-center text-[30px] text-white/50">
          No more races on the board today.
        </div>
      ) : (
        <>
          <HeatSection label="Adult" heats={adult} />
          <HeatSection label="Junior" heats={junior} />
          <div className="text-center text-[22px] text-white/40">
            Starter races are open to everyone — Intermediate &amp; Pro unlock by qualifying lap
            time. Tap Book Now on the previous screen to grab a seat.
          </div>
        </>
      )}
    </div>
  );
}
