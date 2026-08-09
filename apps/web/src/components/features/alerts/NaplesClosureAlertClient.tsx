"use client";

/**
 * HeadPinz Naples emergency closure notice — client half.
 *
 * NAPLES ONLY, same scoping idiom as NaplesOfferPopupClient:
 * `pathname.includes("naples")` (covers `/naples/*` and internal `/hp/naples/*`)
 * plus `?location=naples`, so a guest landing anywhere with Naples intent still
 * sees it.
 *
 * DELIBERATELY DIFFERENT from the offer popup's trigger rules, because this is
 * a service alert and not an ad:
 * - Fires IMMEDIATELY on mount. No dwell timer, no scroll threshold.
 * - Suppressed only on /kiosk and /admin (in-venue hardware and staff tools).
 *   It shows over /book, /checkout and /deals on purpose — a guest about to
 *   pay for a visit to a closed building is the single most important reader.
 * - Re-arms per browser SESSION (sessionStorage), not per 3 days: a returning
 *   guest tomorrow must be told again, but SPA navigation within one visit
 *   must not nag.
 */

import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { IconAlertTriangle, IconPhone, IconX } from "@tabler/icons-react";
import { isChromeFreePath } from "~/lib/constants/chrome-routes";

const INK = "#00041b";
const ACCENT = "#fd5b56";
const BODY = "rgba(245,236,238,0.85)";

/** sessionStorage key — dismissed for this browser session. */
const SEEN_KEY = "hp:naples-closure:dismissed";

/**
 * The closure is for the rest of Saturday 2026-08-09 only (owner). The alert
 * self-retires at 6 AM ET Sunday 2026-08-10 (EDT = UTC-4) so a "closed today"
 * notice can never describe a day on which the center is open. Checked at fire
 * time, so a tab left open overnight also never re-arms it.
 */
const SHOW_UNTIL_MS = Date.UTC(2026, 7, 10, 10, 0, 0);
const CLOSURE_DATE_LABEL = "Saturday, August 9";

const SUPPRESSED_PREFIXES = ["/kiosk", "/admin"];

const NAPLES_PHONE = "(239) 455-3755";
const NAPLES_PHONE_TEL = "+12394553755";

export function NaplesClosureAlertClient() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const restoreFocusTo = useRef<Element | null>(null);

  const suppressed =
    isChromeFreePath(pathname) ||
    SUPPRESSED_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));

  const dismiss = useCallback(() => {
    setOpen(false);
    try {
      window.sessionStorage.setItem(SEEN_KEY, "1");
    } catch {
      // Private mode / storage disabled — it shows again on the next page.
    }
  }, []);

  // Fire immediately when a Naples page is on screen and it hasn't been
  // dismissed this session. Client-only signals (URL, storage), so an effect.
  useEffect(() => {
    if (suppressed) return;
    if (Date.now() >= SHOW_UNTIL_MS) return;

    const params = new URLSearchParams(window.location.search);
    const isNaples =
      pathname.includes("naples") ||
      (params.get("location") ?? "").toLowerCase().includes("naples");
    if (!isNaples) return;

    try {
      if (window.sessionStorage.getItem(SEEN_KEY)) return;
    } catch {
      // Unreadable storage — treat as unseen rather than never showing.
    }

    restoreFocusTo.current = document.activeElement;
    setOpen(true);
  }, [suppressed, pathname]);

  // Modal behaviour: Esc, scroll lock, focus in and back out again.
  useEffect(() => {
    if (!open) return;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismiss();
      if (e.key !== "Tab" || !cardRef.current) return;
      const focusable = cardRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKey);
    const priorOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    cardRef.current?.focus();

    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = priorOverflow;
      (restoreFocusTo.current as HTMLElement | null)?.focus?.();
    };
  }, [open, dismiss]);

  if (!open || suppressed) return null;

  return (
    // z-[140]: above the Naples offer popup (z-[130]) — if both ever mount,
    // the closure wins.
    <div className="fixed inset-0 z-[140] flex items-center justify-center">
      <button
        type="button"
        aria-label="Close"
        onClick={dismiss}
        className="absolute inset-0 h-full w-full cursor-default bg-black/70 backdrop-blur-sm"
      />

      <div
        ref={cardRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="naples-closure-title"
        aria-describedby="naples-closure-body"
        tabIndex={-1}
        className="relative z-10 mx-4 flex max-h-[92dvh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-white/15 shadow-[0_30px_80px_rgba(0,0,0,0.6)] outline-none"
        style={{ background: INK }}
      >
        <button
          type="button"
          onClick={dismiss}
          aria-label="Close"
          className="absolute top-3 right-3 z-20 rounded-full bg-black/40 p-1.5 text-white/70 transition hover:bg-black/60 hover:text-white"
        >
          <IconX size={18} />
        </button>

        <div className="px-6 pt-7 pb-5 text-center" style={{ background: "rgba(253,91,86,0.14)" }}>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-[#fd5b56] px-3 py-1 text-xs font-bold tracking-[0.18em] text-[#00041b] uppercase">
            <IconAlertTriangle size={14} aria-hidden="true" />
            Service Alert
          </span>
          <h2
            id="naples-closure-title"
            className="font-display mt-3 text-3xl leading-tight text-white sm:text-4xl"
          >
            HeadPinz Naples is closed today
          </h2>
        </div>

        <div className="px-6 py-5">
          <p id="naples-closure-body" className="text-sm leading-relaxed" style={{ color: BODY }}>
            Due to a water main break, HeadPinz Naples is closed for the rest of the day today,{" "}
            {CLOSURE_DATE_LABEL}. We apologize for the inconvenience.
          </p>
          <p className="mt-3 text-sm leading-relaxed" style={{ color: BODY }}>
            If you have an upcoming reservation or any questions, please call us at{" "}
            <a
              href={`tel:${NAPLES_PHONE_TEL}`}
              className="font-semibold whitespace-nowrap text-white underline decoration-white/40 underline-offset-2 hover:decoration-white"
            >
              {NAPLES_PHONE}
            </a>
            .
          </p>
        </div>

        <div className="border-t border-white/10 px-6 py-4">
          <div className="flex flex-col gap-2 sm:flex-row">
            <a
              href={`tel:${NAPLES_PHONE_TEL}`}
              className="flex flex-1 items-center justify-center gap-2 rounded-full border border-white/25 px-6 py-3 text-center text-sm font-bold tracking-widest text-white uppercase transition hover:bg-white/10 sm:hidden"
            >
              <IconPhone size={16} style={{ color: ACCENT }} aria-hidden="true" />
              Call {NAPLES_PHONE}
            </a>
            <button
              type="button"
              onClick={dismiss}
              className="flex-1 rounded-full bg-[#fd5b56] px-6 py-3 text-center text-sm font-bold tracking-widest text-[#00041b] uppercase transition hover:brightness-110"
            >
              Got it
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
