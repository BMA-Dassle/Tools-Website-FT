"use client";

/**
 * The lane / track grid behind the reservations board's Grid view.
 *
 * Its own module rather than another export in `hooks.ts` so the grid's data
 * layer can be read (and linted) on its own — and so a change here cannot
 * disturb the three hooks the list view has depended on since the board was
 * extracted.
 */
import { useEffect, useState } from "react";
import type { ReservationGridData } from "./grid";

export interface ReservationGridState {
  data: ReservationGridData | null;
  loading: boolean;
  error: string | null;
}

interface InternalState extends ReservationGridState {
  /** The date+centre+enabled triple this state describes. */
  scope: string;
}

/**
 * Poll the grid for one centre and one day.
 *
 * `enabled` is the whole point of the hook's shape: this is a VENDOR read, and
 * the board must not poll QAMF for a view nobody is looking at. It fires only
 * once the grid is on screen and stops when the user switches back to the list.
 *
 * 30 s, against the availability sub's 60 s server-side cache: fast enough that
 * a cache expiry is picked up within half a minute, cheap enough that ten open
 * portal tabs still cost one vendor read per centre per minute. The list
 * underneath keeps its own 10 s poll, so whether a bar is CLICKABLE — matched
 * client-side against those rows — stays current between grid reads.
 *
 * A failed silent poll leaves the last good grid on screen rather than blanking
 * it, the same contract `useReservationsData` gives the list.
 */
export function useReservationGridData(
  token: string,
  date: string,
  center: string,
  enabled: boolean,
): ReservationGridState {
  const scope = `${date}|${center}|${enabled ? "on" : "off"}`;
  const [state, setState] = useState<InternalState>(() => ({
    data: null,
    loading: enabled && Boolean(center),
    error: null,
    scope,
  }));

  /**
   * Drop the previous scope's grid DURING RENDER, not in an effect.
   *
   * React's adjust-state-on-change pattern — the same one the board uses for
   * its `?res=` deep link. An effect would paint one frame of the old centre's
   * lanes under the new centre's heading, which on a board staff act from is a
   * frame too many.
   */
  if (state.scope !== scope) {
    setState({ data: null, loading: enabled && Boolean(center), error: null, scope });
  }

  useEffect(() => {
    if (!enabled || !center) return;
    let alive = true;

    /**
     * Nothing is set synchronously before the first `await`: the request goes
     * out, and state only moves once there is an answer. That keeps the effect
     * free of the cascading-render pattern `react-hooks/set-state-in-effect`
     * flags, and it is why `loading` is seeded in `useState` above instead.
     */
    const load = async (silent: boolean) => {
      try {
        const params = new URLSearchParams({ token, date, center });
        const res = await fetch(`/api/admin/bowling/reservations/grid?${params}`, {
          cache: "no-store",
        });
        if (!alive) return;
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error || `HTTP ${res.status}`);
        }
        const json = (await res.json()) as ReservationGridData;
        if (!alive) return;
        setState((prev) => ({ ...prev, data: json, loading: false, error: null }));
      } catch (err) {
        if (!alive) return;
        if (silent) return;
        setState((prev) => ({
          ...prev,
          loading: false,
          error: err instanceof Error ? err.message : "Failed to read the grid",
        }));
      }
    };

    void load(false);
    const id = setInterval(() => void load(true), 30_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [token, date, center, enabled]);

  return { data: state.data, loading: state.loading, error: state.error };
}
