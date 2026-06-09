"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

/**
 * Microsoft Clarity — session replay + heatmaps for the booking/marketing site.
 *
 * Loads on all public routes INCLUDING KBF (product decision 2026-06-09 — no
 * kids PII captured to worry about). Admin routes (`/admin/*`) are NEVER
 * recorded: they're staff views of customer PII.
 *
 * Masking: controlled in the Clarity dashboard (project x4kmifcwpp). Keep it on
 * "Strict" so typed input (names, emails, phones) is never captured — you still
 * see clicks, scrolls, rage-clicks, and navigation. Payment fields are Square
 * iframes and are not capturable regardless.
 *
 * Admin exclusion is reliable because /admin is a token URL not linked from the
 * public SPA nav — it always loads fresh, so this effect re-evaluates the path
 * and skips init.
 */

const CLARITY_PROJECT_ID = "x4kmifcwpp";

export default function ClarityAnalytics() {
  const pathname = usePathname();

  useEffect(() => {
    if (!pathname || pathname.startsWith("/admin")) return;
    if (typeof window === "undefined") return;

    const win = window as unknown as {
      clarity?: ((...args: unknown[]) => void) & { q?: unknown[] };
    };

    // Inject the Clarity tag once. Its shim queues calls until the script loads,
    // so tags/events fired immediately after are not lost.
    if (!win.clarity) {
      (function (c: Window, l: Document, a: string, r: string, i: string) {
        const w = c as unknown as Record<
          string,
          { q?: unknown[] } & ((...args: unknown[]) => void)
        >;
        w[a] =
          w[a] ||
          function (...args: unknown[]) {
            (w[a].q = w[a].q || []).push(args);
          };
        const t = l.createElement(r) as HTMLScriptElement;
        t.async = true;
        t.src = "https://www.clarity.ms/tag/" + i;
        const y = l.getElementsByTagName(r)[0];
        y.parentNode?.insertBefore(t, y);
      })(window, document, "clarity", "script", CLARITY_PROJECT_ID);
    }

    // Booking-funnel outcome: every flow's success page shares "/confirmation"
    // in its path, so tag the converted session + fire a milestone here — no
    // per-confirmation-page edits needed. Detailed per-step tags are set inside
    // the booking wizard (see lib/clarity.ts usage in BookingFlow/CheckoutStep).
    if (pathname.includes("/confirmation")) {
      win.clarity?.("set", "booking_outcome", "confirmed");
      win.clarity?.("event", "booking:confirmed");
    }
  }, [pathname]);

  return null;
}
