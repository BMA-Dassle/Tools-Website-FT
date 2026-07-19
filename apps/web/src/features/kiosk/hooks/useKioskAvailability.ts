"use client";

/**
 * Kiosk Experience availability, read from the CACHED server endpoint
 * (/api/kiosk/availability). Returns a predicate `available(id)` — true unless
 * the server reports an item can't be booked today.
 *
 * The expensive BMI/QAMF feasibility runs server-side and is Redis-cached, so
 * this poll is cheap no matter how many kiosks run it (they all share the cache
 * — the vendors are hit at most once per TTL per center). Defaults AVAILABLE
 * before/without data and keeps the last value on a fetch error, so a slow or
 * failing poll never false-locks a normally-open experience.
 */
import { useEffect, useState } from "react";
import type { CenterCode } from "~/features/booking";

/** The endpoint is server-cached (~5 min TTL); a light 2-min client poll keeps
 *  the kiosk fresh without adding vendor load. */
const POLL_MS = 2 * 60_000;

export function useKioskAvailability(center: CenterCode | null): (id: string) => boolean {
  const [items, setItems] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!center) return;
    let alive = true;
    const tick = async () => {
      try {
        const res = await fetch(`/api/kiosk/availability?center=${center}`);
        if (!res.ok) return;
        const data = await res.json();
        if (alive && data?.items && typeof data.items === "object") setItems(data.items);
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

  return (id: string) => items[id] ?? true;
}
