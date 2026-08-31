"use client";

/**
 * Race Info hub — "The Tracks" sub-screen. Blue / Red / Mega layouts (live
 * layout diagrams from the /racing page assets), kart classes, and the
 * EcoVolt GT hardware — all from the shared racing-content constants.
 */
import { IconBolt } from "@tabler/icons-react";
import { TRACK_LAYOUTS, KART_CLASS_CARDS, KART_SPECS } from "~/lib/constants/racing-content";
import { useT } from "../../i18n";

export function TheTracks() {
  const t = useT();
  return (
    <div className="flex flex-col gap-[28px] pb-[48px]">
      {TRACK_LAYOUTS.map((track) => (
        <div
          key={track.key}
          className="overflow-hidden rounded-[28px] border border-white/10 bg-[#071027]"
          style={{ borderLeft: `8px solid ${track.color}` }}
        >
          <div className="flex flex-col gap-[10px] px-[36px] pt-[28px]">
            <div className="k-display text-[44px]" style={{ color: track.color }}>
              {track.name}{" "}
              <span className="k-num text-white/60">({track.lengthFt.toLocaleString()} ft)</span>
            </div>
            <div className="text-[26px] text-white/75">{track.blurb}</div>
            {track.warning && (
              <div className="rounded-[14px] border border-[#f0b341]/40 bg-[#f0b341]/10 px-[20px] py-[12px] text-[22px] font-semibold leading-snug text-[#f0b341]">
                {track.warning}
              </div>
            )}
          </div>
          <div className="flex justify-center px-[36px] py-[24px]">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={track.gif}
              alt={t("raceInfo.tracks.layoutAlt", { track: track.name })}
              className="max-h-[420px] max-w-full rounded-[18px]"
              draggable={false}
            />
          </div>
        </div>
      ))}

      <div className="grid grid-cols-2 gap-[24px]">
        {KART_CLASS_CARDS.map((kart) => (
          <div
            key={kart.title}
            className="flex flex-col gap-[12px] rounded-[28px] bg-[#071027] p-[28px]"
            style={{ border: `2px dashed ${kart.border}` }}
          >
            <div className="k-display text-[32px]" style={{ color: kart.color }}>
              {kart.title}
            </div>
            {kart.items.map((item) => (
              <div key={item.label} className="text-[22px] leading-snug">
                <span className="font-bold text-white/85">{item.label}: </span>
                <span className="text-white/60">{item.value}</span>
              </div>
            ))}
          </div>
        ))}
      </div>

      <div className="flex items-center gap-[24px] rounded-[28px] border border-white/10 bg-[#0d1a36] p-[28px]">
        <IconBolt size={56} className="shrink-0 text-[#00e2e5]" aria-hidden="true" />
        {/* TODO(i18n): composed entirely from KART_SPECS constants (model/motor/
            safety/structure) with inline <strong> + English connectives. The
            spec data stays English (racing-content constants, outside this pass),
            so this line stays English with it — mirrors the KioskConfirmation
            rich-text precedent. */}
        <div className="text-[24px] leading-snug text-white/75">
          <span className="font-bold text-white">{KART_SPECS.model}</span> — {KART_SPECS.motor}.{" "}
          {KART_SPECS.safety}, on a {KART_SPECS.structure}.
        </div>
      </div>
    </div>
  );
}
