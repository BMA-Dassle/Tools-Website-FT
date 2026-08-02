"use client";

/**
 * The one thing an entry-screen scan can put on screen.
 *
 * A scan that routes says nothing — the screen change IS the feedback. This
 * renders only the misses: a gift card, a licence, an unreadable payload, or a
 * destination that's switched off (owner 2026-08-02: "brief toast, stay put").
 *
 * Deliberately NON-BLOCKING and NON-INTERACTIVE. It must never steal a tap
 * from the attract loop or the category cards underneath, so it is
 * `pointer-events-none` and has no dismiss control — it fades itself. It is
 * also NOT wired to the Guest assistance beacon: stray scans are common and
 * nuisance radio alerts would train staff to ignore it.
 *
 * `position: fixed` here anchors to the 1080×1920 KioskStage canvas (the stage
 * transform establishes the containing block), so the offsets are canvas px.
 */
import { useEffect } from "react";
import { useT } from "../i18n";
import type { MessageKey } from "../i18n";
import type { EntryScanMiss } from "./useEntryScanRouter";

/** How long a miss stays up before it fades itself. */
const TOAST_MS = 5_000;

const COPY: Record<EntryScanMiss, MessageKey> = {
  "gift-card": "entryscan.giftCard",
  license: "entryscan.license",
  unknown: "entryscan.unknown",
  "no-destination": "entryscan.noDestination",
  "try-again": "entryscan.tryAgain",
};

export function EntryScanToast(props: {
  miss: EntryScanMiss | null;
  /** Cleared on the caller's state so a repeat scan re-fires the animation. */
  onDone: () => void;
  /** The one conditional lookup is in flight. */
  busy?: boolean;
}) {
  const t = useT();
  const { miss, onDone, busy } = props;

  useEffect(() => {
    if (!miss) return;
    const id = setTimeout(onDone, TOAST_MS);
    return () => clearTimeout(id);
  }, [miss, onDone]);

  if (!miss && !busy) return null;

  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-[160px] z-[280] flex justify-center px-[60px]"
      role="status"
      aria-live="polite"
    >
      <div className="k-glass max-w-[820px] px-[40px] py-[24px] text-center text-[28px] leading-tight text-white/90">
        {busy ? t("entryscan.checking") : t(COPY[miss!])}
      </div>
    </div>
  );
}
