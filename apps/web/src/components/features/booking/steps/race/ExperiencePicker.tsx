"use client";

/**
 * Experience picker — first screen of the race wizard. v1 parity port
 * from `apps/web/app/book/race/components/ExperiencePicker.tsx`.
 *
 * Owns its own heading + subtitle (v2's RacePartyStep wraps it without
 * adding any chrome) so the layout matches v1 1:1.
 */
interface ExperiencePickerProps {
  selected: "new" | "existing" | null;
  onSelect: (type: "new" | "existing") => void;
}

export function ExperiencePicker({ selected, onSelect }: ExperiencePickerProps) {
  return (
    <div className="space-y-6">
      <div className="space-y-2 text-center">
        <h2 className="font-display text-2xl tracking-widest text-white uppercase">
          Have you raced at FastTrax before?
        </h2>
        <p className="mx-auto max-w-md text-sm text-white/40">
          This helps us find the right race for your group.
        </p>
      </div>

      <div className="mx-auto grid max-w-xl grid-cols-1 gap-4 sm:grid-cols-2">
        <button
          type="button"
          onClick={() => onSelect("new")}
          className={`rounded-xl border p-5 text-left transition-all duration-200 ${
            selected === "new"
              ? "border-[#00E2E5] bg-[#00E2E5]/10 ring-2 ring-[#00E2E5]/40 ring-offset-2 ring-offset-[#010A20]"
              : "border-white/10 bg-white/5 hover:border-white/30 hover:bg-white/8"
          }`}
        >
          <p className="mb-2 text-lg font-bold text-white">New Racer</p>
          <p className="text-xs leading-relaxed text-white/50">
            I have <strong className="text-white/70">never raced at FastTrax Fort Myers</strong>{" "}
            before. Racing at other facilities does not count — all drivers start at Starter level
            here.
          </p>
        </button>

        <button
          type="button"
          onClick={() => onSelect("existing")}
          className={`rounded-xl border p-5 text-left transition-all duration-200 ${
            selected === "existing"
              ? "border-[#8652FF] bg-[#8652FF]/10 ring-2 ring-[#8652FF]/40 ring-offset-2 ring-offset-[#010A20]"
              : "border-white/10 bg-white/5 hover:border-white/30 hover:bg-white/8"
          }`}
        >
          <p className="mb-2 text-lg font-bold text-white">Returning Racer</p>
          <p className="text-xs leading-relaxed text-white/50">
            I have <strong className="text-white/70">already raced at FastTrax Fort Myers</strong>{" "}
            and have qualifying lap times for Intermediate or Pro races.
          </p>
        </button>
      </div>

      {selected === "new" && (
        <div className="mx-auto max-w-xl space-y-1 rounded-xl border border-[#00E2E5]/20 bg-[#00E2E5]/5 p-4 text-xs text-white/50">
          <p className="mb-1 font-semibold text-[#00E2E5]/80">What to expect</p>
          <p>
            All first-time FastTrax racers start with a{" "}
            <strong className="text-white/70">Starter Race</strong> — no exceptions, regardless of
            experience elsewhere.
          </p>
          <p>Once you post a qualifying lap time, you&apos;ll unlock Intermediate and Pro tiers.</p>
        </div>
      )}
    </div>
  );
}
