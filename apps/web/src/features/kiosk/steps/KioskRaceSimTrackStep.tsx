"use client";

/**
 * Kiosk Race Sims — track selection. PLACEHOLDER PHASE 2026-08: three sim
 * rigs run a rotating track lineup (weekly/biweekly — rotation config is
 * future work), so the cards are the placeholder Track A/B/C labels from
 * features/race-sims/products.ts with no track art yet — big-letter glass
 * cards until the real lineup is named and photographed.
 *
 * Writes ONLY item.trackKey.
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

/** Per-card accents — the racing family palette, one per rig. */
const TRACK_ACCENTS: Record<RaceSimTrackKey, string> = {
  a: "#ff6b6b",
  b: "#00e2e5",
  c: "#e8b14c",
};

const KioskRaceSimTrackStepComponent: StepDef<RaceSimItem>["Component"] = ({ item, onChange }) => {
  const t = useT();
  return (
    <div className="space-y-[24px]">
      <p className="text-[26px] text-white/55">{t("racesim.track.intro")}</p>
      <div className="grid grid-cols-3 gap-[24px]">
        {RACE_SIM_TRACKS.map((track) => {
          const selected = item.trackKey === track.key;
          const accent = TRACK_ACCENTS[track.key];
          return (
            <button
              key={track.key}
              type="button"
              onClick={() => onChange({ trackKey: track.key })}
              aria-label={t(TRACK_NAME_KEYS[track.key])}
              className="k-glass k-tap relative flex h-[360px] flex-col items-center justify-center gap-[16px] overflow-hidden rounded-[28px] border-2 text-center"
              style={{
                borderColor: selected ? accent : "rgba(255,255,255,0.12)",
                boxShadow: selected ? `0 0 44px ${accent}40` : "none",
              }}
            >
              {selected && (
                <div
                  className="absolute right-[20px] top-[20px] grid h-[48px] w-[48px] place-items-center rounded-full text-[28px] font-bold text-[#04252b]"
                  style={{ background: accent }}
                >
                  ✓
                </div>
              )}
              <div
                className="k-display text-[120px] leading-none"
                style={{ color: selected ? accent : "rgba(255,255,255,0.85)" }}
              >
                {track.key.toUpperCase()}
              </div>
              <div className="k-display text-[34px]">{t(TRACK_NAME_KEYS[track.key])}</div>
              <div className="k-eyebrow text-white/45">{t("racesim.track.rotates")}</div>
              <div
                className="absolute inset-x-0 bottom-0 h-[8px]"
                style={{ background: selected ? accent : "#333" }}
              />
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
