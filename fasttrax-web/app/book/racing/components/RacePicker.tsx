"use client";

import { RACE_PRODUCTS, COLOR_MAP, TIER_LABELS, type RaceProduct, type RaceTier } from "../data";

interface RacePickerProps {
  selected: RaceProduct | null;
  onSelect: (race: RaceProduct) => void;
}

const TIERS: RaceTier[] = ["starter", "intermediate", "pro"];

export default function RacePicker({ selected, onSelect }: RacePickerProps) {
  return (
    <div className="space-y-8">
      <div className="text-center">
        <h2 className="text-2xl font-display text-white uppercase tracking-widest mb-2">
          Choose Your Race
        </h2>
        <p className="text-white/50 text-sm">
          All racers start at Starter. Each tier requires qualifying lap times from the tier below.
        </p>
      </div>

      {TIERS.map((tier) => {
        const tierProducts = RACE_PRODUCTS.filter((r) => r.tier === tier);
        const c = COLOR_MAP[tierProducts[0].color];

        return (
          <div key={tier}>
            {/* Tier header */}
            <div className="flex items-center gap-3 mb-3">
              <div className={`h-px flex-1 ${c.border} opacity-40`} style={{ borderTopWidth: 1, borderTopStyle: "solid" }} />
              <span className={`text-xs font-bold uppercase tracking-[0.2em] ${c.text}`}>
                {TIER_LABELS[tier]}
              </span>
              <div className={`h-px flex-1 ${c.border} opacity-40`} style={{ borderTopWidth: 1, borderTopStyle: "solid" }} />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {tierProducts.map((race) => {
                const isSelected = selected?.productId === race.productId;
                return (
                  <button
                    key={race.productId}
                    onClick={() => onSelect(race)}
                    className={`
                      text-left rounded-xl border p-4 transition-all duration-200 group
                      ${isSelected
                        ? `${c.border} ${c.bg} ring-2 ring-offset-2 ring-offset-[#010A20]`
                        : "border-white/10 bg-white/5 hover:border-white/30 hover:bg-white/10"
                      }
                    `}
                    style={isSelected ? { ringColor: "currentColor" } : {}}
                  >
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <span className="font-bold text-white text-sm leading-tight">
                        {race.displayName}
                      </span>
                      <div className="flex flex-col items-end gap-1 shrink-0">
                        <span className={`text-xs font-bold ${c.text}`}>
                          ${race.price.toFixed(2)}
                        </span>
                        {race.pack && (
                          <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${c.badge}`}>
                            {race.pack} races
                          </span>
                        )}
                        <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${
                          race.category === "junior" ? "bg-yellow-500/20 text-yellow-300" : "bg-white/10 text-white/60"
                        }`}>
                          {race.category === "junior" ? "Junior" : "Adult"}
                        </span>
                      </div>
                    </div>

                    <p className="text-white/50 text-xs leading-relaxed mb-3">
                      {race.description}
                    </p>

                    <div className="space-y-1">
                      <div className="flex gap-2 text-[11px]">
                        <span className="text-white/30 w-12 shrink-0">Age</span>
                        <span className="text-white/70">{race.age}</span>
                      </div>
                      <div className="flex gap-2 text-[11px]">
                        <span className="text-white/30 w-12 shrink-0">Height</span>
                        <span className="text-white/70">{race.height}</span>
                      </div>
                      <div className="flex gap-2 text-[11px]">
                        <span className="text-white/30 w-12 shrink-0">Req.</span>
                        <span className={race.qualification ? "text-amber-400" : "text-emerald-400"}>
                          {race.qualification
                            ? `Qualified in ${race.qualifiesFrom}`
                            : "None — open to all"}
                        </span>
                      </div>
                    </div>

                    {isSelected && (
                      <div className={`mt-3 pt-3 border-t ${c.border} border-opacity-30 flex items-center gap-2`}>
                        <div className={`w-2 h-2 rounded-full ${c.bg} border ${c.border}`} />
                        <span className={`text-xs font-semibold ${c.text}`}>Selected</span>
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
