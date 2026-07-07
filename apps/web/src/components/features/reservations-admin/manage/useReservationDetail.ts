"use client";

/**
 * Data hook for the Manage Reservation modal.
 *
 * Seeds nothing visual — the modal paints instantly from the board's
 * Reservation snapshot while this fetches the authoritative detail
 * (money group + merged history) from /api/admin/reservations/detail.
 * The payment timeline is a separate lazy fetch triggered by the
 * Payments tab (loadPayments), matching the page's plain-fetch pattern.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { PaymentTimeline, ReservationDetail } from "~/features/reservations-admin/service";

export interface UseReservationDetail {
  detail: ReservationDetail | null;
  detailError: string | null;
  detailLoading: boolean;
  refetch: () => Promise<void>;
  payments: PaymentTimeline | null;
  paymentsError: string | null;
  paymentsLoading: boolean;
  /** Idempotent — first call fetches, later calls refresh. */
  loadPayments: () => Promise<void>;
}

export function useReservationDetail(neonId: number, token: string): UseReservationDetail {
  const [detail, setDetail] = useState<ReservationDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(true);
  const [payments, setPayments] = useState<PaymentTimeline | null>(null);
  const [paymentsError, setPaymentsError] = useState<string | null>(null);
  const [paymentsLoading, setPaymentsLoading] = useState(false);
  const alive = useRef(true);

  const refetch = useCallback(async () => {
    try {
      const qs = new URLSearchParams({ token, id: String(neonId) });
      const res = await fetch(`/api/admin/reservations/detail?${qs}`, { cache: "no-store" });
      const data = await res.json();
      if (!alive.current) return;
      if (!res.ok) {
        setDetailError(data.error || `HTTP ${res.status}`);
      } else {
        setDetail(data as ReservationDetail);
        setDetailError(null);
      }
    } catch (err) {
      if (alive.current) setDetailError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      if (alive.current) setDetailLoading(false);
    }
  }, [neonId, token]);

  const loadPayments = useCallback(async () => {
    setPaymentsLoading(true);
    try {
      const qs = new URLSearchParams({ token, id: String(neonId) });
      const res = await fetch(`/api/admin/reservations/detail/payments?${qs}`, {
        cache: "no-store",
      });
      const data = await res.json();
      if (!alive.current) return;
      if (!res.ok) {
        setPaymentsError(data.error || `HTTP ${res.status}`);
      } else {
        setPayments(data as PaymentTimeline);
        setPaymentsError(null);
      }
    } catch (err) {
      if (alive.current)
        setPaymentsError(err instanceof Error ? err.message : "Failed to load payments");
    } finally {
      if (alive.current) setPaymentsLoading(false);
    }
  }, [neonId, token]);

  useEffect(() => {
    alive.current = true;
    setDetail(null);
    setDetailLoading(true);
    setDetailError(null);
    setPayments(null);
    setPaymentsError(null);
    void refetch();
    return () => {
      alive.current = false;
    };
  }, [refetch]);

  return {
    detail,
    detailError,
    detailLoading,
    refetch,
    payments,
    paymentsError,
    paymentsLoading,
    loadPayments,
  };
}
