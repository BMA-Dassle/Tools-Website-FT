"use client";

import type { RacerType } from "../data";

interface ExperiencePickerProps {
  selected: RacerType | null;
  onSelect: (type: RacerType) => void;
}

export default function ExperiencePicker({ selected, onSelect }: ExperiencePickerProps) {
  return (
    <div className="space-y-6">
      <div className="text-center space-y-2">
        <h2 className="text-2xl font-display uppercase tracking-widest text-white">
          Have you raced at FastTrax before?
        </h2>
        <p className="text-white/40 text-sm max-w-md mx-auto">
          This helps us find the right race for your group.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-xl mx-auto">
        {/* New racer */}
        <button
          onClick={() => onSelect("new")}
          className={`text-left rounded-xl border p-5 transition-all duration-200 ${
            selected === "new"
              ? "border-[#00E2E5] bg-[#00E2E5]/10 ring-2 ring-[#00E2E5]/40 ring-offset-2 ring-offset-[#010A20]"
              : "border-white/10 bg-white/5 hover:border-white/30 hover:bg-white/8"
          }`}
        >
          <p className="text-lg font-bold text-white mb-2">New Racer</p>
          <p className="text-white/50 text-xs leading-relaxed">
            I have <strong className="text-white/70">never raced at FastTrax Fort Myers</strong> before.
            Racing at other facilities does not count — all drivers start at Starter level here.
          </p>
        </button>

        {/* Existing racer */}
        <button
          onClick={() => onSelect("existing")}
          className={`text-left rounded-xl border p-5 transition-all duration-200 ${
            selected === "existing"
              ? "border-[#8652FF] bg-[#8652FF]/10 ring-2 ring-[#8652FF]/40 ring-offset-2 ring-offset-[#010A20]"
              : "border-white/10 bg-white/5 hover:border-white/30 hover:bg-white/8"
          }`}
        >
          <p className="text-lg font-bold text-white mb-2">Returning Racer</p>
          <p className="text-white/50 text-xs leading-relaxed">
            I have <strong className="text-white/70">already raced at FastTrax Fort Myers</strong> and
            have qualifying lap times for Intermediate or Pro races.
          </p>
        </button>
      </div>

      {selected === "new" && (
        <div className="rounded-xl border border-[#00E2E5]/20 bg-[#00E2E5]/5 p-4 max-w-xl mx-auto text-xs text-white/50 space-y-1">
          <p className="font-semibold text-[#00E2E5]/80 mb-1">What to expect</p>
          <p>All first-time FastTrax racers start with a <strong className="text-white/70">Starter Race</strong> — no exceptions, regardless of experience elsewhere.</p>
          <p>Once you post a qualifying lap time, you&apos;ll unlock Intermediate and Pro tiers.</p>
        </div>
      )}
    </div>
  );
}
