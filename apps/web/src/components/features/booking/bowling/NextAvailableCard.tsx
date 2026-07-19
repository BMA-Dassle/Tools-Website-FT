"use client";

/**
 * "Next Available" hero card — the kiosk pattern the owner asked the bowling
 * flow to be built around (KioskSlotStep's hero, extracted + generalized
 * 2026-07-19). One tap commits: the Time step's tap handler creates the QAMF
 * hold immediately.
 *
 * variant "kiosk" renders at kiosk canvas px with the k-glass/k-tap classes
 * (styles in app/kiosk/kiosk.css — inspected, not guessed); "web" renders the
 * same anatomy at web scale with the booking wizard's glass styling.
 */

export interface NextAvailableCardProps {
  variant: "web" | "kiosk";
  /** e.g. "Next available · today" or "Next available · Sat, Jul 26". */
  eyebrow: string;
  /** Big time label, e.g. "6:30 PM". */
  timeLabel: string;
  /** Status line under the time. */
  subline: string;
  /** Accent color (coral regular / gold VIP / cyan attractions). */
  accent: string;
  selected: boolean;
  busy: boolean;
  disabled?: boolean;
  onTap: () => void;
}

export function NextAvailableCard(props: NextAvailableCardProps) {
  const { variant, eyebrow, timeLabel, subline, accent, selected, busy, disabled, onTap } = props;

  if (variant === "kiosk") {
    return (
      <button
        type="button"
        onClick={onTap}
        disabled={disabled || busy}
        className="k-glass k-tap relative w-full overflow-hidden p-[40px] text-left"
        style={{ borderLeft: `8px solid ${selected ? accent : "rgba(255,255,255,0.15)"}` }}
      >
        <div className="k-eyebrow" style={{ color: accent }}>
          {eyebrow}
        </div>
        <div className="k-display mt-[10px] text-[150px] leading-none tabular-nums">
          {timeLabel}
        </div>
        <div className="mt-[12px] text-[28px] text-white/60">{subline}</div>
        {busy && (
          <div
            className="absolute right-[40px] top-1/2 h-[40px] w-[40px] -translate-y-1/2 animate-spin rounded-full border-4 border-white/20"
            style={{ borderTopColor: accent }}
            aria-hidden
          />
        )}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={onTap}
      disabled={disabled || busy}
      className="relative w-full overflow-hidden rounded-2xl border bg-white/[0.03] p-6 text-left transition-all hover:bg-white/[0.05] disabled:opacity-60"
      style={{
        borderColor: selected ? accent : "rgba(255,255,255,0.1)",
        boxShadow: selected ? `0 0 20px ${accent}40` : undefined,
      }}
    >
      <div className="text-[11px] uppercase tracking-[3px]" style={{ color: accent }}>
        {eyebrow}
      </div>
      <div className="mt-2 font-display text-5xl uppercase tracking-wider text-white tabular-nums sm:text-6xl">
        {timeLabel}
      </div>
      <div className="mt-2 text-sm text-white/55">{subline}</div>
      {busy && (
        <div
          className="absolute right-6 top-1/2 h-6 w-6 -translate-y-1/2 animate-spin rounded-full border-2 border-white/20"
          style={{ borderTopColor: accent }}
          aria-hidden
        />
      )}
    </button>
  );
}
