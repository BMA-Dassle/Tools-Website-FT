"use client";

interface ExperiencePickerProps {
  selected: "new" | "existing" | null;
  onSelect: (type: "new" | "existing") => void;
}

export function ExperiencePicker({ selected, onSelect }: ExperiencePickerProps) {
  return (
    <div className="mx-auto max-w-sm space-y-3">
      <ExperienceButton
        active={selected === "new"}
        title="New Racer"
        description="Never raced at FastTrax? Everyone starts at Starter speed."
        onClick={() => onSelect("new")}
      />
      <ExperienceButton
        active={selected === "existing"}
        title="Returning Racer"
        description="Already raced with us? Log in to unlock your earned speeds."
        onClick={() => onSelect("existing")}
      />
    </div>
  );
}

function ExperienceButton({
  active,
  title,
  description,
  onClick,
}: {
  active: boolean;
  title: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full rounded-xl border p-4 text-left transition-all duration-200 ${
        active
          ? "border-[#00E2E5] bg-[#00E2E5]/10 ring-1 ring-[#00E2E5]/50"
          : "border-white/10 bg-white/5 hover:border-white/25 hover:bg-white/10"
      }`}
    >
      <p className="font-bold text-white">{title}</p>
      <p className="mt-0.5 text-xs text-white/50">{description}</p>
    </button>
  );
}
