/**
 * Pure logic for the Edit Reservation modal — the dry-run/execute HTTP
 * wrapper, mount/execute outcome classification, EditSpec assembly from the
 * form state, diff-table pairing, and execute gating.
 *
 * Framework-free ON PURPOSE: the repo's vitest environment is node (no
 * jsdom / testing-library), so everything behavioral the modal does lives
 * here where it can be unit-tested. The modal and useEditPlan are thin
 * React shells over these functions.
 *
 * All ids that transit here (bmiLineId, cardId, order ids) are STRINGS end
 * to end — our own route serializes them as JSON strings, so res.json() is
 * safe (the raw-id parsing rule applies to upstream BMI/Pandora responses,
 * which never reach this client).
 */
import type { EditCurrentState, EditPlan, PlanLine } from "~/features/reservation-edit/plan";
import type {
  EditPaymentSource,
  EditSettlement,
  EditSpec,
  EditWarning,
} from "~/features/reservation-edit/types";
import type { EditResult } from "~/features/reservation-edit/service";
import { dollars, ganDisplay } from "~/features/reservations-admin/format";

/* ── HTTP wrapper ─────────────────────────────────────────────────────── */

export interface EditApiError {
  /** HTTP status; 0 = network/parse failure before a response landed. */
  status: number;
  /** Route error code ("cancelled", "no_changes", "plan_stale", …). */
  code: string;
  detail: string | null;
  /**
   * Structured payload some codes carry. `no_changes` — the healthy mount-probe
   * answer — ships `current` so the form hydrates on open; without it a settled
   * reservation shows no day-of order lines and the refund control never
   * appears.
   */
  data?: { current?: EditCurrentState } | null;
}

export type EditPostOutcome =
  | { kind: "plan"; plan: EditPlan }
  | { kind: "result"; result: EditResult }
  | { kind: "error"; error: EditApiError };

export interface EditPostBody {
  neonId: number;
  spec: EditSpec;
  settlement?: EditSettlement;
  paymentSource?: EditPaymentSource;
  dryRun: boolean;
  planHash?: string;
  notifyGuest?: boolean;
  managerOverride?: boolean;
  /** Staff reason for the DAY-OF refund leg (required once the order is paid). */
  dayofRefundReason?: string;
}

/** POST /api/admin/reservations/edit — dry-run returns {plan}, execute returns EditResult. */
export const postEdit = async (token: string, body: EditPostBody): Promise<EditPostOutcome> => {
  let res: Response;
  try {
    res = await fetch(`/api/admin/reservations/edit?token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return {
      kind: "error",
      error: {
        status: 0,
        code: "network",
        detail: err instanceof Error ? err.message : "network error",
      },
    };
  }
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    /* non-JSON body — fall through with the status */
  }
  if (!res.ok) {
    return {
      kind: "error",
      error: {
        status: res.status,
        code: typeof json.error === "string" ? json.error : `http_${res.status}`,
        detail: typeof json.detail === "string" ? json.detail : null,
        data: (json.data as EditApiError["data"]) ?? null,
      },
    };
  }
  if (body.dryRun) {
    const plan = (json as { plan?: EditPlan }).plan;
    if (!plan) {
      return {
        kind: "error",
        error: { status: res.status, code: "bad_response", detail: "dry-run returned no plan" },
      };
    }
    return { kind: "plan", plan };
  }
  return { kind: "result", result: json as unknown as EditResult };
};

/* ── Mount-probe classification ───────────────────────────────────────── */

export type MountOutcome =
  | { kind: "edit" }
  | { kind: "ack_required" }
  | { kind: "blocked"; message: string }
  | { kind: "error"; message: string };

/**
 * The modal opens with a dry-run on an EMPTY spec. The engine throws
 * no_changes BEFORE returning a plan, so that error is the EXPECTED healthy
 * answer ("editable, nothing changed yet" — the form initializes from the
 * board row instead). post_complete_ack_required means editable only after
 * the manager acknowledges the no-QAMF/BMI warning. Everything else with an
 * HTTP status is a real gate (cancelled / phase_conflict / combo_phase_split
 * / …) → blocked; status 0 is transport failure → retryable error.
 */
export const classifyMountOutcome = (
  outcome: { kind: "plan"; plan: EditPlan } | { kind: "error"; error: EditApiError },
): MountOutcome => {
  if (outcome.kind === "plan") return { kind: "edit" };
  const { error } = outcome;
  if (error.code === "no_changes") return { kind: "edit" };
  if (error.code === "post_complete_ack_required") return { kind: "ack_required" };
  if (error.status === 0) {
    return { kind: "error", message: error.detail ?? "Could not reach the edit service" };
  }
  return { kind: "blocked", message: error.detail || error.code };
};

/* ── Execute-failure classification ───────────────────────────────────── */

export type ExecuteFailureAction =
  | { kind: "refresh_plan" }
  | { kind: "blocked"; message: string }
  | { kind: "error"; message: string; offerPaymentLink: boolean };

export const classifyExecuteFailure = (
  error: EditApiError,
  diffCents: number,
): ExecuteFailureAction => {
  if (error.code === "plan_stale") return { kind: "refresh_plan" };
  if (error.code === "not_enabled") {
    return {
      kind: "blocked",
      message: "Reservation editing is not enabled in this environment.",
    };
  }
  // Phase flag off. NOT an acknowledgment problem — nothing the operator can
  // tick unlocks it, so say so plainly instead of re-offering the checkbox.
  if (error.code === "refund_not_enabled") {
    return {
      kind: "blocked",
      message:
        error.detail ||
        "Refunding a reservation this far along is not enabled in this environment yet.",
    };
  }
  if (error.code === "payment_required") {
    return {
      kind: "error",
      message: error.detail || "The card on file was declined.",
      offerPaymentLink: diffCents > 0,
    };
  }
  if (error.status === 409 || error.status === 404) {
    return { kind: "blocked", message: error.detail || error.code };
  }
  // edit_failed 502 and anything unexpected — retryable; increases can fall
  // back to a payment link (the guest pays on our self-hosted page).
  return {
    kind: "error",
    message: error.detail || error.code,
    offerPaymentLink: diffCents > 0,
  };
};

/* ── Form state → EditSpec ────────────────────────────────────────────── */

export interface AddRacerRow {
  firstName: string;
  category: "adult" | "junior";
  isNew: boolean;
}

export interface PlayerOverride {
  name?: string;
  shoeSize?: string;
  bumpers?: boolean;
}

/**
 * Sparse form state: null / empty = "unchanged". The spec sent to the server
 * is always the desired END STATE (engine contract), assembled by merging
 * these overrides over the last plan's `current` block.
 */
export interface EditFormState {
  playerCount: number | null;
  laneCount: number | null;
  /** Hourly rentals: selected bowling_experience_duration_options.id. */
  durationOptionId: number | null;
  /** Desired qty overrides keyed by bowling_square_products.id. */
  shoes: Record<number, number> | null;
  /** Roster field overrides keyed by 1-based slot. */
  players: Record<number, PlayerOverride>;
  playersTouched: boolean;
  removeHeatIndexes: number[];
  addRacers: AddRacerRow[];
  /** Attraction add-on qty overrides keyed by attraction_bookings index. */
  attractions: Record<number, number> | null;
  /**
   * Desired quantities for non-engine day-of order lines (food, POS add-ons),
   * keyed by live Square line uid. 0 removes the line.
   */
  orderLines: Record<string, number> | null;
}

export const emptyForm = (): EditFormState => ({
  playerCount: null,
  laneCount: null,
  durationOptionId: null,
  shoes: null,
  players: {},
  playersTouched: false,
  removeHeatIndexes: [],
  addRacers: [],
  attractions: null,
  orderLines: null,
});

/**
 * Assemble the desired-end-state EditSpec. Only touched sections are
 * included — an omitted field means "unchanged" to the engine, which is what
 * keeps the empty form producing an empty spec (client-side no_changes).
 */
export const buildSpec = (
  form: EditFormState,
  basePlayerCount: number,
  current: EditCurrentState | null,
): EditSpec => {
  const spec: EditSpec = {};

  if (form.playerCount != null && form.playerCount !== basePlayerCount) {
    spec.playerCount = form.playerCount;
  }
  if (form.laneCount != null && form.laneCount !== (current?.laneCount ?? form.laneCount)) {
    spec.laneCount = form.laneCount;
  }
  if (form.durationOptionId != null && current) {
    // Only send a REAL change — the picked option's multiplier differing from
    // the booked one is what identifies "changed" (the current option has no
    // stored id, only its multiplier).
    const picked = current.durationOptions.find((d) => d.id === form.durationOptionId);
    if (picked && picked.multiplier !== (current.durationMultiplier ?? picked.multiplier)) {
      spec.durationOptionId = form.durationOptionId;
    }
  }

  if (form.attractions && current) {
    const changes = Object.entries(form.attractions)
      .map(([k, qty]) => ({ index: Number(k), quantity: qty }))
      .filter((c) => {
        const cur = current.attractions.find((a) => a.index === c.index);
        return cur != null && cur.editable && c.quantity !== cur.quantity;
      });
    if (changes.length > 0) spec.attractions = changes;
  }

  if (form.orderLines && current) {
    // Only send lines that actually moved, and only ones the server marked
    // editable — a non-editable line would be a typed refusal at plan time.
    const changed: Record<string, number> = {};
    for (const [uid, qty] of Object.entries(form.orderLines)) {
      const cur = current.orderLines.find((l) => l.uid === uid);
      if (cur?.editable && qty !== cur.quantity) changed[uid] = qty;
    }
    if (Object.keys(changed).length > 0) spec.orderLines = changed;
  }

  if (form.shoes && current) {
    const currentQty = new Map(current.shoes.map((s) => [s.squareProductId, s.quantity]));
    const ids = new Set<number>([
      ...currentQty.keys(),
      ...Object.keys(form.shoes).map((k) => Number(k)),
    ]);
    const desired: Record<number, number> = {};
    let changed = false;
    for (const id of ids) {
      const qty = form.shoes[id] ?? currentQty.get(id) ?? 0;
      const cur = currentQty.get(id) ?? 0;
      // Keep 0-quantity entries only when they express a removal.
      if (qty > 0 || cur > 0) desired[id] = qty;
      if (qty !== cur) changed = true;
    }
    if (changed) spec.shoes = desired;
  }

  if (form.playersTouched) {
    const count = form.playerCount ?? basePlayerCount;
    const currentBySlot = new Map((current?.players ?? []).map((p) => [p.slot, p]));
    spec.players = Array.from({ length: count }, (_, i) => {
      const slot = i + 1;
      const cur = currentBySlot.get(slot);
      const ov = form.players[slot] ?? {};
      return {
        slot,
        name: (ov.name ?? cur?.name ?? "").trim() || null,
        shoeSize: (ov.shoeSize ?? cur?.shoeSize ?? "").trim() || null,
        bumpers: ov.bumpers ?? cur?.bumpers ?? null,
      };
    });
  }

  const add = form.addRacers
    .filter((r) => r.firstName.trim().length > 0)
    .map((r) => ({ firstName: r.firstName.trim(), category: r.category, isNew: r.isNew }));
  const remove = [...form.removeHeatIndexes].sort((a, b) => a - b);
  if (add.length > 0 || remove.length > 0) {
    spec.racers = {
      ...(add.length > 0 ? { add } : {}),
      ...(remove.length > 0 ? { removeHeatIndexes: remove } : {}),
    };
  }

  return spec;
};

export const isEmptySpec = (spec: EditSpec): boolean => Object.keys(spec).length === 0;

/* ── Diff-table pairing ───────────────────────────────────────────────── */

export interface DiffRow {
  name: string;
  oldQty: number | null;
  oldTotalCents: number | null;
  newQty: number | null;
  newTotalCents: number | null;
  changed: boolean;
}

/**
 * Pair old and new order lines for the old→new table: by uid first (carried
 * lines keep their uid), then catalog id, then name. Unmatched old lines are
 * removals; unclaimed new lines are additions. All money is server-computed
 * PlanLine cents — nothing is multiplied here.
 */
export const buildDiffRows = (oldLines: PlanLine[], newLines: PlanLine[]): DiffRow[] => {
  const unclaimed = [...newLines];
  const take = (o: PlanLine): PlanLine | null => {
    let idx = o.uid ? unclaimed.findIndex((n) => n.uid === o.uid) : -1;
    if (idx < 0 && o.catalogObjectId) {
      idx = unclaimed.findIndex((n) => n.catalogObjectId === o.catalogObjectId);
    }
    if (idx < 0) idx = unclaimed.findIndex((n) => n.name === o.name);
    if (idx < 0) return null;
    return unclaimed.splice(idx, 1)[0];
  };
  const rows: DiffRow[] = oldLines.map((o) => {
    const n = take(o);
    return {
      name: o.name,
      oldQty: o.quantity,
      oldTotalCents: o.totalCents,
      newQty: n ? n.quantity : null,
      newTotalCents: n ? n.totalCents : null,
      changed: n == null || n.quantity !== o.quantity || n.totalCents !== o.totalCents,
    };
  });
  for (const n of unclaimed) {
    rows.push({
      name: n.name,
      oldQty: null,
      oldTotalCents: null,
      newQty: n.quantity,
      newTotalCents: n.totalCents,
      changed: true,
    });
  }
  return rows;
};

/* ── Execute gating ───────────────────────────────────────────────────── */

export type ExecuteMode = "charge_card" | "payment_link" | "refund" | "confirm";

export interface ExecuteGate {
  enabled: boolean;
  reason: string | null;
  mode: ExecuteMode;
}

const modeOf = (plan: EditPlan): ExecuteMode =>
  plan.diffCents > 0
    ? plan.chargeCard
      ? "charge_card"
      : "payment_link"
    : plan.diffCents < 0
      ? "refund"
      : "confirm";

/**
 * Whether Execute may fire and which action it performs:
 *   - manager warnings require the explicit acknowledgment checkbox;
 *   - decreases require a refund destination (CancelModal's pickRow rule);
 *   - increases charge the card on file, or fall to the payment-link CTA.
 */
export const executeGate = (args: {
  plan: EditPlan | null;
  planLoading: boolean;
  refundDest: EditSettlement | null;
  needsManagerAck: boolean;
  managerAcked: boolean;
  /** Text entered for the day-of refund leg, when the plan has one. */
  dayofRefundReason?: string;
}): ExecuteGate => {
  const { plan } = args;
  if (!plan || args.planLoading) return { enabled: false, reason: null, mode: "confirm" };
  const mode = modeOf(plan);
  // Environment refusal, not an operator mistake — surface it first so nobody
  // fills the rest of the form out before learning the button can't fire.
  if (plan.executionBlocked) {
    return { enabled: false, reason: plan.executionBlocked.message, mode };
  }
  if (args.needsManagerAck && !args.managerAcked) {
    return { enabled: false, reason: "Acknowledge the QAMF/BMI warning first", mode };
  }
  if (plan.diffCents < 0 && !args.refundDest) {
    return { enabled: false, reason: "Pick where the refund goes", mode };
  }
  // The server refuses a day-of refund without a staff reason — catch it here
  // rather than letting the operator hit a 400 after picking everything else.
  const needsDayofReason = plan.steps.some(
    (s) => s.kind === "refund_dayof_payment" || s.kind === "refund_dayof_order",
  );
  if (needsDayofReason && !(args.dayofRefundReason ?? "").trim()) {
    return { enabled: false, reason: "Add a reason for the refund", mode };
  }
  return { enabled: true, reason: null, mode };
};

export const planNeedsManagerAck = (plan: EditPlan | null): boolean =>
  (plan?.warnings ?? []).some((w) => w.severity === "manager");

/* ── Display helpers ──────────────────────────────────────────────────── */

export const WARNING_COLORS: Record<EditWarning["severity"], string> = {
  info: "var(--ba-muted)",
  warning: "#f59e0b",
  manager: "#ef4444",
};

/** Toast line for onDone — mirrors CancelModal's finish() wording. */
export const resultSummary = (guest: string, result: EditResult): string => {
  if (result.state === "pending_payment") {
    return `${guest}: edit pending payment — link created (${result.editId})`;
  }
  if (result.diffCents > 0) {
    return `${guest}: reservation updated — ${dollars(result.diffCents)} charged`;
  }
  if (result.diffCents < 0) {
    return result.storeCreditGan
      ? `${guest}: reservation updated — ${dollars(-result.diffCents)} gift card ${ganDisplay(result.storeCreditGan)}`
      : `${guest}: reservation updated — ${dollars(-result.diffCents)} refunded`;
  }
  return `${guest}: reservation updated`;
};
