"use client";

/**
 * On-glass debug console for the TEST kiosk (kiosk 99 — `isTestKiosk`).
 *
 * Renders the debug bus so a manager standing at the kiosk can watch the waiver
 * path narrate itself: which rail minted the person, whether the guardian's
 * waiver came from OUR record or Pandora's, what each barrier probe said, which
 * path the sign took, and what BMI answered. That last half is server-side and
 * was previously invisible without opening Vercel logs.
 *
 * Starts COLLAPSED as a small tab so it never covers a guest-facing control on a
 * kiosk that happens to be serving people. Never mounted anywhere but kiosk 99.
 */
import { useEffect, useState } from "react";
import { clearKioskDebug, subscribeKioskDebug, type DebugEvent, type DebugLevel } from "./bus";

const LEVEL_COLOR: Record<DebugLevel, string> = {
  info: "text-white/70",
  good: "text-[#46d68c]",
  warn: "text-[#f0b341]",
  bad: "text-[#f87171]",
};

/** HH:MM:SS.mmm — the milliseconds matter, since the whole point is ordering
 *  and elapsed time between rails. */
function stamp(at: number): string {
  const d = new Date(at);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

export default function KioskDebugPanel() {
  const [events, setEvents] = useState<DebugEvent[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => subscribeKioskDebug(setEvents), []);

  // Newest event's age drives the tab colour, so a collapsed panel still shows
  // that something just went wrong.
  const worstRecent = events.slice(0, 8).some((e) => e.level === "bad")
    ? "bad"
    : events.slice(0, 8).some((e) => e.level === "warn")
      ? "warn"
      : "info";

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open kiosk debug console"
        className={`fixed bottom-0 left-0 z-[95] rounded-tr-xl border border-white/15 bg-[#04091c] px-[18px] py-[10px] font-mono text-[18px] ${
          worstRecent === "bad"
            ? "text-[#f87171]"
            : worstRecent === "warn"
              ? "text-[#f0b341]"
              : "text-white/50"
        }`}
      >
        DEBUG 99 · {events.length}
      </button>
    );
  }

  return (
    <div className="fixed bottom-0 left-0 right-0 z-[95] max-h-[46vh] border-t-2 border-[#00e2e5]/40 bg-[#04091c]/97 backdrop-blur">
      <div className="flex items-center justify-between border-b border-white/10 px-[24px] py-[12px]">
        <span className="font-mono text-[20px] tracking-widest text-[#00e2e5]">
          KIOSK 99 DEBUG · {events.length} events
        </span>
        <div className="flex gap-[12px]">
          <button
            type="button"
            onClick={() => clearKioskDebug()}
            className="rounded-lg border border-white/20 px-[18px] py-[8px] font-mono text-[18px] text-white/60"
          >
            CLEAR
          </button>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="rounded-lg border border-white/20 px-[18px] py-[8px] font-mono text-[18px] text-white/60"
          >
            HIDE
          </button>
        </div>
      </div>
      <div className="max-h-[36vh] overflow-y-auto px-[24px] py-[12px]">
        {events.length === 0 ? (
          <p className="font-mono text-[18px] text-white/35">
            Nothing yet. Add a guest or sign a waiver.
          </p>
        ) : (
          <ul className="flex flex-col gap-[4px]">
            {events.map((e) => (
              <li key={e.seq} className="flex gap-[14px] font-mono text-[18px] leading-snug">
                <span className="shrink-0 text-white/30 tabular-nums">{stamp(e.at)}</span>
                <span className="w-[92px] shrink-0 uppercase text-[#00e2e5]/70">{e.tag}</span>
                <span className={LEVEL_COLOR[e.level]}>{e.message}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
