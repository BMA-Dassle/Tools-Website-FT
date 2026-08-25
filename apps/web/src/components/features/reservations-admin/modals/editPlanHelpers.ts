/**
 * Pure logic for the Edit Reservation modal — the dry-run/execute HTTP
 * wrapper, mount/execute outcome classification, staff-facing error copy,
 * EditSpec assembly from the form state, diff-table pairing, execute gating
 * (per-warning acknowledgments + initials), and success-screen derivations.
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
  EditCapabilities,
  EditGuardCode,
  EditPaymentSource,
  EditSettlement,
  EditSpec,
  EditWarning,
  ManualStep,
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
   * answer — ships `current` so the form hydrates on open (without it a settled
   * reservation shows no day-of order lines and the refund control never
   * appears) plus `capabilities` (which kill switches are thrown). `ack_required`
   * ships `missing` — the manager codes staff did not acknowledge.
   */
  data?: {
    current?: EditCurrentState;
    capabilities?: EditCapabilities;
    missing?: string[];
  } | null;
  /** Execute failures: the ledger row the attempt wrote (for support). */
  editId?: string | null;
  /** Execute failures: the step that was running when it failed. */
  failedStep?: string | null;
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
  /** Legacy post-complete acknowledgment — still sent for back-compat. */
  managerOverride?: boolean;
  /** Staff reason for the DAY-OF refund leg (required once the order is paid). */
  dayofRefundReason?: string;
  /** Codes of every manager-severity warning staff ticked before Execute. */
  acknowledgedCodes?: string[];
  /** Staff initials (2-4 letters) — required whenever acknowledgedCodes is non-empty. */
  acknowledgedBy?: string;
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
        ...(typeof json.editId === "string" ? { editId: json.editId } : {}),
        ...(typeof json.failedStep === "string" ? { failedStep: json.failedStep } : {}),
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

/* ── Staff-facing error copy ──────────────────────────────────────────── */

/**
 * Every code the client can receive: the engine's guard codes plus the
 * route-level ones (`edit_failed` for plain Errors, `not_enabled` for the
 * kill switches, `plan_hash_required`) and the two the client itself mints.
 * A full Record so adding a guard code without staff copy fails `tsc`.
 */
export type EditErrorCode =
  | EditGuardCode
  | "edit_failed"
  | "not_enabled"
  | "plan_hash_required"
  | "network"
  | "bad_response";

export const GUARD_COPY: Record<EditErrorCode, { title: string; body?: string }> = {
  not_found: {
    title: "Reservation not found",
    body: "It may have been removed or merged — reload the board.",
  },
  cancelled: { title: "This reservation is cancelled — nothing to edit." },
  unsupported_kind: {
    title: "This booking can't be edited here",
    body: "Change it in Conqueror or BMI, and adjust the money in Square.",
  },
  phase_conflict: {
    title: "Square and our records disagree about whether this visit was paid",
    body: "Don't move money here — check the Payments tab and fix it in Square.",
  },
  combo_phase_split: {
    title: "Part of this booking has been charged at the venue and part has not",
    body: "Open the part that has NOT been charged, or handle it in Square.",
  },
  leg_phase_split: {
    title: "Part of this booking has been charged at the venue and part has not",
    body: "Open the part that has NOT been charged, or handle it in Square.",
  },
  lane_change_mid_session: {
    title: "Lanes and lane time can't change while the guests are bowling",
    body: "Do it in Conqueror.",
  },
  mid_session_unsupported: {
    title: "Heats and attraction slots can't change once the visit has started",
    body: "Adjust them in BMI.",
  },
  pricing_unresolvable: {
    title: "We can't work out a safe price for this change",
    body: "You can still refund individual day-of charges, or adjust the booking in Square or Conqueror.",
  },
  edit_in_progress: {
    title: "Another edit on this booking is still running or waiting on a payment link",
    body: "Check History; if it's stuck, ask support to close it.",
  },
  cancel_in_progress: {
    title: "A cancellation is running on this booking",
    body: "Wait for it to finish, then reload.",
  },
  plan_stale: {
    title: "The reservation changed since the preview",
    body: "Prices refreshed — review the updated quote and try again.",
  },
  post_complete_ack_required: {
    title: "Manager check required",
    body: "This visit is closed — Conqueror and BMI will NOT be updated by an edit.",
  },
  refund_not_enabled: {
    title: "Refunds for this stage of a visit are switched off right now",
    body: "The preview is accurate — ask Eric to turn it back on.",
  },
  edit_not_enabled: {
    title: "Editing is switched off right now",
    body: "You can preview changes and process refunds only. Ask Eric to turn it back on.",
  },
  bmi_line_unavailable: {
    title: "BMI can't be updated from here for this item",
    body: "Change it in BMI, then adjust the money with Refund.",
  },
  heat_capacity: { title: "That heat is full", body: "Pick a different heat in BMI first." },
  qamf_availability: {
    title: "Conqueror can't fit that change",
    body: "Check lane availability in Conqueror, then try again.",
  },
  payment_required: {
    title: "The card on file was declined",
    body: "Send the guest a payment link instead.",
  },
  dayof_reason_required: {
    title: "Add a reason for the refund",
    body: "The day-of refund is recorded in Square with a staff reason.",
  },
  dayof_reason_reserved: {
    title: "That refund reason is reserved",
    body: "“Reservation Deposit” is the deposit leg's label — write what was refunded instead.",
  },
  full_refund_use_cancel: {
    title: "Refunding the whole visit is a cancellation",
    body: "Use Cancel — it voids the booking and refunds the money.",
  },
  ack_required: {
    title: "Confirm the by-hand steps first",
    body: "Tick every red item and add your initials, then execute again.",
  },
  conqueror_origin: {
    title: "Desk booking — change it in Conqueror",
    body: "Booked at the desk: there is no web deposit or price to adjust here.",
  },
  dayof_payment_unresolved: {
    title: "We can't tell which payment paid for this visit",
    body: "Refund it in Square directly.",
  },
  no_changes: { title: "No changes yet" },
  edit_failed: {
    title: "The change didn't finish",
    body: "Check the Payments tab before retrying — money already moved is netted, never moved twice.",
  },
  not_enabled: {
    title: "Editing is switched off right now",
    body: "You can preview changes and process refunds only. Ask Eric to turn it back on.",
  },
  plan_hash_required: {
    title: "The preview is missing",
    body: "Close and re-open the editor, then try again.",
  },
  network: {
    title: "Couldn't reach the edit service",
    body: "Check the connection and try again.",
  },
  bad_response: {
    title: "The edit service sent an unexpected answer",
    body: "Try again; if it repeats, tell support.",
  },
};

export interface EditErrorCopy {
  title: string;
  /** Plain-English body — the server's staff-directed detail when it has one. */
  body: string;
  /** Raw code + detail + ledger ids, for the collapsed "Details for support". */
  supportDetail: string;
}

/** Codes whose `detail` the CLIENT wrote (an exception message) — never staff copy. */
const CLIENT_CODES: ReadonlySet<string> = new Set(["network", "bad_response"]);

/**
 * Turn a typed route error into staff copy. The engine writes many
 * staff-directed details (which leg to open, what to do in Square), so the
 * server detail is the body whenever it is a real sentence — i.e. differs
 * from the bare code. The map's body is the fallback. Never renders a bare code.
 */
export const describeEditError = (error: EditApiError): EditErrorCopy => {
  const entry = (GUARD_COPY as Record<string, { title: string; body?: string } | undefined>)[
    error.code
  ] ?? { title: "This change cannot be made here" };
  const serverDetail =
    error.detail && error.detail !== error.code && !CLIENT_CODES.has(error.code)
      ? error.detail
      : null;
  const supportDetail = [
    error.code,
    error.detail && error.detail !== error.code ? error.detail : null,
    error.editId ? `edit ${error.editId}` : null,
    error.failedStep ? `failed at ${error.failedStep}` : null,
    error.status ? `HTTP ${error.status}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return { title: entry.title, body: serverDetail ?? entry.body ?? "", supportDetail };
};

/**
 * Kill-switch messages embed the env var for ops ("(RESERVATION_EDIT_V2=false)").
 * Staff copy drops it; the caller keeps it in a title attribute.
 */
export const splitEnvNote = (message: string): { text: string; envNote: string | null } => {
  const m = message.match(/\s*\(([A-Z][A-Z0-9_]+=[^)\s]+)\)/);
  if (!m) return { text: message, envNote: null };
  return {
    text: message
      .replace(m[0], "")
      .replace(/\s{2,}/g, " ")
      .trim(),
    envNote: m[1],
  };
};

/* ── Mount-probe classification ───────────────────────────────────────── */

export type MountOutcome =
  | { kind: "edit"; capabilities: EditCapabilities | null }
  | { kind: "ack_required" }
  | { kind: "blocked"; copy: EditErrorCopy }
  | { kind: "error"; copy: EditErrorCopy };

/**
 * The modal opens with a dry-run on an EMPTY spec. The engine throws
 * no_changes BEFORE returning a plan, so that error is the EXPECTED healthy
 * answer ("editable, nothing changed yet" — the form initializes from the
 * board row instead) and it carries the environment's kill-switch state.
 * post_complete_ack_required means editable only after the manager
 * acknowledges the no-QAMF/BMI warning. Everything else with an HTTP status
 * is a real gate (cancelled / phase_conflict / combo_phase_split / …) →
 * blocked; status 0 is transport failure → retryable error.
 */
export const classifyMountOutcome = (
  outcome: { kind: "plan"; plan: EditPlan } | { kind: "error"; error: EditApiError },
): MountOutcome => {
  if (outcome.kind === "plan") return { kind: "edit", capabilities: null };
  const { error } = outcome;
  if (error.code === "no_changes") {
    return { kind: "edit", capabilities: error.data?.capabilities ?? null };
  }
  if (error.code === "post_complete_ack_required") return { kind: "ack_required" };
  const copy = describeEditError(error);
  if (error.status === 0) return { kind: "error", copy };
  return { kind: "blocked", copy };
};

/* ── Execute-failure classification ───────────────────────────────────── */

export type ExecuteFailureAction =
  | { kind: "refresh_plan" }
  /** Manager codes were not acknowledged — back to the form with the banner. */
  | { kind: "ack_required"; missing: string[]; copy: EditErrorCopy }
  /** A form field needs fixing (day-of refund reason) — back to the form. */
  | { kind: "fix_form"; copy: EditErrorCopy }
  /** Nothing the operator can do from here — Close only. */
  | { kind: "blocked"; copy: EditErrorCopy }
  | { kind: "error"; copy: EditErrorCopy; offerPaymentLink: boolean };

/**
 * Capacity / config / environment refusals. Retrying cannot succeed and a
 * payment link would re-plan into the same fatal step, so neither is offered.
 */
const BLOCKED_EXECUTE_CODES: ReadonlySet<string> = new Set([
  "heat_capacity",
  "qamf_availability",
  "bmi_line_unavailable",
  "conqueror_origin",
  "dayof_payment_unresolved",
  "unsupported_kind",
  "pricing_unresolvable",
  "not_enabled",
  "refund_not_enabled",
  "edit_not_enabled",
]);

/** Steps after which every fatal external step has passed — a link can finish the edit. */
const CHARGE_STEPS: ReadonlySet<string> = new Set(["charge_topup", "charge_dayof_order"]);

export const classifyExecuteFailure = (
  error: EditApiError,
  diffCents: number,
): ExecuteFailureAction => {
  if (error.code === "plan_stale") return { kind: "refresh_plan" };
  const copy = describeEditError(error);
  if (error.code === "ack_required") {
    return { kind: "ack_required", missing: error.data?.missing ?? [], copy };
  }
  if (error.code === "dayof_reason_required" || error.code === "dayof_reason_reserved") {
    return { kind: "fix_form", copy };
  }
  if (BLOCKED_EXECUTE_CODES.has(error.code)) return { kind: "blocked", copy };
  if (error.code === "payment_required") {
    return { kind: "error", copy, offerPaymentLink: diffCents > 0 };
  }
  // Other 409/404s: the reservation moved under us (phase, cancel, lock).
  if (error.status === 409 || error.status === 404) return { kind: "blocked", copy };
  // edit_failed 502 and anything unexpected — retryable (money already moved
  // is netted server-side). A payment link only helps once the charge step is
  // what failed: earlier fatal steps (BMI heats, QAMF rebook) would re-fail.
  return {
    kind: "error",
    copy,
    offerPaymentLink: diffCents > 0 && !!error.failedStep && CHARGE_STEPS.has(error.failedStep),
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

/* ── Manager acknowledgments ──────────────────────────────────────────── */

/**
 * The one manager code the engine emits for a closed visit. The blocked-screen
 * "I understand" gate acknowledges exactly this, so the edit-phase banner
 * pre-ticks it rather than asking for the same statement twice.
 */
export const POST_COMPLETE_ACK_CODE = "post_complete_no_external_sync";

export const managerWarnings = (plan: EditPlan | null): EditWarning[] =>
  (plan?.warnings ?? []).filter((w) => w.severity === "manager");

/** Distinct manager codes on the plan, in warning order. */
export const managerCodes = (plan: EditPlan | null): string[] => [
  ...new Set(managerWarnings(plan).map((w) => w.code)),
];

export const planNeedsManagerAck = (plan: EditPlan | null): boolean =>
  managerWarnings(plan).length > 0;

/** Manager codes on the CURRENT plan that staff have not ticked. */
export const missingAckCodes = (plan: EditPlan | null, ackedCodes: ReadonlySet<string>): string[] =>
  managerCodes(plan).filter((c) => !ackedCodes.has(c));

/** Two to four letters — the shared portal token carries no identity otherwise. */
export const isValidInitials = (raw: string): boolean => /^[A-Za-z]{2,4}$/.test(raw.trim());

export const normalizeInitials = (raw: string): string => raw.trim().toUpperCase();

/**
 * What Execute sends: only the codes that are BOTH on the current plan and
 * ticked (a stale tick for a warning that disappeared is never sent), plus the
 * initials whenever there is anything to acknowledge.
 */
export const buildExecuteAck = (
  plan: EditPlan,
  ackedCodes: ReadonlySet<string>,
  initials: string,
): { acknowledgedCodes: string[]; acknowledgedBy?: string } => {
  const acknowledgedCodes = managerCodes(plan).filter((c) => ackedCodes.has(c));
  return acknowledgedCodes.length > 0
    ? { acknowledgedCodes, acknowledgedBy: normalizeInitials(initials) }
    : { acknowledgedCodes };
};

export const SYSTEM_LABELS: Record<ManualStep["system"], string> = {
  conqueror: "Conqueror",
  bmi: "BMI",
  square: "Square",
  guest: "Guest",
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
 *   - an environment refusal (kill switch) disables it outright;
 *   - every manager warning on the CURRENT plan needs its own tick, plus the
 *     acknowledging staff member's initials;
 *   - decreases require a refund destination (CancelModal's pickRow rule);
 *   - a day-of refund leg requires a staff reason;
 *   - increases charge the card on file, or fall to the payment-link CTA.
 */
export const executeGate = (args: {
  plan: EditPlan | null;
  planLoading: boolean;
  refundDest: EditSettlement | null;
  /** Manager warning codes staff ticked (may include stale ones — ignored). */
  ackedCodes: ReadonlySet<string>;
  /** Initials typed next to the acknowledgments. */
  ackInitials: string;
  /** Text entered for the day-of refund leg, when the plan has one. */
  dayofRefundReason?: string;
}): ExecuteGate => {
  const { plan } = args;
  if (!plan || args.planLoading) return { enabled: false, reason: null, mode: "confirm" };
  const mode = modeOf(plan);
  // Environment refusal, not an operator mistake — surface it first so nobody
  // fills the rest of the form out before learning the button can't fire.
  if (plan.executionBlocked) {
    return { enabled: false, reason: splitEnvNote(plan.executionBlocked.message).text, mode };
  }
  if (planNeedsManagerAck(plan)) {
    if (missingAckCodes(plan, args.ackedCodes).length > 0) {
      return {
        enabled: false,
        reason: "Tick every red item to confirm you will make those changes by hand",
        mode,
      };
    }
    if (!isValidInitials(args.ackInitials)) {
      return { enabled: false, reason: "Add your initials (2-4 letters) to the check", mode };
    }
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

/* ── Notify checkbox ──────────────────────────────────────────────────── */

/**
 * Whether the "notify the guest" box starts ticked. Off for refunds and for
 * anything after the visit closed (the only template we can send is the
 * original "your lane is reserved" confirmation), and forced off for racing /
 * attraction rows, which have no automated resend at all.
 */
export const defaultNotifyGuest = (args: {
  intent: "edit" | "refund";
  phase: EditPlan["phase"] | null;
  isRace: boolean;
}): boolean => {
  if (args.isRace) return false;
  if (args.intent === "refund") return false;
  if (args.phase === "post_complete") return false;
  return true;
};

export const notifyLabel = (args: {
  intent: "edit" | "refund";
  phase: EditPlan["phase"] | null;
}): string =>
  args.intent === "edit" && args.phase !== "post_complete"
    ? "Email & text the updated confirmation to the guest"
    : "Re-send the booking confirmation to the guest (not usual after a refund)";

/* ── Success-screen derivations ───────────────────────────────────────── */

/** Post-execution warning codes that mean a human still has to fix something. */
const MANUAL_WARNING_SYSTEM = (code: string): ManualStep["system"] | null => {
  if (code === "qamf_players_failed" || /^qamf_.*_failed$/.test(code)) return "conqueror";
  if (/^bmi_.*_failed$/.test(code)) return "bmi";
  if (code === "resend_manual") return "guest";
  return null;
};

/**
 * Everything staff must do by hand after this result: the engine's typed
 * `manualSteps` (predicted = acknowledged before Execute; unpredicted = a
 * best-effort sync step failed), with a fallback derived from the legacy
 * warning codes for results written before the field existed.
 */
export const collectManualSteps = (result: EditResult): ManualStep[] => {
  const explicit = result.manualSteps ?? [];
  const out: ManualStep[] = [...explicit];
  const seen = new Set(out.map((s) => `${s.code}|${s.message}`));
  for (const w of result.warnings) {
    const system = MANUAL_WARNING_SYSTEM(w.code);
    if (!system) continue;
    const key = `${w.code}|${w.message}`;
    if (seen.has(key)) continue;
    // Same code already carried as a typed step → the typed one wins.
    if (explicit.some((s) => s.code === w.code)) continue;
    seen.add(key);
    out.push({ system, code: w.code, message: w.message, predicted: false });
  }
  return out;
};

/** Warnings that were NOT promoted to manual steps (plain info lines). */
export const residualWarnings = (result: EditResult, manual: ManualStep[]): EditWarning[] => {
  const codes = new Set(manual.map((s) => s.code));
  return result.warnings.filter((w) => !codes.has(w.code));
};

/** Toast suffix naming the system(s) that need a hand. */
export const manualFixSuffix = (steps: ManualStep[]): string => {
  if (steps.length === 0) return "";
  const systems = [...new Set(steps.map((s) => s.system))];
  const external = systems.filter((s) => s !== "guest");
  if (external.length === 0) return " — the guest was NOT notified, contact them";
  return ` — ${external.map((s) => SYSTEM_LABELS[s]).join("/")} needs a manual fix`;
};

/* ── Display helpers ──────────────────────────────────────────────────── */

export const WARNING_COLORS: Record<EditWarning["severity"], string> = {
  info: "var(--ba-muted)",
  warning: "#f59e0b",
  manager: "#ef4444",
};

/** Toast line for onDone — mirrors CancelModal's finish() wording. */
export const resultSummary = (guest: string, result: EditResult): string => {
  const suffix = manualFixSuffix(collectManualSteps(result));
  if (result.state === "pending_payment") {
    return `${guest}: edit pending payment — send the guest the ${dollars(result.diffCents)} payment link${suffix}`;
  }
  if (result.diffCents > 0) {
    return `${guest}: reservation updated — ${dollars(result.diffCents)} charged${suffix}`;
  }
  if (result.diffCents < 0) {
    return result.storeCreditGan
      ? `${guest}: reservation updated — ${dollars(-result.diffCents)} gift card ${ganDisplay(result.storeCreditGan)}${suffix}`
      : `${guest}: reservation updated — ${dollars(-result.diffCents)} refunded${suffix}`;
  }
  return `${guest}: reservation updated${suffix}`;
};
