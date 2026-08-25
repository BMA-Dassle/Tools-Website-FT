"use client";

import { useEffect, useState } from "react";
import { megaWindowTodayET, type MegaDayWindow } from "~/features/racing/mega-calendar";

/**
 * Shows an alert ONLY on a Mega Track day. Mega runs JUNIOR PRO races
 * only (owner 2026-08-05, effective 2026-08-10) — no Junior Starter and no
 * Junior Intermediate — so every junior below Junior Pro has to race a
 * split-track (Blue/Red) day instead.
 *
 * WHICH days are Mega comes from `mega-calendar`, not from a weekday literal
 * here: Mega runs every Tuesday, plus Thursdays for the Sep–Oct 2026 season.
 * The banner names whichever day it actually is.
 *
 * Time zone is America/New_York so the alert flips at midnight ET —
 * matches when operations staff and racers consider the day to start,
 * not when Vercel's UTC server does.
 */
export default function MegaDayAlert() {
  const [megaWindow, setMegaWindow] = useState<MegaDayWindow | null>(null);

  useEffect(() => {
    // Must run on client: uses window.location (URL override) and needs
    // "now" in ET, which differs from Vercel's UTC server. setState in effect
    // is the correct shape here — there is no pure-render alternative without
    // causing SSR/client hydration mismatches.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMegaWindow(() => {
      const today = megaWindowTodayET();
      // URL override for testing / ops preview: ?mega=1 forces the alert
      // visible. Off a Mega day there is no window to name, so it previews as
      // the standing one rather than inventing a day.
      if (!today && new URLSearchParams(window.location.search).get("mega") === "1") {
        return MEGA_PREVIEW_WINDOW;
      }
      return today;
    });
  }, []);

  if (!megaWindow) return null;

  return (
    <div
      className="relative rounded-lg border-2 px-4 py-3 max-w-lg animate-pulse"
      style={{
        borderColor: "#8B5CF6", // Mega purple
        background: "linear-gradient(135deg, rgba(139,92,246,0.18), rgba(239,68,68,0.14))",
        boxShadow: "0 0 18px rgba(139,92,246,0.35), 0 0 4px rgba(239,68,68,0.6)",
      }}
    >
      <div className="flex items-center gap-2 mb-1">
        <span className="text-xs font-bold uppercase tracking-widest text-red-400">Alert</span>
        <span className="font-bold text-sm uppercase tracking-wider" style={{ color: "#B794F6" }}>
          Mega Track {megaWindow.dayName}
        </span>
      </div>
      <p className="text-white/90 text-sm leading-relaxed">
        Today we combine our Blue and Red tracks into one epic{" "}
        <strong style={{ color: "#B794F6" }}>Mega Track</strong> — longer, faster, wilder.{" "}
        <strong className="text-red-300">
          Junior racing on Mega days is Junior Pro only — no Junior Starter or Junior Intermediate.
        </strong>{" "}
        All adult racers are welcome; juniors qualify up to Junior Pro on a split-track day first.
      </p>
    </div>
  );
}

/** What `?mega=1` previews on a day that is not actually Mega. */
const MEGA_PREVIEW_WINDOW: MegaDayWindow = {
  weekday: 2,
  dayName: "Tuesday",
  label: "Mega Tuesday",
  plural: "Mega Tuesdays",
  from: "0000-01-01",
  until: null,
};
