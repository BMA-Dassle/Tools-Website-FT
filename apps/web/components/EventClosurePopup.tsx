"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { IconCalendarEvent, IconX } from "@tabler/icons-react";
import { modalBackdropProps } from "@/lib/a11y";

/**
 * Self-expiring "closed for a private event" notice for the Healthcare Network
 * buyout on Fri 6/19/2026 (facility reserved 9 AM–2 PM; public play resumes at
 * 2:30 PM). Shown on the FastTrax home + HeadPinz Fort Myers pages.
 *
 * It REMOVES ITSELF at the reopen instant — no manual takedown:
 *   - Renders nothing server-side / before hydration (avoids caching + mismatch).
 *   - On mount, hides immediately if we're already past the reopen instant.
 *   - If the tab is left open across the reopen instant, a timer hides it live.
 *   - Dismissal is remembered per browser session (sessionStorage), so it informs
 *     a returning visitor but doesn't nag during one session.
 *
 * EXPIRES_AT mirrors healthnet-2026's `publicReopensAt: "14:30"` in
 * lib/group-events.ts — keep the two in sync. June is EDT (UTC−4), so
 * 2:30 PM ET = 18:30 UTC; the explicit −04:00 offset pins the exact instant
 * with no DST ambiguity.
 */
const EXPIRES_AT_MS = Date.parse("2026-06-19T14:30:00-04:00");
const SESSION_KEY = "ft-closure-healthnet-2026-06-19";

type Brand = "fasttrax" | "headpinz";

interface BookLink {
  label: string;
  href: string;
}

const PRESETS: Record<
  Brand,
  { venue: string; accent: string; onAccent: string; links: [BookLink, BookLink] }
> = {
  fasttrax: {
    venue: "FastTrax Fort Myers",
    accent: "#00E2E5",
    onAccent: "#000418",
    links: [
      { label: "Book a Race", href: "/book/race" },
      { label: "All Activities", href: "/book" },
    ],
  },
  headpinz: {
    venue: "HeadPinz Fort Myers",
    accent: "#fd5b56",
    onAccent: "#0a1628",
    links: [
      { label: "Book Bowling", href: "/hp/book/bowling" },
      { label: "All Activities", href: "/hp/book" },
    ],
  },
};

export default function EventClosurePopup({ brand }: { brand: Brand }) {
  const [visible, setVisible] = useState(false);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const preset = PRESETS[brand];

  useEffect(() => {
    // Past the reopen instant → never show again (auto-expired).
    if (Date.now() >= EXPIRES_AT_MS) return;
    try {
      if (sessionStorage.getItem(SESSION_KEY)) return;
    } catch {
      /* sessionStorage blocked (private mode) — show anyway */
    }

    const showTimer = setTimeout(() => setVisible(true), 500);
    // If the tab lingers past 2:30 PM, hide it live without a refresh.
    const expireTimer = setTimeout(() => setVisible(false), EXPIRES_AT_MS - Date.now());
    return () => {
      clearTimeout(showTimer);
      clearTimeout(expireTimer);
    };
  }, []);

  useEffect(() => {
    if (visible) closeRef.current?.focus();
  }, [visible]);

  if (!visible) return null;

  function dismiss() {
    setVisible(false);
    try {
      sessionStorage.setItem(SESSION_KEY, "1");
    } catch {
      /* ignore */
    }
  }

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      {...modalBackdropProps(dismiss)}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="closure-title"
        className="relative w-full max-w-md overflow-hidden rounded-2xl border border-white/10 bg-[#0a1020] shadow-2xl"
        style={{ boxShadow: `0 0 0 1px ${preset.accent}33, 0 20px 60px rgba(0,0,0,0.6)` }}
      >
        <button
          ref={closeRef}
          type="button"
          onClick={dismiss}
          aria-label="Dismiss notice"
          className="absolute right-3 top-3 rounded-full p-1.5 text-white/50 transition-colors hover:bg-white/10 hover:text-white"
        >
          <IconX size={20} stroke={2} />
        </button>

        {/* Accent header */}
        <div
          className="flex items-center gap-3 px-6 pb-4 pt-6"
          style={{ background: `linear-gradient(180deg, ${preset.accent}1f, transparent)` }}
        >
          <span
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl"
            style={{ backgroundColor: `${preset.accent}1f`, color: preset.accent }}
          >
            <IconCalendarEvent size={24} stroke={1.75} />
          </span>
          <p
            className="text-xs font-semibold uppercase tracking-[3px]"
            style={{ color: preset.accent }}
          >
            This Friday · June 19
          </p>
        </div>

        <div className="px-6 pb-6">
          <h2
            id="closure-title"
            className="font-display text-2xl uppercase leading-tight tracking-wide text-white"
          >
            We Open at 2:30 PM Friday
          </h2>
          <p className="mt-3 text-sm leading-relaxed text-white/70">
            {preset.venue} is hosting a private event Friday morning, June 19. Public booking opens
            at <span className="font-semibold text-white">2:30 PM</span> — reserve your spot below.
          </p>

          <div className="mt-5 flex flex-col gap-2.5 sm:flex-row">
            <Link
              href={preset.links[0].href}
              onClick={dismiss}
              className="flex-1 rounded-xl px-4 py-3 text-center text-sm font-bold transition-transform hover:scale-[1.02]"
              style={{ backgroundColor: preset.accent, color: preset.onAccent }}
            >
              {preset.links[0].label}
            </Link>
            <Link
              href={preset.links[1].href}
              onClick={dismiss}
              className="flex-1 rounded-xl border border-white/15 px-4 py-3 text-center text-sm font-semibold text-white/80 transition-colors hover:border-white/30 hover:text-white"
            >
              {preset.links[1].label}
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
