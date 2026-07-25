"use client";

/**
 * Race Info hub — "Race Types" sub-screen. The Starter → Intermediate → Pro
 * qualification ladder, rendered from the shared racing-content constants
 * (the same copy as /racing, incl. the Mega qualifying times added
 * 2026-07-21: 1:28 unlocks Intermediate, 1:08.5 unlocks Pro).
 */
import { IconLicense } from "@tabler/icons-react";
import { RACE_TYPE_CARDS } from "~/lib/constants/racing-content";
import { useT } from "../../i18n";

export function RaceTypes() {
  const t = useT();
  return (
    <div className="flex flex-col gap-[28px] pb-[48px]">
      <div className="text-[28px] leading-snug text-white/65">{t("raceInfo.types.intro")}</div>

      <div className="grid grid-cols-2 gap-[24px]">
        {RACE_TYPE_CARDS.map((rt) => (
          <div
            key={rt.title}
            className="flex flex-col gap-[14px] rounded-[28px] bg-[#071027] p-[32px]"
            style={{ border: `2px dashed ${rt.border}` }}
          >
            <div className="k-display text-[40px]" style={{ color: rt.color }}>
              {rt.title}
            </div>
            <div className="flex items-center gap-[14px] text-[24px] text-white/70">
              <span className="rounded-full bg-white/10 px-[16px] py-[4px] font-semibold">
                {rt.age}
              </span>
            </div>
            {/* rt.title / rt.age / rt.qual / rt.desc / rt.note come from the
                shared racing-content constants (data) and stay as returned. */}
            <div className="text-[24px] leading-snug text-white/85">
              <span className="font-bold text-white">{t("raceInfo.types.qualificationLabel")}</span>
              {rt.qual}
            </div>
            <div className="text-[24px] leading-snug text-white/60">{rt.desc}</div>
            {rt.note && (
              <div className="mt-auto rounded-[14px] border border-[#f0b341]/40 bg-[#f0b341]/10 px-[18px] py-[10px] text-[21px] font-semibold text-[#f0b341]">
                {rt.note}
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="flex items-center gap-[24px] rounded-[28px] border border-[#00e2e5]/30 bg-[#00e2e5]/5 p-[28px]">
        <IconLicense size={56} className="shrink-0 text-[#00e2e5]" aria-hidden="true" />
        {/* TODO(i18n): this note carries inline <strong> emphasis + an embedded
            price (rich text). The plain-string formatMessage engine can't render
            ICU tags, so it stays English until the engine supports rich-text tags
            (mirrors the KioskConfirmation precedent). Do not guess a split. */}
        <div className="text-[25px] leading-snug text-white/75">
          First visit? A <span className="font-bold text-white">$4.99 Racing License</span> (valid
          one year) covers helmets, head socks, FastTrax app lap tracking, and waived booking fees.
        </div>
      </div>
    </div>
  );
}
