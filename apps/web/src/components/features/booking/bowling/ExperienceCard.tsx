"use client";

/**
 * One bowling package card on the v3 Experience step — media header, price,
 * inline duration chips (1.5h / 2h with per-duration prices, disabled when a
 * duration can't fit that day), and an accurate "Next lane at …" hint.
 * Mirrors the July race product redesign's card language (tier-sectioned
 * list, selection via click handlers — never effects).
 */

import type {
  BowlingExperienceWithDetails,
  BowlingExperienceDurationOption,
} from "@/lib/bowling-db";

export interface DurationChip {
  opt: BowlingExperienceDurationOption;
  priceLabel: string;
  active: boolean;
  /** True when the accurate day scan proves this duration has no slot today. */
  unavailable: boolean;
}

export interface ExperienceCardProps {
  variant: "web" | "kiosk";
  exp: BowlingExperienceWithDetails;
  accent: string;
  selected: boolean;
  /** e.g. "$45.00" or "Free" (KBF). */
  priceLabel: string;
  /** "/lane" | "/person" | "" (KBF free). */
  perLabel: string;
  durations: DurationChip[];
  /** "Next lane 6:30 PM" | "Sold out today" | null while loading. */
  hint: string | null;
  hintLoading: boolean;
  /**
   * Optional video header. Omit for the plain header — owner 2026-07-19:
   * cards don't all need video; the SECTION carries one video banner instead.
   */
  videoUrl?: string;
  /** PinBoyz (Old Time Lanes) vintage treatment: serif title instead of the
   *  site display face (owner 2026-07-26: "needs to look more classic"). */
  vintage?: boolean;
  onSelect: (durationOpt: BowlingExperienceDurationOption | null) => void;
}

export function ExperienceCard(props: ExperienceCardProps) {
  const {
    variant,
    exp,
    accent,
    selected,
    priceLabel,
    perLabel,
    durations,
    hint,
    hintLoading,
    videoUrl,
    vintage,
    onSelect,
  } = props;
  const kiosk = variant === "kiosk";
  const soldOut = !hintLoading && hint != null && hint.startsWith("Sold out");
  const defaultDuration = durations.find((d) => !d.unavailable)?.opt ?? null;

  return (
    <div
      className={`overflow-hidden text-left transition-all ${
        kiosk ? "k-glass" : "rounded-2xl border bg-white/[0.03]"
      } ${soldOut ? "opacity-50" : ""}`}
      style={
        kiosk
          ? { borderLeft: `8px solid ${selected ? accent : "rgba(255,255,255,0.15)"}` }
          : {
              borderColor: selected ? accent : "rgba(255,255,255,0.1)",
              boxShadow: selected ? `0 0 20px ${accent}40` : undefined,
            }
      }
    >
      {/* Header — the whole header is the select tap target. Video only when
          the caller asks for it; the plain variant keeps the card light (the
          section banner carries the motion). */}
      <button
        type="button"
        disabled={soldOut}
        onClick={() => onSelect(defaultDuration)}
        aria-label={`Select ${exp.label}`}
        className={`relative block w-full overflow-hidden text-left ${
          videoUrl ? (kiosk ? "h-[180px]" : "h-32") : ""
        }`}
      >
        {videoUrl && (
          <>
            <video
              src={videoUrl}
              autoPlay
              loop
              muted
              playsInline
              className="h-full w-full object-cover opacity-50"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-black/80 to-transparent" />
          </>
        )}
        <div
          className={
            videoUrl
              ? `absolute inset-x-0 bottom-0 ${kiosk ? "p-[24px]" : "p-4"}`
              : kiosk
                ? "px-[24px] pt-[24px]"
                : "px-4 pt-4"
          }
        >
          <h3
            className={
              vintage
                ? `font-bold uppercase ${kiosk ? "text-[34px]" : "text-lg"}`
                : `font-display uppercase tracking-widest ${kiosk ? "text-[34px]" : "text-lg"}`
            }
            style={
              vintage
                ? {
                    color: accent,
                    fontFamily: 'Georgia, "Times New Roman", serif',
                    letterSpacing: "0.1em",
                  }
                : { color: accent }
            }
          >
            {exp.label}
          </h3>
          {exp.description && (
            <p className={`mt-0.5 text-white/50 ${kiosk ? "text-[22px]" : "text-xs"}`}>
              {exp.description}
            </p>
          )}
        </div>
      </button>

      <div className={kiosk ? "p-[24px]" : "p-4"}>
        <div className="flex items-center justify-between">
          <button
            type="button"
            disabled={soldOut}
            onClick={() => onSelect(defaultDuration)}
            className={`font-bold text-white ${kiosk ? "text-[30px]" : "text-lg"}`}
          >
            {priceLabel}
            {perLabel && (
              <span className={`font-normal text-white/40 ${kiosk ? "text-[22px]" : "text-xs"}`}>
                {perLabel}
              </span>
            )}
          </button>
          {/* Accurate availability hint — informational, never blocks */}
          {hintLoading ? (
            <span
              className={`inline-block animate-pulse rounded bg-white/10 ${kiosk ? "h-[24px] w-[180px]" : "h-3.5 w-24"}`}
              aria-hidden
            />
          ) : hint ? (
            <span
              className={`font-semibold ${kiosk ? "text-[22px]" : "text-[11px]"}`}
              style={{ color: soldOut ? "rgba(255,255,255,0.35)" : "#22c55e" }}
            >
              {hint}
            </span>
          ) : null}
        </div>

        {durations.length > 0 && (
          <div className={kiosk ? "mt-[18px]" : "mt-3"}>
            <div
              className={`uppercase tracking-wider text-white/30 ${
                kiosk ? "mb-[10px] text-[20px]" : "mb-1.5 text-[10px]"
              }`}
            >
              How long?
            </div>
            <div className={`flex flex-wrap ${kiosk ? "gap-[14px]" : "gap-2"}`}>
              {durations.map(({ opt, priceLabel: optPrice, active, unavailable }) => (
                <button
                  key={opt.id}
                  type="button"
                  disabled={unavailable || soldOut}
                  title={unavailable ? "No lanes free this long today" : undefined}
                  onClick={() => onSelect(opt)}
                  className={`rounded-lg font-medium transition-all disabled:opacity-35 disabled:line-through ${
                    kiosk ? "k-tap px-[22px] py-[16px] text-[26px]" : "px-3 py-2 text-sm"
                  }`}
                  style={{
                    backgroundColor: active ? accent : `${accent}15`,
                    color: active ? "#0a1628" : accent,
                    fontWeight: active ? 800 : 500,
                    boxShadow: active ? `0 0 12px ${accent}60` : undefined,
                  }}
                >
                  {opt.label}
                  <span
                    className={`opacity-60 ${kiosk ? "ml-[10px] text-[22px]" : "ml-1.5 text-xs"}`}
                  >
                    {optPrice}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
