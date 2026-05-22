"use client";

import { useEffect, useRef, useState } from "react";
import { modalBackdropProps } from "@/lib/a11y";

interface HeightAgeConfirmModalProps {
  adults: number;
  juniors: number;
  onConfirm: () => void;
  onChangeParty: () => void;
}

export function HeightAgeConfirmModal({
  adults,
  juniors,
  onConfirm,
  onChangeParty,
}: HeightAgeConfirmModalProps) {
  const disclaimers: string[] = [];
  if (adults > 0) {
    disclaimers.push(
      `I have ${adults} adult racer${adults !== 1 ? "s" : ""} who ${adults !== 1 ? "are each" : "is"} at least 13 years old and at least 59" tall (4'11")`,
    );
  }
  if (juniors > 0) {
    disclaimers.push(
      `I have ${juniors} junior racer${juniors !== 1 ? "s" : ""} who ${juniors !== 1 ? "are each" : "is"} between ages 7–13 and between 49" and 70" tall`,
    );
  }
  disclaimers.push(
    "I understand that racers who do not meet height or age requirements will not be permitted to race",
  );
  disclaimers.push(
    "FastTrax has strict age and height requirements, some enforceable by state regulations. Misrepresenting age may result in removal from the facility.",
  );

  const [acks, setAcks] = useState<boolean[]>(() => disclaimers.map(() => false));
  const [showWarning, setShowWarning] = useState(false);
  const warnRef = useRef<HTMLParagraphElement>(null);

  const allChecked = acks.every(Boolean);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  function handleConfirm() {
    if (!allChecked) {
      setShowWarning(true);
      warnRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    onConfirm();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Height and age confirmation"
    >
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        {...modalBackdropProps(onChangeParty)}
      />

      <div className="relative max-h-[80vh] w-full max-w-md overflow-y-auto rounded-2xl border border-white/15 bg-[#0a1628] shadow-2xl">
        <div className="p-5 sm:p-6">
          <h2 className="mb-1 text-lg font-bold text-white">Confirm Height &amp; Age</h2>
          <p className="mb-5 text-xs text-white/50">
            Please confirm each requirement below before picking a date.
          </p>

          <div className="space-y-3">
            {disclaimers.map((text, i) => (
              <label
                key={i}
                className="flex cursor-pointer items-start gap-3 rounded-lg border border-white/10 bg-white/3 p-3 transition-colors hover:border-white/20"
              >
                <div className="relative mt-0.5 shrink-0">
                  <input
                    type="checkbox"
                    checked={acks[i]}
                    onChange={(e) => {
                      const next = [...acks];
                      next[i] = e.target.checked;
                      setAcks(next);
                      if (e.target.checked) setShowWarning(false);
                    }}
                    className="sr-only"
                  />
                  <div
                    className={`flex h-4 w-4 items-center justify-center rounded border-2 transition-colors ${
                      acks[i]
                        ? "border-[#00E2E5] bg-[#00E2E5]"
                        : showWarning && !acks[i]
                          ? "border-red-500/50 ring-2 ring-red-500/30"
                          : "border-white/30"
                    }`}
                  >
                    {acks[i] && (
                      <svg
                        className="h-2.5 w-2.5 text-[#000418]"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="3"
                        viewBox="0 0 24 24"
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                  </div>
                </div>
                <span className="text-xs leading-relaxed text-white/70">{text}</span>
              </label>
            ))}
          </div>

          {showWarning && (
            <p
              ref={warnRef}
              className="mt-3 animate-pulse text-center text-xs font-semibold text-red-400"
            >
              Please check all boxes above to continue
            </p>
          )}

          <div className="mt-5 flex flex-col gap-2 sm:flex-row">
            <button
              type="button"
              onClick={handleConfirm}
              className="flex-1 rounded-xl bg-[#00E2E5] px-6 py-3 text-sm font-bold text-[#000418] transition-colors hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              Confirm &amp; Pick a Date →
            </button>
            <button
              type="button"
              onClick={onChangeParty}
              className="rounded-xl border border-white/15 px-6 py-3 text-sm font-semibold text-white/60 transition-colors hover:border-white/30 hover:text-white"
            >
              Change Party Size
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
