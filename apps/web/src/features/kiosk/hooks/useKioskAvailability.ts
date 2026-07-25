"use client";

/**
 * Kiosk Experience availability, read from the CACHED server endpoint
 * (/api/kiosk/availability). Returns `available(id)` — true unless the server
 * reports an item can't be booked today — plus `firstOpenFor(id)`, the soonest
 * bookable slot for that tile's "3 lanes · 9:30 PM" line (undefined when the
 * server has no count, e.g. bowling/KBF or a vendor blip).
 *
 * The expensive BMI/QAMF feasibility runs server-side and is Redis-cached, so
 * this poll is cheap no matter how many kiosks run it (they all share the cache
 * — the vendors are hit at most once per TTL per center). Defaults AVAILABLE
 * before/without data and keeps the last value on a fetch error, so a slow or
 * failing poll never false-locks a normally-open experience.
 */
import { useEffect, useState } from "react";
import type { CenterCode } from "~/features/booking";
import type { FirstOpen } from "../service/first-available";

/** The endpoint is server-cached (~5 min TTL); a light 2-min client poll keeps
 *  the kiosk fresh without adding vendor load. */
const POLL_MS = 2 * 60_000;

export interface KioskAvailability {
  /** True unless the server reports the item can't be booked today. */
  available: (id: string) => boolean;
  /** The soonest bookable slot for the tile's availability line, or undefined
   *  when the server carries no count for it. */
  firstOpenFor: (id: string) => FirstOpen | undefined;
}

export function useKioskAvailability(center: CenterCode | null): KioskAvailability {
  const [items, setItems] = useState<Record<string, boolean>>({});
  const [firstOpen, setFirstOpen] = useState<Record<string, FirstOpen>>({});

  useEffect(() => {
    if (!center) return;
    let alive = true;
    const tick = async () => {
      try {
        const res = await fetch(`/api/kiosk/availability?center=${center}`);
        if (!res.ok) return;
        const data = await res.json();
        if (!alive) return;
        if (data?.items && typeof data.items === "object") setItems(data.items);
        // firstOpen is optional — a payload without it just leaves lines off.
        if (data?.firstOpen && typeof data.firstOpen === "object") setFirstOpen(data.firstOpen);
      } catch {
        /* keep last known value — never false-lock on a fetch blip */
      }
    };
    void tick();
    const t = setInterval(() => void tick(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [center]);

  return {
    available: (id: string) => items[id] ?? true,
    firstOpenFor: (id: string) => firstOpen[id],
  };
}
