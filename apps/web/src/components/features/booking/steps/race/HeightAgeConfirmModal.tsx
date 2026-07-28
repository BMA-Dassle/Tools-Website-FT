"use client";

import { useEffect, useRef, useState } from "react";
import { modalBackdropProps } from "@/lib/a11y";
import { useT } from "~/features/kiosk/i18n";

/**
 * The pre-race height/age safety confirm.
 *
 * Fully localized (owner 2026-07-28: this needs Spanish, and does NOT need the
 * attorney review the waiver body is waiting on) — a Spanish-speaking guest was
 * being asked to tick four English boxes attesting to their kids’ age and
 * height, which is the one screen where not understanding the words is a safety
 * problem rather than an inconvenience.
 *
 * Shared with the web wizard: `useT()` falls back to the default English locale
 * when there is no LocaleProvider above it, so web renders exactly as before.
 * The requirement figures are unchanged; the Spanish restates them in meters in
 * the same parenthetical the English uses to restate 59″ as 4′11″.
 */
interface HeightAgeConfirmModalProps {
  adults: number;
  juniors: number;
  onConfirm: () => void;
  onChangeParty: () => void;
  /** Kiosk overrides the copy — it has no date step (always today), so it says
   *  "pick a time" not "pick a date" (`heightAge.subheadingKiosk` /
   *  `heightAge.confirmContinue`). Omitted = the web date-flow defaults. */
  subheading?: string;
  confirmLabel?: string;
}

export function HeightAgeConfirmModal({
  adults,
  juniors,
  onConfirm,
  onChangeParty,
  subheading,
  confirmLabel,
}: HeightAgeConfirmModalProps) {
  const t = useT();
  // Resolved in the body, not as a default parameter — `t` doesn’t exist yet
  // when default params are evaluated.
  const subheadingText = subheading ?? t("heightAge.subheading");
  const confirmText = confirmLabel ?? t("heightAge.confirmDate");

  const disclaimers: string[] = [];
  if (adults > 0) disclaimers.push(t("heightAge.adults", { count: adults }));
  if (juniors > 0) disclaimers.push(t("heightAge.juniors", { count: juniors }));
  disclaimers.push(t("heightAge.notPermitted"));
  disclaimers.push(t("heightAge.strictRules"));

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
      aria-label={t("heightAge.aria")}
    >
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        {...modalBackdropProps(onChangeParty)}
      />

      <div className="relative max-h-[80vh] w-full max-w-md overflow-y-auto rounded-2xl border border-white/15 bg-[#0a1628] shadow-2xl">
        <div className="p-5 sm:p-6">
          <h2 className="mb-1 text-lg font-bold text-white">{t("heightAge.title")}</h2>
          <p className="mb-5 text-xs text-white/50">{subheadingText}</p>

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
              {t("heightAge.checkAll")}
            </p>
          )}

          <div className="mt-5 flex flex-col gap-2 sm:flex-row">
            <button
              type="button"
              onClick={handleConfirm}
              className="flex-1 rounded-xl bg-[#00E2E5] px-6 py-3 text-sm font-bold text-[#000418] transition-colors hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              {confirmText}
            </button>
            <button
              type="button"
              onClick={onChangeParty}
              className="rounded-xl border border-white/15 px-6 py-3 text-sm font-semibold text-white/60 transition-colors hover:border-white/30 hover:text-white"
            >
              {t("heightAge.changeParty")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
