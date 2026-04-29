"use client";

import { modalBackdropProps } from "@/lib/a11y";
import type { CardDetails } from "./cards";
import { formatTime, formatDate } from "./cards";

/**
 * Full-screen "show this to the Karting attendant" view. White
 * background + huge text so staff can read the heat info
 * across the counter without bringing the phone close. Tap
 * anywhere to dismiss — same UX pattern as the confirmation
 * page's fullscreen QR modal so customers already know it.
 *
 * Single-racer mode: pass `racers` with one entry — name renders
 * largest. Multi-racer (group ticket per-session): pass all
 * racers in the same heat — they list together so staff can
 * verify the whole party at once.
 */
export default function FullScreenTicket({
  racers,
  heat,
  onClose,
}: {
  /** All racers sharing this heat. Order is preserved. */
  racers: { firstName: string; lastName: string }[];
  /** Shared session metadata. */
  heat: Pick<CardDetails, "scheduledStart" | "track" | "raceType" | "heatNumber" | "resNumber">;
  onClose: () => void;
}) {
  const trackLabel = heat.track ? heat.track.replace(/\s+Track$/i, "") : "";
  const isSingle = racers.length === 1;
  return (
    <div
      className="fixed inset-0 z-50 bg-white flex flex-col items-center justify-center px-6 py-10 overflow-y-auto"
      {...modalBackdropProps(onClose)}
    >
      <div className="text-center max-w-md w-full">
        <p className="text-gray-500 text-xs uppercase tracking-[0.3em] mb-3">
          FastTrax E-Ticket
          {!isSingle && <span className="ml-2 normal-case tracking-normal">· {racers.length} racers</span>}
        </p>

        {/* Racer names — biggest on single, slightly smaller in
            multi-racer so the list fits. */}
        <div className="space-y-1">
          {racers.map((r, i) => (
            <p
              key={i}
              className="text-black font-black uppercase leading-none"
              style={{
                fontSize: isSingle
                  ? "clamp(2.5rem, 9vw, 4.5rem)"
                  : "clamp(1.5rem, 6vw, 2.5rem)",
                letterSpacing: "-0.02em",
              }}
            >
              {r.firstName} {r.lastName}
            </p>
          ))}
        </div>

        {/* Heat / track / race type — second-tier emphasis */}
        <div className="mt-8 mb-2">
          <p
            className="text-black font-bold uppercase tracking-wide leading-tight"
            style={{ fontSize: "clamp(1.5rem, 5vw, 2.25rem)" }}
          >
            Heat {heat.heatNumber}
          </p>
          <p
            className="text-gray-700 font-semibold uppercase tracking-wide mt-1"
            style={{ fontSize: "clamp(1rem, 3.5vw, 1.5rem)" }}
          >
            {trackLabel} · {heat.raceType}
          </p>
        </div>

        {/* Time + date */}
        <div className="mt-6">
          <p
            className="text-black font-bold"
            style={{ fontSize: "clamp(1.75rem, 6vw, 2.75rem)" }}
          >
            {formatTime(heat.scheduledStart)}
          </p>
          <p className="text-gray-500 text-base mt-1">
            {formatDate(heat.scheduledStart)}
          </p>
        </div>

        {heat.resNumber && (
          <p className="text-gray-400 text-sm mt-6 font-mono">
            Res #{heat.resNumber}
          </p>
        )}

        <p className="text-gray-400 text-xs mt-10">Tap anywhere to close</p>
      </div>
    </div>
  );
}
