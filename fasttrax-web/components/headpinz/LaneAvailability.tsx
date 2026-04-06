"use client";

import { useState, useEffect } from "react";
import Link from "next/link";

interface LaneStatus {
  name: string;
  remaining: number | string;
  isAvailable: boolean;
}

const CENTER_CODES: Record<string, number> = {
  "fort-myers": 9172,
  naples: 3148,
};

export default function LaneAvailability({ location = "fort-myers" }: { location?: string }) {
  const [lanes, setLanes] = useState<LaneStatus[]>([]);
  const [bookingUrl, setBookingUrl] = useState("");
  const [loading, setLoading] = useState(true);

  const centerCode = CENTER_CODES[location] || 9172;

  useEffect(() => {
    fetchAvailability();
    const interval = setInterval(fetchAvailability, 60000); // Update every 60s
    return () => clearInterval(interval);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [centerCode]);

  async function fetchAvailability() {
    try {
      // Current Eastern time + 15 minutes
      const now = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
      const later = new Date(now.getTime() + 15 * 60000);
      const y = later.getFullYear();
      const m = String(later.getMonth() + 1).padStart(2, "0");
      const d = String(later.getDate()).padStart(2, "0");
      const h = String(later.getHours()).padStart(2, "0");
      const min = String(later.getMinutes()).padStart(2, "0");
      const formattedTime = `${y}-${m}-${d}T${h}:${min}`;

      const res = await fetch(
        `/api/qamf/centers/${centerCode}/offers-availability?systemId=${centerCode}&datetime=${formattedTime}&players=1-6&page=1&itemsPerPage=50`
      );
      const offers = await res.json();

      // Collect best status per lane type (VIP vs Regular), picking the one with availability now
      const bestByType = new Map<string, LaneStatus>();

      for (const offer of offers) {
        if (offer.Name && offer.Name.includes("Time Bowling")) {
          const isVip = offer.Name.includes("VIP");
          const name = isVip ? "VIP Lanes" : "Regular Lanes";
          const firstItem = offer.Items?.[0];
          if (!firstItem) continue;

          let status: LaneStatus;
          if (firstItem.Remaining === 0 && firstItem.Alternatives?.length > 0) {
            const alt = firstItem.Alternatives[0];
            const timeParts = alt.Time.split(":").map(Number);
            const timeStr = new Date(0, 0, 0, timeParts[0], timeParts[1]).toLocaleTimeString("en-US", {
              hour: "numeric",
              minute: "2-digit",
              hour12: true,
            });
            status = { name, remaining: `${alt.Remaining} at ${timeStr.toLowerCase()}`, isAvailable: false };
          } else {
            status = { name, remaining: firstItem.Remaining, isAvailable: firstItem.Remaining > 0 };
          }

          const existing = bestByType.get(name);
          // Prefer the entry that has lanes available now, or the one with more lanes
          if (!existing || (!existing.isAvailable && status.isAvailable) ||
              (existing.isAvailable === status.isAvailable && typeof status.remaining === "number" && typeof existing.remaining === "number" && status.remaining > existing.remaining)) {
            bestByType.set(name, status);
          }
        }
      }

      const results = [...bestByType.values()];

      setLanes(results);
      setBookingUrl(
        location === "naples" ? "/hp/book/bowling?location=naples" : "/hp/book/bowling"
      );
    } catch {
      setLanes([]);
    } finally {
      setLoading(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-white/40 text-sm">
        <div className="w-3 h-3 border-2 border-white/20 border-t-[#fd5b56] rounded-full animate-spin" />
        Checking availability...
      </div>
    );
  }

  if (lanes.length === 0) return null;

  return (
    <div className="space-y-3">
      <p className="text-white/40 text-xs uppercase tracking-widest font-semibold">Live Lane Availability</p>
      <div className="flex flex-col sm:flex-row gap-3">
        {lanes.map((lane) => (
          <div
            key={lane.name}
            className="flex-1 rounded-xl border border-[#123075]/40 bg-white/[0.04] p-4"
          >
            <div className="flex items-center justify-between">
              <div>
                <p className="text-white font-semibold text-sm">{lane.name}</p>
                <div className="flex items-center gap-2 mt-1">
                  <span
                    className={`w-2 h-2 rounded-full ${
                      lane.isAvailable ? "bg-green-400 animate-pulse" : "bg-amber-400"
                    }`}
                  />
                  <span className={`text-sm font-bold ${lane.isAvailable ? "text-green-400" : "text-amber-400"}`}>
                    {typeof lane.remaining === "number"
                      ? `${lane.remaining} Lane${lane.remaining !== 1 ? "s" : ""}`
                      : lane.remaining}
                  </span>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
      {bookingUrl && (
        <Link
          href={bookingUrl}
          className="inline-flex items-center gap-2 bg-[#fd5b56] hover:bg-[#ff7a77] text-white font-bold text-sm uppercase tracking-wider px-6 py-2.5 rounded-full transition-all hover:shadow-[0_0_20px_rgba(253,91,86,0.4)]"
        >
          Book Now
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
          </svg>
        </Link>
      )}
    </div>
  );
}
