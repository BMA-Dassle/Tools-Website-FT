/**
 * Shared types for the reservation cancellation cascade.
 *
 * A "cascade" is one cancel attempt over a MONEY GROUP: every non-cancelled
 * reservation row sharing the anchor's square_deposit_order_id (combo legs,
 * mixed race+attraction carts) — or sharing its bmi_bill_id when nothing was
 * charged. One deposit charge / one internal gift card can never be settled
 * for half a group, so the group cancels together or not at all.
 */
import type { BowlingReservation } from "@/lib/bowling-db";

export type CancelOutcome = "refund" | "store_credit" | "none";
export type CancelActor = "customer" | "admin";

export interface CancelRequest {
  /** Any row of the money group — the cascade resolves the rest. */
  neonId: number;
  /** Requested settlement. Coerced to 'none' when nothing was charged. */
  outcome: "refund" | "store_credit";
  actor: CancelActor;
  dryRun: boolean;
  /**
   * Customer routes only: allows the refund outcome for plain bowling while
   * NEXT_PUBLIC_BOWLING_CANCEL_CREDIT_ONLY is off (legacy behavior). Admin
   * routes pass true unconditionally.
   */
  allowCustomerRefund?: boolean;
  /** Re-run best-effort teardown of an already-committed cancel. */
  resumeTeardown?: boolean;
}

export type GuardCode =
  | "not_found"
  | "already_cancelled"
  | "within_1_hour"
  | "combo_requires_admin"
  | "refund_requires_admin"
  | "nothing_to_credit"
  | "gift_card_unavailable"
  | "dayof_order_tendered"
  | "amount_mismatch"
  | "db_unavailable";

export class CancelGuardError extends Error {
  constructor(
    public code: GuardCode,
    detail: string,
    public httpStatus: number,
  ) {
    super(detail);
    this.name = "CancelGuardError";
  }
}

export type StepKind =
  | "refund_tender"
  | "issue_store_credit"
  | "drain_internal_gc"
  | "deactivate_internal_gc"
  | "cancel_dayof_order"
  | "delete_qamf"
  | "cancel_bmi_project"
  | "cancel_bmi_addons"
  | "delete_loyalty_reward"
  | "refund_promo_redemption"
  | "mark_cancelled";

export interface PlannedStep {
  kind: StepKind;
  /** Fatal steps abort the cascade; best-effort failures become warnings. */
  fatal: boolean;
  /** Neon row this step belongs to (teardown steps); absent for group-level money steps. */
  legId?: number;
  /** Square/BMI/QAMF object id the step operates on. */
  target: string;
  /** Human-readable line rendered by the admin dry-run preview. */
  detail: string;
  amountCents?: number;
}

/** Live-fetched Square state the plan was built from (re-fetched before mutating). */
export interface GatheredFacts {
  giftCard?: {
    id: string;
    gan: string;
    state: string;
    balanceCents: number;
    /** From the ACTIVATE activity — gift-card activities require a location. */
    locationId?: string;
  };
  depositOrder?: {
    id: string;
    tenders: Array<{ paymentId: string; amountCents: number }>;
  };
  /** Keyed by payment id. */
  payments: Record<
    string,
    { id: string; status: string; amountCents: number; refundedCents: number }
  >;
  /** Keyed by order id — every DISTINCT day-of order across the group. */
  dayofOrders: Record<
    string,
    {
      id: string;
      state: string;
      version: number;
      locationId: string;
      tenderCount: number;
      netDueCents: number;
      totalCents: number;
    }
  >;
}

export interface CancelPlan {
  cascadeId: string;
  attempt: number;
  anchorId: number;
  legIds: number[];
  legs: BowlingReservation[];
  isCombo: boolean;
  outcome: CancelOutcome;
  /** Settlement amount: internal GC balance (funded) or 0 (nothing charged). */
  amountCents: number;
  steps: PlannedStep[];
  facts: GatheredFacts;
  warnings: string[];
  /**
   * Set when a prior attempt already minted the store-credit card (persisted
   * on the money leg). The service reuses it instead of minting again —
   * double-mint protection across attempt bumps.
   */
  existingStoreCredit?: { giftCardId: string; gan: string; cents: number; state: string };
}

export interface CancelLegSummary {
  neonId: number;
  kind: string;
  label: string;
  status: string;
}

export interface CancelResult {
  ok: boolean;
  dryRun: boolean;
  alreadyCancelled?: boolean;
  outcome: CancelOutcome;
  legs: CancelLegSummary[];
  amountCents: number;
  steps: Array<Pick<PlannedStep, "kind" | "detail" | "fatal" | "amountCents">>;
  refundIds?: string[];
  refundCents?: number;
  storeCredit?: { giftCardId: string; gan: string; amountCents: number };
  notified?: { email: boolean; sms: boolean };
  warnings: string[];
}

/** Money shape of a group: funded (deposit → internal GC), zero (nothing charged), broken (charged but no GC — manual). */
export type MoneyClass = "funded" | "zero" | "broken";
