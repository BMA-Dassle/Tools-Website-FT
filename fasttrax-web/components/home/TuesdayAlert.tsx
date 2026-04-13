"use client";

import { useEffect, useState } from "react";

/**
 * Shows an alert ONLY on Tuesdays (Mega Track day). First-time junior racers
 * (ages 7–12, no qualifying laps yet) can't race on Mega days because the
 * Mega Track format only has Intermediate+ junior races.
 *
 * Time zone is America/New_York so the alert flips at midnight ET —
 * matches when operations staff and racers consider "Tuesday" to start,
 * not when Vercel's UTC server does.
 */
export default function TuesdayAlert() {
  const [isTuesday, setIsTuesday] = useState(false);

  useEffect(() => {
    // URL override for testing / ops preview: ?mega=1 forces the alert visible.
    if (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("mega") === "1") {
      setIsTuesday(true);
      return;
    }
    // Intl returns a weekday string; "Tue" on Tuesday in ET
    const weekday = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      weekday: "short",
    }).format(new Date());
    setIsTuesday(weekday === "Tue");
  }, []);

  if (!isTuesday) return null;

  return (
    <div
      className="relative rounded-lg border-2 px-4 py-3 max-w-lg animate-pulse"
      style={{
        borderColor: "#8B5CF6", // Mega purple
        background:
          "linear-gradient(135deg, rgba(139,92,246,0.18), rgba(239,68,68,0.14))",
        boxShadow:
          "0 0 18px rgba(139,92,246,0.35), 0 0 4px rgba(239,68,68,0.6)",
      }}
    >
      <div className="flex items-center gap-2 mb-1">
        <span className="text-xs font-bold uppercase tracking-widest text-red-400">
          Alert
        </span>
        <span
          className="font-bold text-sm uppercase tracking-wider"
          style={{ color: "#B794F6" }}
        >
          Mega Track Tuesday
        </span>
      </div>
      <p className="text-white/90 text-sm leading-relaxed">
        Tuesdays we combine our Blue and Red tracks into one epic{" "}
        <strong style={{ color: "#B794F6" }}>Mega Track</strong> — longer,
        faster, wilder.{" "}
        <strong className="text-red-300">
          First-time junior racers (ages 7–12, no qualifying laps yet)
          can&apos;t race on Mega Tuesdays.
        </strong>{" "}
        Adult racers and qualified junior racers are welcome.
      </p>
    </div>
  );
}
