"use client";

/**
 * Client hooks for the admin reservations board.
 * Extracted verbatim from app/admin/[token]/reservations/ReservationsClient.tsx.
 */
import { useCallback, useEffect, useState } from "react";
import type { ComboMeta, GroupEvent, Reservation, VipVoucherSummary } from "./types";

/**
 * Theme: "dark" (default) or "light" — set via URL ?theme= at load, then
 * kept live by the portal via postMessage, either shape:
 *   { type: "portal.theme", value: "light" | "dark" }        (legacy sync)
 *   { type: "<tool>-control", theme: "light" | "dark", ... } (2026-07-14)
 * The lazy initializer avoids a dark flash on ?theme=light, and the mount
 * effect re-reads the param — the initializer alone didn't reliably
 * survive App Router hydration (?theme=light boards stayed dark).
 */
export function useBoardTheme(): "dark" | "light" {
  // Hydration-safe: dark on BOTH server and client first render, URL param
  // applied post-mount as a real state change. The old lazy window-reading
  // initializer made client state "light" while the server HTML said dark —
  // React logs "won't be patched up" and keeps the dark attribute forever,
  // because the later URL re-read was a state no-op (2026-07-14).
  const [theme, setTheme] = useState<"dark" | "light">("dark");

  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (p.get("theme") === "light") setTheme("light");
  }, []);

  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.origin !== "https://portal.headpinz.com") return;
      if (
        e.data?.type === "portal.theme" &&
        (e.data.value === "dark" || e.data.value === "light")
      ) {
        setTheme(e.data.value);
      }
      if (
        typeof e.data?.type === "string" &&
        e.data.type.endsWith("-control") &&
        (e.data.theme === "dark" || e.data.theme === "light")
      ) {
        setTheme(e.data.theme);
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  return theme;
}

/**
 * Liveness tick: the team watches this board to see where VIPs are, so the
 * countdown pills must keep moving even when a silent refresh fails or the
 * tab is throttled. The 10s data poll drives re-renders on success; this is
 * the clock's fallback heartbeat.
 */
export function useNowTick(intervalMs = 30_000): void {
  const [, setNowTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setNowTick((t) => t + 1), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
}

export interface ReservationsData {
  reservations: Reservation[];
  groupEvents: GroupEvent[];
  vipReservations: Reservation[];
  comboMeta: Record<string, ComboMeta>;
  /** Booking-minted V2 voucher per BMI billId — code + QR + per-item state. */
  vipVouchers: Record<string, VipVoucherSummary>;
  loading: boolean;
  error: string | null;
  reload: (opts?: { silent?: boolean }) => Promise<void>;
}

/**
 * Board data: initial load + silent 10s auto-refresh. Silent refreshes
 * deliberately do NOT clear data or surface errors — cards update inline
 * without flash, and a failed poll leaves the last good board on screen.
 */
export function useReservationsData(token: string, date: string, center: string): ReservationsData {
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [groupEvents, setGroupEvents] = useState<GroupEvent[]>([]);
  // VIP combos for the date, fetched UNSCOPED of center (a combo spans FastTrax
  // racing + HeadPinz bowling) so they surface in every location's portal view.
  const [vipReservations, setVipReservations] = useState<Reservation[]>([]);
  const [comboMeta, setComboMeta] = useState<Record<string, ComboMeta>>({});
  const [vipVouchers, setVipVouchers] = useState<Record<string, VipVoucherSummary>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (opts?: { silent?: boolean }) => {
      const silent = opts?.silent ?? false;
      if (!silent) {
        setLoading(true);
        setError(null);
      }
      try {
        const params = new URLSearchParams({
          token,
          date,
          ...(center ? { center } : {}),
        });
        const res = await fetch(`/api/admin/bowling/reservations?${params}`, {
          cache: "no-store",
        });
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || `HTTP ${res.status}`);
        }
        const data = await res.json();
        setReservations(data.reservations ?? []);
        setGroupEvents(data.groupEvents ?? []);
        setVipReservations(data.vipReservations ?? []);
        setComboMeta(data.comboMeta ?? {});
        setVipVouchers(data.vipVouchers ?? {});
        setError(null);
      } catch (err) {
        if (!silent) {
          setError(err instanceof Error ? err.message : "Failed to load");
          setReservations([]);
          setGroupEvents([]);
          setVipReservations([]);
          setComboMeta({});
          setVipVouchers({});
        }
      } finally {
        setLoading(false);
      }
    },
    [token, date, center],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // Auto-refresh every 10s — silent so cards update inline without flash
  useEffect(() => {
    const id = setInterval(() => {
      void load({ silent: true });
    }, 10_000);
    return () => clearInterval(id);
  }, [load]);

  return {
    reservations,
    groupEvents,
    vipReservations,
    comboMeta,
    vipVouchers,
    loading,
    error,
    reload: load,
  };
}
