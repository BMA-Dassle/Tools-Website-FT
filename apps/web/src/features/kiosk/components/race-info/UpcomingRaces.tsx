"use client";

/**
 * Race Info hub — "Upcoming Races" sub-screen (view-only).
 *
 * Live race status on top (Now Checking In + per-track delay, same feed as
 * the website's TrackStatus widget), then today's availability in the SAME
 * compact card treatment as the booking heat picker (4-across, track badge,
 * time, spots label, capacity bar — owner 2026-07-21: "use the grid size we
 * show when booking"). Every tier renders alike; a heat only greys out when
 * the booking rules say it isn't bookable right now (too soon / full /
 * restriction-blocked) — see useRaceGridDisplay. Adult/Junior is a filter,
 * as is Blue/Red (Mega replaces both on Mega Tuesdays). NOTHING here is
 * tappable — the Book Now bar on the hub landing is the booking entry.
 */
import { useState } from "react";
import { IconAlertTriangle } from "@tabler/icons-react";
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

// The booking grid's track-badge palette (steps/race/track-visuals.tsx),
// canvas-scaled.
const TRACK_BADGE: Record<DisplayTrack, string> = {
  Red: "bg-red-500/20 text-red-300",
  Blue: "bg-blue-500/20 text-blue-300",
  Mega: "bg-purple-500/20 text-purple-300",
};

const TIER_LABEL: Record<DisplayHeat["tier"], string> = {
  starter: "Starter",
  intermediate: "Intermediate",
  pro: "Pro",
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
  return `${race.raceType} Heat #${race.heatNumber}${time ? ` · ${time}` : ""}`;
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
        <div className="mb-[20px] flex flex-col gap-[6px]">
          <div className="k-display flex items-center gap-[12px] text-[20px] tracking-wide text-[#f0b341]/70">
            <span className="h-[12px] w-[12px] animate-pulse rounded-full bg-[#f0b341]" />
            Now Checking In
          </div>
          {races.map((race) => (
            <div key={race.sessionId} className="k-display text-[30px] text-[#f0b341]">
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

/** One heat — the booking picker's card language at kiosk-canvas scale. */
function HeatCard({ heat }: { heat: DisplayHeat }) {
  const greyed = heat.status !== "open" && heat.status !== "low";
  const pct = heat.capacity > 0 ? heat.freeSpots / heat.capacity : 0;

  const spotsClass =
    heat.status === "full"
      ? "text-red-400"
      : heat.status === "low"
        ? "text-amber-400"
        : greyed
          ? "text-white/50"
          : "text-emerald-400";
  const spotsLabel = greyed
    ? heat.statusLabel
    : `${heat.freeSpots} spot${heat.freeSpots === 1 ? "" : "s"} left`;

  return (
    <div
      className={`rounded-[16px] border p-[16px] ${
        greyed ? "border-white/5 bg-white/[0.03] opacity-40" : "border-white/10 bg-white/5"
      }`}
    >
      <div className="mb-[8px] flex items-center justify-between gap-[8px]">
        <span
          className={`inline-flex items-center rounded-[6px] px-[9px] py-[3px] text-[13px] font-bold uppercase tracking-wide ${TRACK_BADGE[heat.track]}`}
        >
          {heat.track}
        </span>
        <span className="text-[14px] font-medium text-white/50">{TIER_LABEL[heat.tier]}</span>
      </div>
      <div className="k-num whitespace-nowrap text-[24px] font-bold text-white">
        {heat.timeLabel}
      </div>
      <div className={`mt-[4px] text-[16px] font-medium ${spotsClass}`}>{spotsLabel}</div>
      <div className="mt-[10px] h-[5px] overflow-hidden rounded-full bg-white/10">
        <div
          className={`h-full rounded-full ${
            heat.status === "full" ? "bg-red-500" : pct <= 0.3 ? "bg-amber-400" : "bg-emerald-400"
          }`}
          style={{ width: `${pct * 100}%` }}
        />
      </div>
    </div>
  );
}

export function UpcomingRaces() {
  const { config } = useKioskConfig();
  const { heats, tracks, schedule, isLoading, isError } = useRaceGridDisplay(
    config?.center ?? "fort-myers",
  );
  const [trackFilter, setTrackFilter] = useState<DisplayTrack | null>(null);
  const [classFilter, setClassFilter] = useState<"adult" | "junior">("adult");
  const activeTrack = trackFilter && tracks.includes(trackFilter) ? trackFilter : null;

  const visible = heats.filter(
    (h) => h.category === classFilter && (!activeTrack || h.track === activeTrack),
  );

  // The Junior-on-Mega rule only matters on a Mega day, and only when a guest
  // is actually looking for Junior races — juniors don't run the Mega Track,
  // so the board is (correctly) empty. Show the notice in place of the generic
  // empty state; keep it off the board entirely on Red/Blue days.
  const showMegaNoJunior = schedule === "mega" && classFilter === "junior";

  return (
    <div className="flex flex-col gap-[28px] pb-[48px]">
      <StatusBand />

      {/* Filters: track (only when today spans more than one) + Adult/Junior. */}
      <div className="flex gap-[16px]">
        {tracks.length > 1 && (
          <>
            <button
              type="button"
              className={`k-chip k-tap flex-1 ${activeTrack === null ? "sel" : ""}`}
              onClick={() => setTrackFilter(null)}
            >
              All
            </button>
            {tracks.map((t) => (
              <button
                key={t}
                type="button"
                className={`k-chip k-tap flex-1 ${activeTrack === t ? "sel" : ""}`}
                style={activeTrack === t ? { borderColor: TRACK_ACCENT[t] } : undefined}
                onClick={() => setTrackFilter((cur) => (cur === t ? null : t))}
              >
                <span style={{ color: TRACK_ACCENT[t] }}>{t}</span>
              </button>
            ))}
            <span className="mx-[8px] w-px self-stretch bg-white/10" aria-hidden="true" />
          </>
        )}
        <button
          type="button"
          className={`k-chip k-tap flex-1 ${classFilter === "adult" ? "sel" : ""}`}
          onClick={() => setClassFilter("adult")}
        >
          Adult
        </button>
        <button
          type="button"
          className={`k-chip k-tap flex-1 ${classFilter === "junior" ? "sel" : ""}`}
          onClick={() => setClassFilter("junior")}
        >
          Junior
        </button>
      </div>

      {isLoading && heats.length === 0 ? (
        <div className="py-[80px] text-center text-[30px] text-white/50">
          Loading today&rsquo;s races…
        </div>
      ) : isError ? (
        <div className="py-[80px] text-center text-[30px] text-white/50">
          Race times aren&rsquo;t loading right now — our crew at the front desk has the full
          schedule.
        </div>
      ) : showMegaNoJunior ? (
        // Mega day + Junior filter: the board is empty by design — explain why.
        <div className="flex flex-col items-center gap-[16px] rounded-[24px] border border-[#e53935]/40 bg-[#e53935]/10 px-[32px] py-[56px] text-center">
          <IconAlertTriangle size={48} className="text-[#ff5a52]" aria-hidden="true" />
          <div className="text-[32px] font-bold text-[#ff5a52]">
            No Junior races on the Mega Track
          </div>
          <div className="max-w-[520px] text-[22px] leading-snug text-white/50">
            The Mega Track runs adults only. Check back on a Red &amp; Blue day for Junior heats.
          </div>
        </div>
      ) : visible.length === 0 ? (
        <div className="py-[80px] text-center text-[30px] text-white/50">
          No more {classFilter} races on the board today.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-4 gap-[16px]">
            {visible.map((h) => (
              <HeatCard key={h.key} heat={h} />
            ))}
          </div>
          <div className="text-center text-[22px] text-white/40">
            Intermediate &amp; Pro require a qualifying lap time — everyone starts in Starter. Tap
            Book Now on the previous screen to grab a seat.
          </div>
        </>
      )}
    </div>
  );
}
