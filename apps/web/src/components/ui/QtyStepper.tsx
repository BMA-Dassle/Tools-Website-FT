"use client";

/**
 * Quantity stepper — a labelled row with − / value / + controls.
 *
 * Extracted from AttractionProductStep, which had it as a private local. The
 * labels are PROPS rather than i18n lookups on purpose: this is a `ui/`
 * primitive, and a primitive reaching into the kiosk locale bundle would both
 * invert the layering and hardcode "how many people?" into every future caller.
 * The booking step passes its translated strings; other callers pass their own.
 */
export interface QtyStepperProps {
  qty: number;
  /** Inclusive floor. Defaults to 1 — a stepper that can reach 0 wants a remove
   *  button instead. */
  min?: number;
  max: number;
  /** Row label, e.g. "How many people?" or "How many packs?". */
  label: string;
  /** Accessible names for the two buttons — they carry no visible text. */
  decrementLabel: string;
  incrementLabel: string;
  /** Accent used for nothing today; kept so callers can theme without a fork. */
  accentColor?: string;
  disabled?: boolean;
  onChange: (qty: number) => void;
}

function QtyStepper({
  qty,
  min = 1,
  max,
  label,
  decrementLabel,
  incrementLabel,
  disabled = false,
  onChange,
}: QtyStepperProps) {
  const atMin = disabled || qty <= min;
  const atMax = disabled || qty >= max;

  return (
    <div className="flex items-center justify-between rounded-lg bg-white/[0.03] px-4 py-3">
      <span className="text-sm text-white/60">{label}</span>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => onChange(Math.max(min, qty - 1))}
          disabled={atMin}
          aria-label={decrementLabel}
          className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/20 text-lg text-white/50 transition-colors hover:border-white/40 hover:text-white disabled:cursor-not-allowed disabled:opacity-30"
        >
          -
        </button>
        <span className="w-6 text-center text-sm font-bold text-white">{qty}</span>
        <button
          type="button"
          onClick={() => onChange(Math.min(max, qty + 1))}
          disabled={atMax}
          aria-label={incrementLabel}
          className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/20 text-lg text-white/50 transition-colors hover:border-white/40 hover:text-white disabled:cursor-not-allowed disabled:opacity-30"
        >
          +
        </button>
      </div>
    </div>
  );
}

export default QtyStepper;
