"use client";

interface PartySizePickerProps {
  adults: number;
  juniors: number;
  onAdultsChange: (n: number) => void;
  onJuniorsChange: (n: number) => void;
}

function Counter({ label, description, value, onChange, min = 0, max = 10 }: {
  label: string;
  description: string;
  value: number;
  onChange: (n: number) => void;
  min?: number;
  max?: number;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-xl border border-white/10 bg-white/5 p-4">
      <div className="flex-1 min-w-0">
        <p className="text-white font-bold text-sm">{label}</p>
        <p className="text-white/40 text-xs mt-0.5">{description}</p>
      </div>
      <div className="flex items-center gap-3 shrink-0">
        <button
          onClick={() => onChange(Math.max(min, value - 1))}
          disabled={value <= min}
          className="w-9 h-9 rounded-lg border border-white/20 text-white/60 hover:bg-white/10 hover:text-white disabled:opacity-25 disabled:cursor-not-allowed transition-colors text-lg font-bold flex items-center justify-center"
        >
          −
        </button>
        <span className="text-white font-bold text-xl w-6 text-center tabular-nums">{value}</span>
        <button
          onClick={() => onChange(Math.min(max, value + 1))}
          disabled={value >= max}
          className="w-9 h-9 rounded-lg border border-white/20 text-white/60 hover:bg-white/10 hover:text-white disabled:opacity-25 disabled:cursor-not-allowed transition-colors text-lg font-bold flex items-center justify-center"
        >
          +
        </button>
      </div>
    </div>
  );
}

export default function PartySizePicker({ adults, juniors, onAdultsChange, onJuniorsChange }: PartySizePickerProps) {
  const total = adults + juniors;

  return (
    <div className="space-y-6">
      <div className="text-center space-y-2">
        <h2 className="text-2xl font-display uppercase tracking-widest text-white">
          How many racers?
        </h2>
        <p className="text-white/40 text-sm max-w-md mx-auto">
          Tell us about your party so we can find the right races.
        </p>
      </div>

      <div className="max-w-md mx-auto space-y-3">
        <Counter
          label="Adults"
          description={'13+ years old and at least 59" (4\'11") tall'}
          value={adults}
          onChange={onAdultsChange}
        />
        <Counter
          label="Juniors"
          description='7–13 years old and at least 49" tall'
          value={juniors}
          onChange={onJuniorsChange}
        />
      </div>

      {total === 0 && (
        <p className="text-center text-amber-400/70 text-xs">Add at least one racer to continue.</p>
      )}

      {total > 0 && (
        <div className="max-w-md mx-auto rounded-xl border border-white/8 bg-white/3 p-3 text-xs text-white/40 text-center">
          {total} racer{total !== 1 ? "s" : ""} total
          {adults > 0 && juniors > 0 && ` (${adults} adult${adults !== 1 ? "s" : ""}, ${juniors} junior${juniors !== 1 ? "s" : ""})`}
        </div>
      )}
    </div>
  );
}
