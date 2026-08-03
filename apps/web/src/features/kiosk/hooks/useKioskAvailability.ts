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

/** The endpoint is server-cached (~3 min TTL); a light 1-min client poll keeps
 *  the tiles fresh without adding vendor load — the poll only reads the cache,
 *  so the vendors are still hit at most once per TTL per center. Callers on a
 *  low-urgency surface (the idle attract loop) pass a longer interval so they
 *  don't keep the cache — and therefore the vendor recompute — warm 24/7 when
 *  no guest is present. */
const DEFAULT_POLL_MS = 60_000;
export const ATTRACT_POLL_MS = 5 * 60_000;

export interface KioskAvailability {
  /** True unless the server reports the item can't be booked today. */
  available: (id: string) => boolean;
  /** The soonest bookable slot for the tile's availability line, or undefined
   *  when the server carries no count for it. */
  firstOpenFor: (id: string) => FirstOpen | undefined;
  /** The item is off sale because its VENDOR is down (maintenance mode), not
   *  because the day ran out. Both lock the tile; only this one sends the guest
   *  to Guest Services instead of the front desk for a walk-in. Defaults false —
   *  a payload from before the outage field existed reads as "no outage". */
  vendorPaused: (id: string) => boolean;
}

export interface UseKioskAvailabilityOptions {
  /** Poll interval in ms. Defaults to 60s; the attract loop passes
   *  {@link ATTRACT_POLL_MS} so an idle kiosk doesn't keep the vendor recompute
   *  warm around the clock. */
  pollMs?: number;
}

export function useKioskAvailability(
  center: CenterCode | null,
  options?: UseKioskAvailabilityOptions,
): KioskAvailability {
  const [items, setItems] = useState<Record<string, boolean>>({});
  const [firstOpen, setFirstOpen] = useState<Record<string, FirstOpen>>({});
  const [paused, setPaused] = useState<string[]>([]);
  const pollMs = options?.pollMs ?? DEFAULT_POLL_MS;

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
        // Vendor outages. Always assigned (not `if (length)`) so a RECOVERY —
        // the server dropping back to an empty list — unlocks the tiles instead
        // of leaving the outage note up until the kiosk is reloaded.
        setPaused(Array.isArray(data?.paused) ? (data.paused as string[]) : []);
      } catch {
        /* keep last known value — never false-lock on a fetch blip */
      }
    };
    void tick();
    const t = setInterval(() => void tick(), pollMs);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [center, pollMs]);

  return {
    available: (id: string) => items[id] ?? true,
    firstOpenFor: (id: string) => firstOpen[id],
    vendorPaused: (id: string) => paused.includes(id),
  };
}
