"use client";

/**
 * Data hook for the Edit Reservation modal — debounced server dry-runs plus
 * execute, over POST /api/admin/reservations/edit.
 *
 * Follows the admin board's plain-fetch + useState + alive-ref idiom
 * (useReservationDetail.ts) — the board does NOT use React Query. A request
 * sequence counter discards out-of-order dry-run responses so a slow early
 * quote never clobbers a newer one; superseded calls resolve with
 * {kind:"superseded"} so awaiting callers can bail cleanly.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { EditPlan } from "~/features/reservation-edit/plan";
import type {
  EditPaymentSource,
  EditSettlement,
  EditSpec,
} from "~/features/reservation-edit/types";
import { postEdit, type EditApiError, type EditPostOutcome } from "./editPlanHelpers";

export const DRY_RUN_DEBOUNCE_MS = 500;

export interface RequestPlanOpts {
  settlement?: EditSettlement;
  paymentSource?: EditPaymentSource;
  managerOverride?: boolean;
  /** Skip the debounce — mount probe, execute preflight, stale refresh. */
  immediate?: boolean;
}

export interface ExecuteOpts {
  settlement?: EditSettlement;
  paymentSource?: EditPaymentSource;
  managerOverride?: boolean;
  planHash: string;
  notifyGuest: boolean;
  /** Staff reason for the DAY-OF refund leg (required once the order is paid). */
  dayofRefundReason?: string;
  /** Manager-warning codes staff ticked on the current plan. */
  acknowledgedCodes?: string[];
  /** Initials of whoever ticked them (required when acknowledgedCodes is non-empty). */
  acknowledgedBy?: string;
}

export type RequestPlanResult =
  | { kind: "plan"; plan: EditPlan }
  | { kind: "error"; error: EditApiError }
  | { kind: "superseded" };

export interface UseEditPlan {
  plan: EditPlan | null;
  planError: EditApiError | null;
  planLoading: boolean;
  requestPlan: (spec: EditSpec, opts?: RequestPlanOpts) => Promise<RequestPlanResult>;
  /** Drop the current quote + any in-flight dry-run (form reverted to no changes). */
  clearPlan: () => void;
  execute: (spec: EditSpec, opts: ExecuteOpts) => Promise<EditPostOutcome>;
}

export function useEditPlan(neonId: number, token: string): UseEditPlan {
  const [plan, setPlan] = useState<EditPlan | null>(null);
  const [planError, setPlanError] = useState<EditApiError | null>(null);
  const [planLoading, setPlanLoading] = useState(false);
  const alive = useRef(true);
  const seq = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingResolve = useRef<((r: RequestPlanResult) => void) | null>(null);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
      pendingResolve.current?.({ kind: "superseded" });
      pendingResolve.current = null;
    };
  }, []);

  const supersede = useCallback(() => {
    seq.current += 1;
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    pendingResolve.current?.({ kind: "superseded" });
    pendingResolve.current = null;
  }, []);

  const requestPlan = useCallback(
    (spec: EditSpec, opts: RequestPlanOpts = {}): Promise<RequestPlanResult> => {
      supersede();
      const mySeq = seq.current;
      setPlanLoading(true);
      return new Promise<RequestPlanResult>((resolve) => {
        pendingResolve.current = resolve;
        const settle = (r: RequestPlanResult) => {
          if (pendingResolve.current === resolve) pendingResolve.current = null;
          resolve(r);
        };
        const run = async () => {
          const outcome = await postEdit(token, {
            neonId,
            spec,
            dryRun: true,
            ...(opts.settlement ? { settlement: opts.settlement } : {}),
            ...(opts.paymentSource ? { paymentSource: opts.paymentSource } : {}),
            ...(opts.managerOverride ? { managerOverride: true } : {}),
          });
          if (!alive.current || mySeq !== seq.current) {
            settle({ kind: "superseded" });
            return;
          }
          setPlanLoading(false);
          if (outcome.kind === "plan") {
            setPlan(outcome.plan);
            setPlanError(null);
            settle({ kind: "plan", plan: outcome.plan });
          } else if (outcome.kind === "error") {
            setPlan(null);
            setPlanError(outcome.error);
            settle({ kind: "error", error: outcome.error });
          } else {
            // dryRun:true never yields a "result" — defensive.
            settle({ kind: "superseded" });
          }
        };
        if (opts.immediate) {
          void run();
        } else {
          timer.current = setTimeout(() => {
            timer.current = null;
            void run();
          }, DRY_RUN_DEBOUNCE_MS);
        }
      });
    },
    [neonId, token, supersede],
  );

  const clearPlan = useCallback(() => {
    supersede();
    setPlan(null);
    setPlanError(null);
    setPlanLoading(false);
  }, [supersede]);

  const execute = useCallback(
    async (spec: EditSpec, opts: ExecuteOpts): Promise<EditPostOutcome> => {
      supersede(); // no dry-run response may land once an execute starts
      setPlanLoading(false);
      return postEdit(token, {
        neonId,
        spec,
        dryRun: false,
        planHash: opts.planHash,
        notifyGuest: opts.notifyGuest,
        ...(opts.settlement ? { settlement: opts.settlement } : {}),
        ...(opts.paymentSource ? { paymentSource: opts.paymentSource } : {}),
        ...(opts.managerOverride ? { managerOverride: true } : {}),
        ...(opts.dayofRefundReason ? { dayofRefundReason: opts.dayofRefundReason } : {}),
        ...(opts.acknowledgedCodes ? { acknowledgedCodes: opts.acknowledgedCodes } : {}),
        ...(opts.acknowledgedBy ? { acknowledgedBy: opts.acknowledgedBy } : {}),
      });
    },
    [neonId, token, supersede],
  );

  return { plan, planError, planLoading, requestPlan, clearPlan, execute };
}
