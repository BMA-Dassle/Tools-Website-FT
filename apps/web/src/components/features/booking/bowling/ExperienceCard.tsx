"use client";

/**
 * One bowling package card on the v3 Experience step — media header, price,
 * inline duration tiles (1.5h / 2h with per-duration prices, disabled when a
 * duration can't fit that day), and an accurate "Next lane at …" hint.
 * Mirrors the July race product redesign's card language (tier-sectioned
 * list, selection via click handlers — never effects).
 *
 * Type hierarchy per the owner-approved "Direction B" mockups (2026-08-02):
 * the package NAME and the guest's SELECTIONS carry the visual weight — the
 * name is the boldest text on the card, durations are two-line display-face
 * tiles, and the active tile / selected card get explicit ✓ marks. Price and
 * availability step back to quiet tabular metadata (same palette as before).
 * The ENTIRE card is a select target, not just the header (owner 2026-08-02:
 * "it only let you click on the main info").
 */

import type {
  BowlingExperienceWithDetails,
  BowlingExperienceDurationOption,
} from "@/lib/bowling-db";
import { useT } from "~/features/kiosk/i18n";

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
  /** The time portion of `hint` (e.g. "6:30 PM"), rendered emphasized —
   *  two-tone green, the time bigger/bolder (owner 2026-08-02). */
  hintTime?: string | null;
  hintLoading: boolean;
  /**
   * Optional video header. Omit for the plain header — owner 2026-07-19:
   * cards don't all need video; the SECTION carries one video banner instead.
   */
  videoUrl?: string;
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
    hintTime,
    hintLoading,
    videoUrl,
    onSelect,
  } = props;
  // Locale-aware on the kiosk; falls back to English on the web (no provider).
  const t = useT();
  const kiosk = variant === "kiosk";
  const soldOut = !hintLoading && hint != null && hint.startsWith("Sold out");
  const defaultDuration = durations.find((d) => !d.unavailable)?.opt ?? null;
  // A tap on the card body/header keeps an already-picked duration — with the
  // whole card tappable, resetting to the default here would silently swap a
  // guest's 2h pick back to 1.5h (and drop a live hold) on any stray tap.
  const selectTarget = durations.find((d) => d.active)?.opt ?? defaultDuration;

  return (
    /* The whole card selects; the header <button> stays as the keyboard/AT
       target (it stops propagation so a single tap can't double-fire onSelect
       and double-release a live hold). Duration tiles stop propagation too. */
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- pointer-only hit-area enlargement; keyboard/AT select via the header button
    <div
      className={`relative overflow-hidden text-left transition-all ${
        kiosk ? "k-glass" : "rounded-2xl border bg-white/[0.03]"
      } ${soldOut ? "opacity-50" : "cursor-pointer"}`}
      style={
        kiosk
          ? {
              borderLeft: `8px solid ${selected ? accent : "rgba(255,255,255,0.15)"}`,
              boxShadow: selected ? `0 0 44px ${accent}38` : undefined,
            }
          : {
              borderColor: selected ? accent : "rgba(255,255,255,0.1)",
              boxShadow: selected ? `0 0 20px ${accent}40` : undefined,
            }
      }
      onClick={() => {
        if (!soldOut) onSelect(selectTarget);
      }}
    >
      {selected && (
        <span
          className={`pointer-events-none absolute z-[2] rounded-full font-display font-extrabold ${
            kiosk
              ? "right-[20px] top-[20px] px-[22px] py-[8px] text-[22px]"
              : "right-3 top-3 px-2.5 py-1 text-[10px]"
          }`}
          style={{ backgroundColor: accent, color: "#0a1628", letterSpacing: "0.14em" }}
        >
          ✓ {t("offer.selectedBadge")}
        </span>
      )}

      {/* Header — the whole header is the select tap target. Video only when
          the caller asks for it; the plain variant keeps the card light (the
          section banner carries the motion). */}
      <button
        type="button"
        disabled={soldOut}
        onClick={(e) => {
          e.stopPropagation();
          onSelect(selectTarget);
        }}
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
            className={`font-display font-extrabold uppercase ${kiosk ? "text-[44px]" : "text-2xl"}`}
            style={{ color: accent, letterSpacing: kiosk ? "0.01em" : "0.04em" }}
          >
            {exp.label}
          </h3>
          {exp.description && (
            <p className={`mt-0.5 text-white/55 ${kiosk ? "text-[23px]" : "text-xs"}`}>
              {exp.description}
            </p>
          )}
        </div>
      </button>

      <div className={kiosk ? "p-[24px]" : "p-4"}>
        <div className="flex items-center justify-between">
          <span
            className={`font-semibold tabular-nums text-white/90 ${
              kiosk ? "text-[27px]" : "text-[15px]"
            }`}
          >
            {priceLabel}
            {perLabel && (
              <span
                className={`font-semibold uppercase text-white/40 ${
                  kiosk ? "ml-[6px] text-[18px]" : "ml-1 text-[10px]"
                }`}
                style={{ letterSpacing: "0.08em" }}
              >
                {perLabel}
              </span>
            )}
          </span>
          {/* Accurate availability hint — informational, never blocks.
              All green, two-tone: the label sits back, the TIME carries the
              size and weight (owner 2026-08-02). */}
          {hintLoading ? (
            <span
              className={`inline-block animate-pulse rounded bg-white/10 ${kiosk ? "h-[24px] w-[180px]" : "h-3.5 w-24"}`}
              aria-hidden
            />
          ) : hint ? (
            <span
              className={`inline-flex items-baseline tabular-nums ${
                kiosk ? "gap-[12px] text-[24px] font-semibold" : "gap-1.5 text-[12px] font-medium"
              }`}
              style={{
                color: soldOut ? "rgba(255,255,255,0.35)" : "#22c55e",
              }}
            >
              {!soldOut && (
                <span
                  className={`shrink-0 self-center rounded-full ${kiosk ? "h-[16px] w-[16px]" : "h-[7px] w-[7px]"}`}
                  style={{ backgroundColor: "#22c55e", boxShadow: "0 0 8px #22c55e" }}
                  aria-hidden
                />
              )}
              {!soldOut && hintTime && hint.endsWith(hintTime) ? (
                <span>
                  <span className="opacity-75">{hint.slice(0, hint.length - hintTime.length)}</span>
                  <span className={`font-extrabold ${kiosk ? "text-[30px]" : "text-[14px]"}`}>
                    {hintTime}
                  </span>
                </span>
              ) : (
                hint
              )}
            </span>
          ) : null}
        </div>

        {durations.length > 0 && (
          <div className={kiosk ? "mt-[18px]" : "mt-3"}>
            <div
              className={`font-bold uppercase ${kiosk ? "mb-[14px] text-[20px]" : "mb-2 text-[10px]"}`}
              style={{ color: `${accent}${kiosk ? "B3" : "A6"}`, letterSpacing: "0.28em" }}
            >
              {t("offer.howLong")}
            </div>
            <div className={`flex flex-wrap ${kiosk ? "gap-[14px]" : "gap-2"}`}>
              {durations.map(({ opt, priceLabel: optPrice, active, unavailable }) => (
                <button
                  key={opt.id}
                  type="button"
                  disabled={unavailable || soldOut}
                  title={unavailable ? "No lanes free this long today" : undefined}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelect(opt);
                  }}
                  className={`inline-grid text-center transition-all disabled:opacity-35 disabled:line-through ${
                    kiosk
                      ? "k-tap min-w-[180px] gap-[5px] rounded-[16px] border-2 px-[30px] py-[18px]"
                      : "min-w-[92px] gap-0.5 rounded-[10px] border-[1.5px] px-4 py-2.5"
                  }`}
                  style={{
                    borderColor: active ? accent : `${accent}61`,
                    backgroundColor: active ? accent : "transparent",
                    color: active ? "#0a1628" : accent,
                    boxShadow: active ? `0 0 16px ${accent}73` : undefined,
                  }}
                >
                  <span
                    className={`font-display font-extrabold uppercase leading-none ${
                      kiosk ? "text-[32px]" : "text-base"
                    }`}
                  >
                    {active ? "✓ " : ""}
                    {opt.label}
                  </span>
                  <span
                    className={`tabular-nums ${
                      active ? "font-semibold opacity-75" : "font-medium opacity-60"
                    } ${kiosk ? "text-[20px]" : "text-[11px]"}`}
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
