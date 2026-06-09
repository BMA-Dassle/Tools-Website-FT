"use client";

import type { CenterCode } from "~/features/booking";

/**
 * Center confirmation for bowling/KBF when the session has no resolved center
 * (e.g. a generic entry with no /hp/<center> context and nothing else in the
 * cart to infer it from). Bowling books against a specific complex, so rather
 * than silently defaulting to one, we make the customer choose. Shown as a
 * blocking overlay until they pick.
 */
export function CenterPickerModal({ onSelect }: { onSelect: (center: CenterCode) => void }) {
  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center p-4"
      style={{ backgroundColor: "rgba(0,4,24,0.88)" }}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-full max-w-md rounded-2xl border border-white/10 p-6"
        style={{ backgroundColor: "#0a1128" }}
      >
        <h3 className="font-display text-xl uppercase tracking-widest text-white">
          Which location?
        </h3>
        <p className="mt-2 text-sm text-white/60">
          Confirm the HeadPinz you&apos;re booking bowling at — your lane is reserved at that
          center.
        </p>
        <div className="mt-5 grid grid-cols-1 gap-3">
          <button
            type="button"
            onClick={() => onSelect("fort-myers")}
            className="rounded-xl border border-white/15 px-4 py-4 text-left transition-colors hover:border-[#00E2E5]/60 hover:bg-white/[0.03]"
          >
            <span className="block text-sm font-bold text-white">HeadPinz Fort Myers</span>
            <span className="block text-xs text-white/45">14513 Global Pkwy, Fort Myers</span>
          </button>
          <button
            type="button"
            onClick={() => onSelect("naples")}
            className="rounded-xl border border-white/15 px-4 py-4 text-left transition-colors hover:border-[#00E2E5]/60 hover:bg-white/[0.03]"
          >
            <span className="block text-sm font-bold text-white">HeadPinz Naples</span>
            <span className="block text-xs text-white/45">8525 Radio Ln, Naples</span>
          </button>
        </div>
      </div>
    </div>
  );
}
