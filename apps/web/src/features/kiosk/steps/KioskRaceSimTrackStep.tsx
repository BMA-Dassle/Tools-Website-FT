"use client";

/**
 * Kiosk Race Sims — track selection: the ONE step added to the racing flow
 * (owner 2026-08-26: "follow racing as close as possible, with the track
 * selection step added"). Mirrors racing's track chooser — the
 * TrackInfoBanner cards in track-visuals.tsx (tinted per-track card, display
 * title, mono stat on the right, ring when active, siblings dimmed) — at
 * kiosk canvas px, using racing's own track palette (Red / Blue / Mega
 * purple) until the rotating lineup is named.
 *
 * All three keys book the same "Race Sim" resource sessions; the pick
 * decides WHICH $0 key holds the seat (raceSimBookingTarget). Writes ONLY
 * item.trackKey.
 */
import type { StepDef, RaceSimItem } from "~/features/booking";
import { RACE_SIM_TRACKS, type RaceSimTrackKey } from "~/features/race-sims/products";
import { useT } from "../i18n";
import type { MessageKey } from "../i18n";

/** Track key → display-name key ("Track A" / "Pista A"). */
const TRACK_NAME_KEYS: Record<RaceSimTrackKey, MessageKey> = {
  a: "racesim.track.a",
  b: "racesim.track.b",
  c: "racesim.track.c",
};

/** Racing's track palette (TRACK_CARD / TRACK_TINT): Red, Blue, Mega purple. */
const TRACK_TINT: Record<RaceSimTrackKey, { tint: string; title: string }> = {
  a: { tint: "#e53935", title: "#fca5a5" },
  b: { tint: "#4fa9ff", title: "#93c5fd" },
  c: { tint: "#8652ff", title: "#d8b4fe" },
};

const KioskRaceSimTrackStepComponent: StepDef<RaceSimItem>["Component"] = ({ item, onChange }) => {
  const t = useT();
  return (
    <div className="space-y-[24px]">
      <p className="text-[24px] text-white/55">{t("racesim.track.intro")}</p>
      <div className="grid grid-cols-3 gap-[16px]">
        {RACE_SIM_TRACKS.map((track) => {
          const selected = item.trackKey === track.key;
          const dimmed = !!item.trackKey && !selected;
          const { tint, title } = TRACK_TINT[track.key];
          return (
            <button
              key={track.key}
              type="button"
              aria-pressed={selected}
              onClick={() => onChange({ trackKey: track.key })}
              className={`k-tap rounded-[16px] border-2 px-[28px] py-[24px] text-left ${dimmed ? "opacity-40" : ""}`}
              style={{
                borderColor: selected ? tint : `${tint}66`,
                background: `${tint}14`,
                boxShadow: selected ? `0 0 0 4px ${tint}99` : "none",
              }}
            >
              {/* TrackInfoBanner's title row keeps a mono stat on the right
                  (track length); sims have none yet, so the row is title-only
                  until the lineup is named. */}
              <div className="mb-[6px] flex items-baseline justify-between gap-[12px]">
                <h4 className="k-display text-[30px] tracking-wider" style={{ color: title }}>
                  {t(TRACK_NAME_KEYS[track.key])}
                </h4>
              </div>
              <p className="text-[21px] leading-snug text-white/65">{t("racesim.track.tagline")}</p>
            </button>
          );
        })}
      </div>
    </div>
  );
};

// TODO(i18n): title/reason localize via KioskFlow's lookup maps (house pattern).
export const KioskRaceSimTrackStep: StepDef<RaceSimItem> = {
  id: "racesim-track",
  title: "Track",
  Component: KioskRaceSimTrackStepComponent,
  isVisible: () => true,
  canAdvance: (item) => (item.trackKey ? true : { reason: "Pick a track." }),
};
