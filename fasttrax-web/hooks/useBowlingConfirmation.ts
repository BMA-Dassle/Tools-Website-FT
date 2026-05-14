"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import type { BowlingReservation, BowlingReservationPlayer, ReservationLine } from "@/lib/bowling-db";

// ── Types ──────────────────────────────────────────────────────────────────

export type ReservationWithLines = BowlingReservation & {
  lines: (ReservationLine & { id: number; reservationId: number })[];
};

export type LaneReadyPhase = "idle" | "not_ready" | "ready" | "running";

export type CancelPhase = "idle" | "confirming" | "busy" | "cancelled";

export type RescheduleInfo = {
  webOfferId: number;
  optionId?: number;
  optionType?: string;
  centerId: number;
  playerCount: number;
  daysOfWeek?: number[];
  durationMinutes?: number;
};

export interface UseBowlingConfirmationInput {
  /** Stable 6-char short code — preferred lookup key. */
  shortCode?: string;
  /** Legacy numeric Neon row ID — fallback. */
  neonId?: number;
  /** Auto-open bowler names modal on load. */
  autoOpenNames?: boolean;
}

// Keyed by Square location / center code (stored on BowlingReservation.centerCode)
export const CENTER_NAME: Record<string, string> = {
  TXBSQN0FEKQ11: "HeadPinz Fort Myers",
  PPTR5G2N0QXF7: "HeadPinz Naples",
};
export const CENTER_ADDRESS: Record<string, string> = {
  TXBSQN0FEKQ11: "14513 Global Pkwy, Fort Myers",
  PPTR5G2N0QXF7: "8525 Radio Ln, Naples",
};
export const CENTER_PHONE: Record<string, string> = {
  TXBSQN0FEKQ11: "(239) 302-2155",
  PPTR5G2N0QXF7: "(239) 455-3755",
};

// ── Hook ───────────────────────────────────────────────────────────────────

export function useBowlingConfirmation(input: UseBowlingConfirmationInput) {
  const { shortCode, neonId: inputNeonId, autoOpenNames } = input;

  // Resolved neonId from API (not from URL)
  const [neonId, setNeonId] = useState(0);
  const hasNeonRecord = neonId > 0;

  const [reservation, setReservation] = useState<ReservationWithLines | null>(null);
  const [fetchError, setFetchError] = useState(false);
  const [loading, setLoading] = useState(true);

  // ── Player state ──────────────────────────────────────────────────
  const [players, setPlayers] = useState<BowlingReservationPlayer[]>([]);
  const [shoePairsAllowed, setShoePairsAllowed] = useState(0);
  const [laneNumbers, setLaneNumbers] = useState<number[]>([]);
  const [playersSaving, setPlayersSaving] = useState(false);
  const [playersSaved, setPlayersSaved] = useState(false);
  const [playersError, setPlayersError] = useState<string | null>(null);

  // ── Bowler modal state ────────────────────────────────────────────
  const [bowlerModalOpen, setBowlerModalOpen] = useState(false);

  // ── Lane-ready poll ───────────────────────────────────────────────
  const [laneReadyPhase, setLaneReadyPhase] = useState<LaneReadyPhase>("idle");
  const [laneReadyLabel, setLaneReadyLabel] = useState("");

  // ── Reschedule state ──────────────────────────────────────────────
  const [rescheduleOpen, setRescheduleOpen] = useState(false);
  const [rescheduleInfo, setRescheduleInfo] = useState<RescheduleInfo | null>(null);
  const [rescheduleInfoLoading, setRescheduleInfoLoading] = useState(false);
  const [rescheduleInfoError, setRescheduleInfoError] = useState<string | null>(null);
  const [rescheduleDate, setRescheduleDate] = useState("");
  const [rescheduleSlots, setRescheduleSlots] = useState<{ bookedAt: string }[]>([]);
  const [rescheduleSlotsLoading, setRescheduleSlotsLoading] = useState(false);
  const [rescheduleSelected, setRescheduleSelected] = useState<string | null>(null);
  const [rescheduleSubmitting, setRescheduleSubmitting] = useState(false);
  const [rescheduleError, setRescheduleError] = useState<string | null>(null);
  const [rescheduleSuccess, setRescheduleSuccess] = useState(false);

  // ── Cancel state ──────────────────────────────────────────────────
  const [cancelPhase, setCancelPhase] = useState<CancelPhase>("idle");
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [cancelRefundCents, setCancelRefundCents] = useState(0);

  const isCancelled = cancelPhase === "cancelled" || reservation?.status === "cancelled";

  // Block self-serve cancellation within 1 hour of the reservation start.
  const isWithin1Hour = reservation
    ? new Date(reservation.bookedAt).getTime() - Date.now() < 60 * 60 * 1000
    : false;

  // ── Initial fetch: resolve code → reservation (or legacy neonId) ──
  const fetchStarted = useRef(false);
  useEffect(() => {
    if (fetchStarted.current) return;
    if (!shortCode && !(inputNeonId && inputNeonId > 0)) {
      setLoading(false);
      return;
    }
    fetchStarted.current = true;
    let cancelled = false;
    (async () => {
      try {
        const url = shortCode
          ? `/api/bowling/v2/reservations/by-code/${encodeURIComponent(shortCode)}`
          : `/api/bowling/v2/reservations/${inputNeonId}`;
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) {
          if (!cancelled) setFetchError(true);
          return;
        }
        const json = (await res.json()) as ReservationWithLines;
        if (cancelled) return;
        setReservation(json);
        setNeonId(json.id);
      } catch {
        if (!cancelled) setFetchError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [shortCode, inputNeonId]);

  // ── Fetch player rows after reservation loads ─────────────────────
  useEffect(() => {
    if (!hasNeonRecord || !reservation) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/bowling/v2/reservations/${neonId}/players`, {
          cache: "no-store",
        });
        if (!res.ok || cancelled) return;
        const data = await res.json() as {
          players: BowlingReservationPlayer[];
          shoePairsAllowed: number;
          laneNumbers: number[];
        };
        if (!cancelled) {
          setPlayers(data.players);
          setShoePairsAllowed(data.shoePairsAllowed);
          setLaneNumbers(data.laneNumbers ?? []);
        }
      } catch {
        // Non-fatal — bowler form just won't render
      }
    })();
    return () => { cancelled = true; };
  }, [neonId, reservation, hasNeonRecord]);

  // ── Lane-ready background poll (every 30 s) ──────────────────────
  useEffect(() => {
    if (!hasNeonRecord || isCancelled || laneReadyPhase === "running") return;
    let alive = true;

    async function pollLane() {
      try {
        const res = await fetch(`/api/bowling/v2/reservations/${neonId}/checkin`, {
          cache: "no-store",
        });
        if (!res.ok || !alive) return;
        const data = await res.json() as { phase?: string; laneLabel?: string };
        if (!alive) return;
        const raw = data.phase ?? "";
        if (raw === "ready") {
          setLaneReadyPhase("ready");
          setLaneReadyLabel(data.laneLabel ?? "");
        } else if (raw === "running" || raw === "completed") {
          setLaneReadyPhase("running");
          setLaneReadyLabel(data.laneLabel ?? "");
        } else {
          setLaneReadyPhase("not_ready");
        }
      } catch {
        // Non-fatal — silently skip this tick
      }
    }

    void pollLane();
    const timer = setInterval(() => void pollLane(), 30_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [neonId, hasNeonRecord, isCancelled, laneReadyPhase]);

  // ── Auto-open bowler modal when autoOpenNames is set ──────────────
  useEffect(() => {
    if (autoOpenNames && players.length > 0 && !isCancelled && laneReadyPhase !== "running") {
      setBowlerModalOpen(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoOpenNames, players.length]);

  // ── Player mutations ──────────────────────────────────────────────

  const updatePlayer = useCallback((slot: number, patch: Partial<BowlingReservationPlayer>) => {
    setPlayers((prev) =>
      prev.map((p) => (p.slot === slot ? { ...p, ...patch } : p)),
    );
    setPlayersSaved(false);
  }, []);

  const savePlayers = useCallback(async () => {
    // Require a name for every bowler that has a shoe size selected
    const missingName = players.find(
      (p) => p.shoeSize && (!p.name || p.name.startsWith("Bowler ")),
    );
    if (missingName) {
      setPlayersError(
        `Please enter a name for Bowler ${missingName.slot} — a name is required when a shoe size is selected.`,
      );
      return;
    }
    const shoeSizeCount = players.filter((p) => p.shoeSize).length;
    if (shoeSizeCount > shoePairsAllowed) {
      setPlayersError(
        `You've assigned shoe sizes for ${shoeSizeCount} bowlers but only ${shoePairsAllowed} pair${shoePairsAllowed !== 1 ? "s are" : " is"} included with this booking. Please remove a size first.`,
      );
      return;
    }
    setPlayersSaving(true);
    setPlayersError(null);
    try {
      const res = await fetch(`/api/bowling/v2/reservations/${neonId}/players`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          players: players.map((p) => ({
            slot: p.slot,
            name: p.name,
            shoeSize: p.shoeSize,
            bumpers: p.bumpers,
            laneNumber: p.laneNumber,
          })),
        }),
      });
      const data = await res.json() as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Failed to save");
      setPlayersSaved(true);
      // Auto-close bowler modal after successful save
      setTimeout(() => setBowlerModalOpen(false), 1200);
    } catch (err) {
      setPlayersError(err instanceof Error ? err.message : "Failed to save preferences");
    } finally {
      setPlayersSaving(false);
    }
  }, [players, shoePairsAllowed, neonId]);

  // ── Cancel ────────────────────────────────────────────────────────

  const handleCancel = useCallback(async () => {
    if (!hasNeonRecord) return;
    setCancelPhase("busy");
    setCancelError(null);
    try {
      const res = await fetch(`/api/bowling/v2/reservations/${neonId}/cancel`, { method: "POST" });
      const data = await res.json() as { ok?: boolean; refundCents?: number; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Cancellation failed");
      setCancelRefundCents(data.refundCents ?? 0);
      setCancelPhase("cancelled");
    } catch (err) {
      setCancelError(err instanceof Error ? err.message : "Cancellation failed");
      setCancelPhase("confirming");
    }
  }, [hasNeonRecord, neonId]);

  // ── Reschedule ────────────────────────────────────────────────────

  const openReschedule = useCallback(async () => {
    setRescheduleOpen(true);
    setRescheduleError(null);
    setRescheduleSelected(null);
    setRescheduleSuccess(false);

    // Default to today in ET
    setRescheduleDate(
      new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }),
    );

    // Fetch web offer info if not already loaded
    if (!rescheduleInfo && !rescheduleInfoLoading) {
      setRescheduleInfoLoading(true);
      setRescheduleInfoError(null);
      try {
        const res = await fetch(
          `/api/bowling/v2/reservations/${neonId}/reschedule/info`,
          { cache: "no-store" },
        );
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        setRescheduleInfo(data as RescheduleInfo);
      } catch (err) {
        setRescheduleInfoError(err instanceof Error ? err.message : "Failed to load");
      } finally {
        setRescheduleInfoLoading(false);
      }
    }
  }, [rescheduleInfo, rescheduleInfoLoading, neonId]);

  // Fetch availability when date or info changes
  useEffect(() => {
    if (!rescheduleOpen || !rescheduleInfo || !rescheduleDate) return;
    let alive = true;
    setRescheduleSlotsLoading(true);
    setRescheduleSlots([]);
    setRescheduleSelected(null);
    (async () => {
      try {
        const qs = new URLSearchParams({
          centerId: String(rescheduleInfo.centerId),
          players: String(rescheduleInfo.playerCount),
          startDate: rescheduleDate,
          webOfferId: String(rescheduleInfo.webOfferId),
          ...(rescheduleInfo.durationMinutes
            ? { durationMinutes: String(rescheduleInfo.durationMinutes) }
            : {}),
        });
        const res = await fetch(`/api/bowling/v2/availability?${qs}`, { cache: "no-store" });
        const data = await res.json();
        if (!alive) return;
        if (data.Availabilities) {
          const nowMs = Date.now();
          const todayET = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
          const isToday = rescheduleDate === todayET;
          const matching = (data.Availabilities as Array<{ BookedAt: string; WebOffer: { Id: number } }>)
            .filter((a) => a.WebOffer.Id === rescheduleInfo.webOfferId)
            .filter((a) => !isToday || new Date(a.BookedAt).getTime() > nowMs)
            .map((a) => ({ bookedAt: a.BookedAt }));
          setRescheduleSlots(matching);
        }
      } catch { /* slots stay empty */ }
      finally { if (alive) setRescheduleSlotsLoading(false); }
    })();
    return () => { alive = false; };
  }, [rescheduleOpen, rescheduleInfo, rescheduleDate]);

  const handleReschedule = useCallback(async () => {
    if (!rescheduleSelected || !rescheduleInfo) return;
    setRescheduleSubmitting(true);
    setRescheduleError(null);
    try {
      const res = await fetch(`/api/bowling/v2/reservations/${neonId}/reschedule`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          bookedAt: rescheduleSelected,
          webOfferId: rescheduleInfo.webOfferId,
          optionId: rescheduleInfo.optionId,
          optionType: rescheduleInfo.optionType,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Reschedule failed (${res.status})`);
      setRescheduleSuccess(true);
      // Reload the page to show updated time
      setTimeout(() => window.location.reload(), 1500);
    } catch (err) {
      setRescheduleError(err instanceof Error ? err.message : "Reschedule failed");
    } finally {
      setRescheduleSubmitting(false);
    }
  }, [rescheduleSelected, rescheduleInfo, neonId]);

  // ── Derived values ────────────────────────────────────────────────

  const centerCode = reservation?.centerCode ?? "";
  const centerName = CENTER_NAME[centerCode] ?? "HeadPinz";
  const centerAddress = CENTER_ADDRESS[centerCode] ?? "";
  const centerPhone = CENTER_PHONE[centerCode] ?? "";
  const qamfId = reservation?.qamfReservationId ?? "";

  const displayDepositPaid = reservation?.depositCents ?? 0;
  const displayTotal = reservation?.totalCents ?? 0;
  const hasPaidDeposit = displayDepositPaid > 0;

  const hasRewardsLinked = !!reservation?.squareCustomerId;
  const rewardDiscountCents = reservation?.rewardDiscountCents ?? 0;
  const displayRemaining = displayTotal - displayDepositPaid - rewardDiscountCents;

  const dateLabel = reservation?.bookedAt ? formatBookedAt(reservation.bookedAt) : "";
  const playerCount = reservation?.playerCount;
  const guestName = reservation?.guestName ?? "";
  const lines = reservation?.lines ?? [];

  return {
    // Core data
    reservation,
    neonId,
    hasNeonRecord,
    loading,
    fetchError,

    // Players
    players,
    shoePairsAllowed,
    laneNumbers,
    playersSaving,
    playersSaved,
    playersError,
    bowlerModalOpen,
    setBowlerModalOpen,
    updatePlayer,
    savePlayers,
    setPlayersSaved,

    // Lane ready
    laneReadyPhase,
    laneReadyLabel,

    // Reschedule
    rescheduleOpen,
    setRescheduleOpen,
    rescheduleInfo,
    rescheduleInfoLoading,
    rescheduleInfoError,
    rescheduleDate,
    setRescheduleDate,
    rescheduleSlots,
    rescheduleSlotsLoading,
    rescheduleSelected,
    setRescheduleSelected,
    rescheduleSubmitting,
    rescheduleError,
    rescheduleSuccess,
    openReschedule,
    handleReschedule,

    // Cancel
    cancelPhase,
    setCancelPhase,
    cancelError,
    setCancelError,
    cancelRefundCents,
    isCancelled,
    isWithin1Hour,
    handleCancel,

    // Derived
    centerCode,
    centerName,
    centerAddress,
    centerPhone,
    qamfId,
    displayDepositPaid,
    displayTotal,
    hasPaidDeposit,
    hasRewardsLinked,
    rewardDiscountCents,
    displayRemaining,
    dateLabel,
    playerCount,
    guestName,
    lines,
  };
}

// Re-export types for consumers
export type UseBowlingConfirmationReturn = ReturnType<typeof useBowlingConfirmation>;

// ── Helpers (shared with panels) ───────────────────────────────────────────

export function centsToDollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function formatBookedAt(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    });
  } catch {
    return iso;
  }
}

export function fmtTimeET(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  } catch {
    return iso;
  }
}
