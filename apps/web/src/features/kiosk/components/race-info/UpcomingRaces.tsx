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
import { slotMsOf } from "@/components/home/TrackTimingChip";
import {
  roundPredictedMs,
  shouldShowPrediction,
  trackDisplay,
} from "~/features/racing/on-time-display";
import { useKioskConfig } from "../../KioskConfigContext";
import {
  useRaceGridDisplay,
  type DisplayHeat,
  type DisplayTrack,
} from "../../hooks/useRaceGridDisplay";
import { useT } from "../../i18n";

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

// Tier names are racing proper nouns — kept untranslated across the hub.
const TIER_LABEL: Record<DisplayHeat["tier"], string> = {
  starter: "Starter",
  intermediate: "Intermediate",
  pro: "Pro",
};

/** Wall-clock ET, e.g. "7:40 PM". The digits are locale-neutral; the words
 *  around them come from the catalog, which is why this returns a time and not
 *  a sentence. */
function etClock(ms: number): string {
  try {
    return new Date(ms).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: "America/New_York",
    });
  } catch {
    return "";
  }
}

// TODO(i18n): module-scope helper (can't reach useT). Builds "{raceType} Heat
// #{n} · {time}"; raceType is server data that stays English, so the "Heat #"
// label stays English with it until this is threaded through a component.
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
  const t = useT();
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
            {t("raceInfo.upcoming.nowCheckingIn")}
          </div>
          {races.map((race) => (
            <div key={race.sessionId} className="k-display text-[30px] text-[#f0b341]">
              {checkinLabel(race)}
            </div>
          ))}
        </div>
      )}
      <div className="flex gap-[20px]">
        {trackStatus.tracks.map((track) => {
          const key = track.trackName.toLowerCase().replace(/\s+track/i, "");
          const race = currentRaces[key as "blue" | "red" | "mega"] ?? null;
          const d = trackDisplay(result.onTime, key, slotMsOf(race));
          // Amber is for our CALLS running late — ours and fixable. The ordinary
          // ~17-minute briefing pipeline is NOT a fault and must not light one,
          // or every kiosk in the building is amber every night.
          const dot = d.tone === "ok" ? "#46d68c" : d.tone === "warn" ? "#f0b341" : "#6b7280";
          const timing =
            shouldShowPrediction(d) && d.predictedStartMs !== null
              ? t("raceInfo.upcoming.racingAbout", {
                  time: etClock(roundPredictedMs(d.predictedStartMs)),
                })
              : slotMsOf(race) !== null
                ? t("raceInfo.upcoming.scheduledAt", { time: etClock(slotMsOf(race) as number) })
                : null;
          return (
            <div
              key={track.trackName}
              className="flex flex-1 items-center gap-[16px] rounded-[18px] border px-[24px] py-[16px]"
              style={{
                borderColor: `${track.colors.trackIdentity}55`,
                background: "rgba(0,0,0,0.25)",
              }}
            >
              <span
                className="h-[16px] w-[16px] shrink-0 rounded-full"
                style={{ background: dot, boxShadow: `0 0 14px ${dot}` }}
              />
              <span className="flex-1 text-[28px] font-semibold text-white">{track.trackName}</span>
              {timing && (
                <span
                  className="k-num text-[26px] font-bold"
                  style={{ color: track.colors.trackIdentity }}
                >
                  {timing}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** One heat — the booking picker's card language at kiosk-canvas scale. */
function HeatCard({ heat }: { heat: DisplayHeat }) {
  const t = useT();
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
  // greyed heats show the server-supplied statusLabel (data) as-is.
  const spotsLabel = greyed
    ? heat.statusLabel
    : t("raceInfo.upcoming.spotsLeft", { count: heat.freeSpots });

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
  const t = useT();
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
              {t("raceInfo.filter.all")}
            </button>
            {tracks.map((trk) => (
              <button
                key={trk}
                type="button"
                className={`k-chip k-tap flex-1 ${activeTrack === trk ? "sel" : ""}`}
                style={activeTrack === trk ? { borderColor: TRACK_ACCENT[trk] } : undefined}
                onClick={() => setTrackFilter((cur) => (cur === trk ? null : trk))}
              >
                <span style={{ color: TRACK_ACCENT[trk] }}>{trk}</span>
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
          {t("raceInfo.class.adult")}
        </button>
        <button
          type="button"
          className={`k-chip k-tap flex-1 ${classFilter === "junior" ? "sel" : ""}`}
          onClick={() => setClassFilter("junior")}
        >
          {t("raceInfo.class.junior")}
        </button>
      </div>

      {isLoading && heats.length === 0 ? (
        <div className="py-[80px] text-center text-[30px] text-white/50">
          {t("raceInfo.upcoming.loading")}
        </div>
      ) : isError ? (
        <div className="py-[80px] text-center text-[30px] text-white/50">
          {t("raceInfo.upcoming.error")}
        </div>
      ) : showMegaNoJunior ? (
        // Mega day + Junior filter: the board is empty by design — explain why.
        <div className="flex flex-col items-center gap-[16px] rounded-[24px] border border-[#e53935]/40 bg-[#e53935]/10 px-[32px] py-[56px] text-center">
          <IconAlertTriangle size={48} className="text-[#ff5a52]" aria-hidden="true" />
          <div className="text-[32px] font-bold text-[#ff5a52]">
            {t("raceInfo.upcoming.megaNoJunior.title")}
          </div>
          <div className="max-w-[520px] text-[22px] leading-snug text-white/50">
            {t("raceInfo.upcoming.megaNoJunior.body")}
          </div>
        </div>
      ) : visible.length === 0 ? (
        <div className="py-[80px] text-center text-[30px] text-white/50">
          {t("raceInfo.upcoming.empty", { cls: classFilter })}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-4 gap-[16px]">
            {visible.map((h) => (
              <HeatCard key={h.key} heat={h} />
            ))}
          </div>
          <div className="text-center text-[22px] text-white/40">
            {t("raceInfo.upcoming.ladderNote")}
          </div>
        </>
      )}
    </div>
  );
}
