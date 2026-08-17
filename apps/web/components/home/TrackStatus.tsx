"use client";

/**
 * LIVE TRACK STATUS — home, /racing, every e-ticket and group e-ticket.
 *
 * Shows a TIME, not a delay (2026-08-17). It used to show the BMA service's
 * "On Time / +N Min", which was green 99 nights in 100 because that service only
 * calls a heat delayed once it is 30 minutes past its slot. Green by
 * construction is the same as no information.
 *
 * What a guest actually wants is when they will race, and we can now answer it
 * from our own data: the printed slot plus the track's live flag offset lands
 * within 5 minutes 86% of the time for the next heat. See
 * features/racing/on-time.ts for the measurements and on-time-display.ts for why
 * the ordinary ~17-minute pipeline is deliberately NOT painted as a delay.
 *
 * When we cannot predict — no offset yet, the day's early heats that predate the
 * slot column, an hour-out horizon the back-test does not support — this falls
 * back to the printed heat time. Honest, and never a made-up minute.
 */

import { useTrackStatus, type CurrentRace } from "@/hooks/useTrackStatus";
import TrackTimingChip, { formatEtTime, slotMsOf } from "./TrackTimingChip";

function CheckingInTag({ race }: { race: CurrentRace }) {
  const ms = slotMsOf(race);
  const time = ms === null ? "" : formatEtTime(ms);
  return (
    <span className="text-amber-400 text-[11px] font-bold animate-pulse">
      Now Checking In: {race.raceType} Heat #{race.heatNumber}
      {time ? ` · ${time}` : ""}
    </span>
  );
}

export default function TrackStatus() {
  const result = useTrackStatus();

  if (!result) return null;
  const { trackStatus: data, currentRaces, onTime } = result;

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
                    <span className="font-body font-semibold text-white text-sm">Mega Track</span>
                    <TrackTimingChip
                      onTime={onTime}
                      track="mega"
                      race={currentRaces.mega}
                      textClassName="font-body text-xs font-bold text-white/80"
                      pulse
                    />
                  </div>
                  {currentRaces.mega && <CheckingInTag race={currentRaces.mega} />}
                </div>
              </div>
            ) : (
              data.tracks?.map((t) => {
                const key = t.trackName.toLowerCase().replace(/\s+track/i, "") as
                  | "blue"
                  | "red"
                  | "mega";
                const race = currentRaces[key] || null;
                return (
                  <div
                    key={t.trackName}
                    className="flex items-center gap-3 bg-[#071027] border px-4 py-2 rounded-lg"
                    style={{ borderColor: `${t.colors.trackIdentity}40` }}
                  >
                    <div className="flex flex-col">
                      <div className="flex items-center gap-3">
                        <span className="font-body font-semibold text-white text-sm">
                          {t.trackName}
                        </span>
                        <TrackTimingChip
                          onTime={onTime}
                          track={key}
                          race={race}
                          textClassName="font-body text-xs font-bold text-white/80"
                          pulse
                        />
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
