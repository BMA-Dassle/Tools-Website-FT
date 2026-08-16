"use client";

import { useEffect, useRef, useState } from "react";
import { IconAlertTriangle } from "@tabler/icons-react";
import { modalBackdropProps } from "@/lib/a11y";
import { useT } from "~/features/kiosk/i18n";
import type { AckPrompt } from "~/features/booking/service/race-warnings";

/**
 * The "this race is slower than you think" confirm.
 *
 * Deliberately the same shape as its sibling `HeightAgeConfirmModal`: a list of
 * checkboxes, every one required, and a Continue that REVEALS the reason it
 * won't advance rather than sitting disabled. A disabled button with no
 * explanation is the version guests get stuck on.
 *
 * Renders whatever `warning` describes — it knows nothing about juniors,
 * Starter, or packages. Adding a warning for another category or tier is a
 * record in race-warnings.ts plus its copy keys; this file does not change.
 *
 * Serves BOTH prompt kinds (see `AckPrompt`): tier-expectation warnings and
 * package disclaimers. They are different things that need the identical
 * treatment — read this, tick every box, then you may continue — and having one
 * component means the kiosk cannot end up with a localized version of one and a
 * hardcoded-English version of the other.
 *
 * Shared web + kiosk: `useT()` falls back to English when there is no
 * LocaleProvider above it, so the web wizard renders English without web
 * needing an i18n setup, and the kiosk gets Spanish for free.
 *
 * Louder than the height/age modal on purpose — amber rule, warning glyph,
 * bigger tap targets. This one exists because guests were missing the message.
 */
interface RaceWarningModalProps {
  warning: AckPrompt;
  /** Ticked everything and chose to book it anyway. */
  onAcknowledge: () => void;
  /**
   * Take the upsell instead. OMIT to hide the button entirely — the caller is
   * responsible for only passing this when a variant of
   * `warning.upsellPackagePrefix` is genuinely bookable for the chosen date.
   * A button that leads somewhere empty is worse than no button.
   */
  onUpsell?: () => void;
  /** Backed out — Escape, backdrop, or "Go back". */
  onCancel: () => void;
}

export function RaceWarningModal({
  warning,
  onAcknowledge,
  onUpsell,
  onCancel,
}: RaceWarningModalProps) {
  const t = useT();
  const [acks, setAcks] = useState<boolean[]>(() => warning.ackKeys.map(() => false));
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

  function handleContinue() {
    if (!allChecked) {
      setShowWarning(true);
      warnRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    onAcknowledge();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label={t(warning.titleKey)}
    >
      <div
        className="absolute inset-0 bg-black/75 backdrop-blur-sm"
        {...modalBackdropProps(onCancel)}
      />

      <div className="relative max-h-[85vh] w-full max-w-md overflow-y-auto rounded-2xl border border-amber-500/40 bg-[#0a1628] shadow-2xl">
        {/* The one piece of chrome that makes this read as a warning and not as
            another step — a solid amber rule across the top of the panel. */}
        <div className="h-1 rounded-t-2xl bg-[#f0b341]" />

        <div className="p-5 sm:p-6">
          <div className="mb-3 flex items-start gap-3">
            <IconAlertTriangle
              size={30}
              stroke={1.7}
              color="#f0b341"
              aria-hidden="true"
              className="mt-0.5 shrink-0"
            />
            <h2 className="text-lg font-bold leading-tight text-white">{t(warning.titleKey)}</h2>
          </div>

          <p className="mb-3 text-xs leading-relaxed text-white/65">{t(warning.bodyKey)}</p>
          {warning.emphasisKey && (
            <p className="mb-5 text-xs font-semibold leading-relaxed text-[#f0b341]">
              {t(warning.emphasisKey)}
            </p>
          )}

          <div className="space-y-3">
            {warning.ackKeys.map((key, i) => (
              <label
                key={key}
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
                <span className="text-xs leading-relaxed text-white/70">{t(key)}</span>
              </label>
            ))}
          </div>

          {showWarning && (
            <p
              ref={warnRef}
              className="mt-3 animate-pulse text-center text-xs font-semibold text-red-400"
            >
              {t("raceWarning.checkAll")}
            </p>
          )}

          {/* The upsell leads. This modal exists to move people onto it, and the
              acknowledgements only gate the OTHER path — someone taking the
              recommendation should not have to tick three boxes first. */}
          <div className="mt-5 flex flex-col gap-2">
            {onUpsell && warning.upsellKey && (
              <button
                type="button"
                onClick={onUpsell}
                className="rounded-xl bg-[#00E2E5] px-6 py-3 text-sm font-bold text-[#000418] transition-colors hover:bg-white"
              >
                {t(warning.upsellKey)}
              </button>
            )}
            <button
              type="button"
              onClick={handleContinue}
              className="rounded-xl border border-white/20 px-6 py-3 text-sm font-semibold text-white/85 transition-colors hover:border-white/40"
            >
              {t(warning.continueKey)}
            </button>
            <button
              type="button"
              onClick={onCancel}
              className="px-6 py-2 text-xs font-semibold text-white/45 transition-colors hover:text-white/80"
            >
              {t("raceWarning.goBack")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
