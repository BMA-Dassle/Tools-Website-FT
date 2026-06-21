"use client";

import { useEffect, useRef } from "react";
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
  const entryTaggedRef = useRef(false);

  useEffect(() => {
    // Never record /admin (staff PII views) or /account (customer subscription
    // + card last4 are rendered text — Strict input-masking does NOT hide them).
    if (!pathname || pathname.startsWith("/admin") || pathname.startsWith("/account")) return;
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

    // Fresh callable reference (the shim exists now, queuing until the script
    // finishes loading). Read separately so TS doesn't narrow it to undefined.
    const fire = (window as unknown as { clarity?: (...args: unknown[]) => void }).clarity;
    if (!fire) return;

    // Capture the entry source ONCE per mount: referrer host + campaign params,
    // so conversions can be traced back to the channel / QR code / link that
    // started the visit.
    if (!entryTaggedRef.current) {
      entryTaggedRef.current = true;
      try {
        const qs = new URLSearchParams(window.location.search);
        const ref = document.referrer ? new URL(document.referrer).hostname : "direct";
        fire("set", "entry_referrer", ref);
        const utm = qs.get("utm_source");
        if (utm) fire("set", "utm_source", utm);
        const code = qs.get("code");
        if (code) fire("set", "entry_code", code);
        const loc = qs.get("location");
        if (loc) fire("set", "entry_location", loc);
      } catch {
        /* non-fatal */
      }
    }

    // Booking-funnel outcome: every flow's success page shares "/confirmation"
    // in its path, so tag the converted session + fire a milestone here — no
    // per-confirmation-page edits needed. Detailed per-step tags are set inside
    // the booking wizard (see lib/clarity.ts usage in BookingFlow/CheckoutStep).
    if (pathname.includes("/confirmation")) {
      fire("set", "booking_outcome", "confirmed");
      fire("event", "booking:confirmed");
    }
  }, [pathname]);

  return null;
}
