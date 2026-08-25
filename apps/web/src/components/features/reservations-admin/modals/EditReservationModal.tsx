"use client";

/**
 * Edit Reservation modal for the admin reservations board — players, lanes,
 * shoes, and racers for every reservation kind, with the money following
 * (charge the card on file / payment link, refund to card / gift card).
 *
 * Structurally cloned from CancelModal: ModalShell, phase machine
 * loading → edit → busy → success | blocked | error, server dry-run as the
 * single source of truth. One form + a live server-priced quote (no stepper):
 * every change debounce-triggers POST /api/admin/reservations/edit
 * {dryRun:true} and the response IS the review surface (old→new lines, the
 * authoritative Square-calculated diff, warnings, planHash).
 *
 * Mount probe: an EMPTY spec dry-run. The engine throws no_changes before
 * returning a plan, so that error means "editable, nothing changed yet" and
 * the form initializes from the board row; it also carries the environment's
 * kill-switch state (capabilities). The first real change hydrates lane/shoe/
 * roster facts from plan.current. Money is NEVER computed here — only server
 * cents are rendered.
 *
 * Acknowledgments: every manager-severity warning on the CURRENT plan
 * (Conqueror / BMI will NOT be updated) gets its own checkbox, plus the
 * acknowledging staff member's initials. The set is keyed by warning code, so
 * a plan refresh that introduces a new code arrives unticked; Execute sends the
 * ticked codes + initials, and the engine records them on the ledger row.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { CENTERS, STATUS_LABELS } from "~/features/reservations-admin/constants";
import { dollars, fmtClock, fmtDate, ganDisplay } from "~/features/reservations-admin/format";
import type { Reservation } from "~/features/reservations-admin/types";
import type { EditCurrentState } from "~/features/reservation-edit/plan";
import type {
  EditCapabilities,
  EditPaymentSource,
  EditSettlement,
  ManualStep,
} from "~/features/reservation-edit/types";
import type { EditResult } from "~/features/reservation-edit/service";
import ModalShell from "../ModalShell";
import { INPUT_STYLE, NAV_BTN } from "../theme";
import {
  buildDiffRows,
  buildExecuteAck,
  buildSpec,
  classifyExecuteFailure,
  classifyMountOutcome,
  collectManualSteps,
  defaultNotifyGuest,
  describeEditError,
  emptyForm,
  executeGate,
  isEmptySpec,
  managerWarnings,
  notifyLabel,
  POST_COMPLETE_ACK_CODE,
  residualWarnings,
  resultSummary,
  splitEnvNote,
  SYSTEM_LABELS,
  WARNING_COLORS,
  type EditErrorCopy,
  type EditFormState,
} from "./editPlanHelpers";
import { useEditPlan } from "./useEditPlan";

const ACCENT = "#f59e0b";

const SECTION: CSSProperties = {
  padding: "0.75rem",
  borderRadius: 10,
  backgroundColor: "var(--ba-bg2)",
  border: "1px solid var(--ba-border)",
  marginBottom: "0.9rem",
};

const SECTION_TITLE: CSSProperties = {
  fontSize: "0.68rem",
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: 1,
  color: "var(--ba-muted)",
  marginBottom: 8,
};

const STEP_BTN: CSSProperties = {
  ...NAV_BTN,
  padding: "0.1rem 0.6rem",
  fontSize: "0.95rem",
  lineHeight: 1.3,
};

const SMALL_INPUT: CSSProperties = {
  ...INPUT_STYLE,
  padding: "0.3rem 0.5rem",
  fontSize: "0.78rem",
};

/** Prominent amber block — kill switches, preview-only, form fixes. */
const AMBER_BLOCK: CSSProperties = {
  padding: "0.6rem 0.75rem",
  borderRadius: 8,
  backgroundColor: "rgba(245,158,11,0.12)",
  border: "1px solid rgba(245,158,11,0.35)",
  fontSize: "0.78rem",
  color: ACCENT,
  marginBottom: "0.9rem",
  lineHeight: 1.5,
};

/** Red block — manager checks, by-hand follow-ups, blocked / failed states. */
const RED_BLOCK: CSSProperties = {
  padding: "0.6rem 0.75rem",
  borderRadius: 8,
  backgroundColor: "rgba(239,68,68,0.12)",
  border: "1px solid rgba(239,68,68,0.3)",
  fontSize: "0.78rem",
  color: "#ef4444",
  marginBottom: "0.9rem",
  lineHeight: 1.5,
};

const PRIMARY_BTN: CSSProperties = {
  padding: "0.5rem 1.25rem",
  borderRadius: 8,
  fontSize: "0.8rem",
  fontWeight: 700,
  cursor: "pointer",
  border: "none",
  backgroundColor: ACCENT,
  color: "#fff",
};

/** Heats list before the first plan arrives — from the board row's metadata. */
const heatsFromBoard = (r: Reservation): Array<{ index: number; label: string }> =>
  (r.bookingMetadata?.heats ?? []).map((h, index) => ({
    index,
    label: `${h.assignedTo || "Racer"}${h.heatId ? ` — ${fmtClock(h.heatId)}` : ""}`,
  }));

/** Collapsed raw code / detail / ledger ids — never the primary copy. */
function SupportDetails({ text }: { text: string }) {
  if (!text) return null;
  return (
    <details style={{ marginTop: 6, fontSize: "0.66rem", color: "var(--ba-muted)" }}>
      <summary style={{ cursor: "pointer" }}>Details for support</summary>
      <code
        style={{
          display: "block",
          marginTop: 4,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          fontFamily: "ui-monospace, monospace",
        }}
      >
        {text}
      </code>
    </details>
  );
}

function ErrorCopyBlock({ copy, tone }: { copy: EditErrorCopy; tone: "red" | "amber" }) {
  return (
    <div style={tone === "red" ? RED_BLOCK : AMBER_BLOCK}>
      <div style={{ fontWeight: 700 }}>{copy.title}</div>
      {copy.body && <div style={{ color: "var(--ba-fg)", marginTop: 2 }}>{copy.body}</div>}
      <SupportDetails text={copy.supportDetail} />
    </div>
  );
}

function SystemBadge({ system }: { system: ManualStep["system"] }) {
  return (
    <span
      style={{
        display: "inline-block",
        padding: "0 6px",
        borderRadius: 4,
        fontSize: "0.62rem",
        fontWeight: 700,
        textTransform: "uppercase",
        letterSpacing: 0.5,
        color: "#ef4444",
        border: "1px solid rgba(239,68,68,0.4)",
        backgroundColor: "rgba(239,68,68,0.08)",
        marginRight: 6,
        whiteSpace: "nowrap",
        verticalAlign: "middle",
      }}
    >
      {SYSTEM_LABELS[system]}
    </span>
  );
}

export default function EditReservationModal({
  reservation,
  token,
  onClose,
  onDone,
  intent = "edit",
}: {
  reservation: Reservation;
  token: string;
  onClose: () => void;
  onDone: (msg: string) => void;
  /**
   * Which door the operator came through. "refund" is the same engine and the
   * same server contract — it only drops the grow-the-booking affordances,
   * which on an already-paid order can't settle anywhere useful.
   */
  intent?: "edit" | "refund";
}) {
  const [phase, setPhase] = useState<"loading" | "edit" | "busy" | "success" | "blocked" | "error">(
    "loading",
  );
  const [form, setForm] = useState<EditFormState>(emptyForm);
  const [current, setCurrent] = useState<EditCurrentState | null>(null);
  /** Kill-switch state from the mount probe's no_changes payload. */
  const [capabilities, setCapabilities] = useState<EditCapabilities | null>(null);
  const [refundDest, setRefundDest] = useState<EditSettlement | null>(null);
  /**
   * Reason recorded on the DAY-OF Square refund. Deliberately NOT the deposit
   * leg's "Refund: Reservation Deposit" — that string is the accounting
   * portal's journal key, and one economic refund moves money twice.
   */
  const [dayofRefundReason, setDayofRefundReason] = useState("");
  /** Staff toggled the notify box (else the phase/intent default applies). */
  const [notifyTouched, setNotifyTouched] = useState(false);
  const [notifyChoice, setNotifyChoice] = useState(false);
  /** Post-complete: the mount probe demanded the closed-visit acknowledgment. */
  const [ackRequired, setAckRequired] = useState(false);
  /** The closed-visit acknowledgment was given — sent as managerOverride on every request. */
  const [postCompleteAcked, setPostCompleteAcked] = useState(false);
  /** Blocked-screen checkbox — state only; "Continue" performs the transition. */
  const [blockedAckTicked, setBlockedAckTicked] = useState(false);
  /** Manager-warning codes staff ticked. Stale codes are ignored, new ones arrive unticked. */
  const [ackedCodes, setAckedCodes] = useState<ReadonlySet<string>>(() => new Set());
  const [ackInitials, setAckInitials] = useState("");
  /** A server refusal that sends staff back to the form (missing ack, bad reason). */
  const [editNotice, setEditNotice] = useState<EditErrorCopy | null>(null);
  const [result, setResult] = useState<EditResult | null>(null);
  const [blockCopy, setBlockCopy] = useState<EditErrorCopy | null>(null);
  const [errCopy, setErrCopy] = useState<EditErrorCopy | null>(null);
  const [errorCtx, setErrorCtx] = useState<"mount" | "execute">("mount");
  const [offerLink, setOfferLink] = useState(false);
  /** planHash of a quote auto-refreshed after a plan_stale execute — shows
   *  the "prices refreshed" notice for exactly that quote. */
  const [refreshedHash, setRefreshedHash] = useState<string | null>(null);
  const [ganCopied, setGanCopied] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);

  const { plan, planError, planLoading, requestPlan, clearPlan, execute } = useEditPlan(
    reservation.id,
    token,
  );

  const isCombo = !!reservation.comboSpecialId;
  const isRace = reservation.productKind === "race" || reservation.productKind === "attraction";
  /**
   * Refunding a settled visit is NOT editing it. The guest was here — the
   * roster, lane count and heats are history and cannot change (QAMF/BMI are
   * not synced and the paid order's lines are frozen). Showing player and shoe
   * steppers invites staff to "fix" a booking that already happened, and it
   * split one action across two controls: shoes via the Shoes stepper, fees via
   * the day-of list. So refund intent renders exactly one thing — the day-of
   * order's own lines with quantities, which is what the guest was charged from.
   */
  const bowlingEditable = intent !== "refund" && !isCombo && !isRace;
  const racersEditable = intent !== "refund" && (isRace || isCombo);
  /** The venue charge lives on a sibling leg's order (shared day-of order). */
  const refundFromSibling =
    intent === "refund" && !reservation.dayofPaymentId && !!reservation.groupHasDayofPayment;

  const basePlayerCount = current?.playerCount ?? reservation.playerCount ?? 1;
  const effPlayerCount = form.playerCount ?? basePlayerCount;
  const effLaneCount = form.laneCount ?? current?.laneCount ?? 1;

  const spec = useMemo(
    () => buildSpec(form, basePlayerCount, current),
    [form, basePlayerCount, current],
  );
  const specEmpty = isEmptySpec(spec);
  const specJson = JSON.stringify(spec);
  // The closed-visit ack changes what the server will answer, so it is part of
  // the quote key: giving it re-quotes the same spec.
  const requestKey = `${specJson}|${refundDest ?? ""}|${postCompleteAcked ? "ack" : ""}`;
  const lastKey = useRef<string | null>(null);

  /* ── Dry-run wrapper: cache plan.current so the form stays hydrated
   *    across no_changes (the hook clears `plan` on every error). ───────── */
  const requestQuote = useCallback(
    async (
      quoteSpec: Parameters<typeof requestPlan>[0],
      opts?: Parameters<typeof requestPlan>[1],
    ) => {
      const r = await requestPlan(quoteSpec, opts);
      if (r.kind === "plan") setCurrent(r.plan.current);
      // no_changes is the healthy "editable, nothing changed yet" answer and it
      // carries `current` — hydrate from it so the form (and on a settled
      // reservation, the day-of order lines that ARE the refund control) is
      // populated the moment the modal opens — plus the kill-switch state.
      else if (r.kind === "error" && r.error.code === "no_changes") {
        if (r.error.data?.current) setCurrent(r.error.data.current);
        if (r.error.data?.capabilities) setCapabilities(r.error.data.capabilities);
      }
      return r;
    },
    [requestPlan],
  );

  /* ── Mount probe (empty spec — no_changes means "editable"). Callers set
   *    phase "loading" themselves (it is the initial state) so this stays
   *    free of synchronous setState when run from the mount effect. ─────── */
  const probe = useCallback(
    async (managerOverride: boolean) => {
      const r = await requestQuote({}, { immediate: true, managerOverride });
      if (r.kind === "superseded") return;
      const outcome = classifyMountOutcome(r);
      if (outcome.kind === "edit") {
        setPhase("edit");
      } else if (outcome.kind === "ack_required") {
        setAckRequired(true);
        setPhase("blocked");
      } else if (outcome.kind === "blocked") {
        setBlockCopy(outcome.copy);
        setPhase("blocked");
      } else {
        setErrCopy(outcome.copy);
        setErrorCtx("mount");
        setPhase("error");
      }
    },
    [requestQuote],
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mount-only server probe; every setState happens after the fetch resolves (same idiom as useReservationDetail)
    void probe(false);
    // Mount-only — the modal is keyed by reservation id upstream.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ── Debounced dry-run on every form / settlement change ─────────────── */
  useEffect(() => {
    if (phase !== "edit") return;
    if (specEmpty) {
      lastKey.current = null;
      clearPlan();
      return;
    }
    if (lastKey.current === requestKey) return;
    lastKey.current = requestKey;
    void requestQuote(spec, {
      settlement: refundDest ?? undefined,
      managerOverride: postCompleteAcked || undefined,
    });
  }, [phase, requestKey, specEmpty, spec, refundDest, postCompleteAcked, requestQuote, clearPlan]);

  /** The closed-visit gate: acknowledge once, seed its code, re-quote. */
  const givePostCompleteAck = useCallback(() => {
    setPostCompleteAcked(true);
    setAckedCodes((prev) => new Set([...prev, POST_COMPLETE_ACK_CODE]));
  }, []);

  /* ── Execute ──────────────────────────────────────────────────────────── */
  const handleExecuteFailure = useCallback(
    async (error: Parameters<typeof classifyExecuteFailure>[0], diffCents: number) => {
      const action = classifyExecuteFailure(error, diffCents);
      if (action.kind === "refresh_plan") {
        lastKey.current = requestKey;
        const refreshed = await requestQuote(spec, {
          settlement: refundDest ?? undefined,
          managerOverride: postCompleteAcked || undefined,
          immediate: true,
        });
        if (refreshed.kind === "plan") setRefreshedHash(refreshed.plan.planHash);
        setPhase("edit");
        return;
      }
      if (action.kind === "ack_required") {
        // Whatever the server says is missing must be re-ticked, never assumed.
        const missing = new Set(action.missing);
        setAckedCodes((prev) => new Set([...prev].filter((c) => !missing.has(c))));
        setEditNotice(action.copy);
        setPhase("edit");
        return;
      }
      if (action.kind === "fix_form") {
        setEditNotice(action.copy);
        setPhase("edit");
        return;
      }
      if (action.kind === "blocked") {
        setBlockCopy(action.copy);
        setPhase("blocked");
        return;
      }
      setErrCopy(action.copy);
      setOfferLink(action.offerPaymentLink);
      setErrorCtx("execute");
      setPhase("error");
    },
    [requestKey, requestQuote, spec, refundDest, postCompleteAcked],
  );

  /* ── Derived view state ──────────────────────────────────────────────── */
  const planPhase = plan?.phase ?? null;
  const notifyGuest = isRace
    ? false
    : notifyTouched
      ? notifyChoice
      : defaultNotifyGuest({ intent, phase: planPhase, isRace });

  const runExecute = useCallback(
    async (overrideSource?: EditPaymentSource) => {
      const activePlan = plan;
      if (!activePlan) return;
      setEditNotice(null);
      setPhase("busy");
      const settlementOpt = activePlan.diffCents < 0 ? (refundDest ?? undefined) : undefined;
      // Legacy single-checkbox signal for the closed-visit path (back-compat);
      // the explicit per-code list travels alongside it.
      const managerOverride = postCompleteAcked ? true : undefined;
      const ack = buildExecuteAck(activePlan, ackedCodes, ackInitials);
      let hash = activePlan.planHash;
      const source: EditPaymentSource | undefined =
        overrideSource ??
        (activePlan.diffCents > 0
          ? activePlan.chargeCard
            ? { kind: "card_on_file", cardId: activePlan.chargeCard.cardId }
            : { kind: "payment_link" }
          : undefined);
      if (source?.kind === "payment_link") {
        // The await_payment_link step is hashed into the plan — reprice with
        // the link source so displayed == executed holds.
        const pre = await requestQuote(spec, {
          settlement: settlementOpt,
          paymentSource: source,
          managerOverride,
          immediate: true,
        });
        if (pre.kind === "superseded") return;
        if (pre.kind === "error") {
          await handleExecuteFailure(pre.error, activePlan.diffCents);
          return;
        }
        hash = pre.plan.planHash;
      }
      const res = await execute(spec, {
        settlement: settlementOpt,
        paymentSource: source,
        managerOverride,
        planHash: hash,
        notifyGuest,
        dayofRefundReason: dayofRefundReason.trim() || undefined,
        ...ack,
      });
      if (res.kind === "result") {
        setResult(res.result);
        setPhase("success");
        return;
      }
      if (res.kind === "error") await handleExecuteFailure(res.error, activePlan.diffCents);
    },
    [
      plan,
      refundDest,
      postCompleteAcked,
      ackedCodes,
      ackInitials,
      spec,
      notifyGuest,
      dayofRefundReason,
      requestQuote,
      execute,
      handleExecuteFailure,
    ],
  );

  const finish = () => {
    if (result) onDone(resultSummary(reservation.guestName || "Guest", result));
    onClose();
  };

  /* ── Form mutators ────────────────────────────────────────────────────── */
  const stepPlayers = (delta: number) =>
    setForm((f) => ({
      ...f,
      playerCount: Math.min(40, Math.max(1, (f.playerCount ?? basePlayerCount) + delta)),
    }));
  const stepLanes = (delta: number) =>
    setForm((f) => ({
      ...f,
      laneCount: Math.min(20, Math.max(1, (f.laneCount ?? current?.laneCount ?? 1) + delta)),
    }));
  const setPlayerField = (
    slot: number,
    patch: { name?: string; shoeSize?: string; bumpers?: boolean },
  ) =>
    setForm((f) => ({
      ...f,
      playersTouched: true,
      players: { ...f.players, [slot]: { ...f.players[slot], ...patch } },
    }));
  const setShoeQty = (id: number, qty: number) =>
    setForm((f) => ({ ...f, shoes: { ...(f.shoes ?? {}), [id]: Math.max(0, qty) } }));
  const toggleRemoveHeat = (index: number) =>
    setForm((f) => ({
      ...f,
      removeHeatIndexes: f.removeHeatIndexes.includes(index)
        ? f.removeHeatIndexes.filter((i) => i !== index)
        : [...f.removeHeatIndexes, index],
    }));
  const addRacerRow = () => {
    // Default new racers to the booked heats' category — an all-junior
    // reservation almost always adds another junior (and vice versa).
    const cats = new Set((current?.heats ?? []).map((h) => h.category));
    const defaultCategory: "adult" | "junior" =
      cats.size === 1 && cats.has("junior") ? "junior" : "adult";
    setForm((f) => ({
      ...f,
      addRacers: [...f.addRacers, { firstName: "", category: defaultCategory, isNew: false }],
    }));
  };
  const patchRacerRow = (
    i: number,
    patch: { firstName?: string; category?: "adult" | "junior"; isNew?: boolean },
  ) =>
    setForm((f) => ({
      ...f,
      addRacers: f.addRacers.map((row, j) => (j === i ? { ...row, ...patch } : row)),
    }));
  const dropRacerRow = (i: number) =>
    setForm((f) => ({ ...f, addRacers: f.addRacers.filter((_, j) => j !== i) }));
  const toggleAck = (code: string, on: boolean) => {
    setEditNotice(null);
    setAckedCodes((prev) => {
      const next = new Set(prev);
      if (on) next.add(code);
      else next.delete(code);
      return next;
    });
  };

  const gate = executeGate({
    plan,
    planLoading,
    refundDest,
    ackedCodes,
    ackInitials,
    dayofRefundReason,
  });
  const busy = phase === "busy";
  // The day-of leg only exists once the order is paid. Its refund carries a
  // staff-written reason (the deposit journal key is reserved for the cash
  // leg), and the server refuses without one — so ask for it here.
  const needsDayofReason = (plan?.steps ?? []).some(
    (s) => s.kind === "refund_dayof_payment" || s.kind === "refund_dayof_order",
  );
  const managerList = managerWarnings(plan);
  const otherWarnings = (plan?.warnings ?? []).filter((w) => w.severity !== "manager");
  // The reservation drifted into post_complete while the modal was open (lane
  // closed mid-session): the dry-run now demands the closed-visit ack. Offer
  // it here instead of a dead-end error line.
  const driftAck = planError?.code === "post_complete_ack_required" && !postCompleteAcked;
  const editingOff = intent === "edit" && capabilities != null && !capabilities.edit;
  const refundsOff = intent === "refund" && capabilities != null && !capabilities.refund;
  const blockedNote = plan?.executionBlocked ? splitEnvNote(plan.executionBlocked.message) : null;
  const displayHeats: Array<{ index: number; label: string }> = current
    ? current.heats.map((h) => ({
        index: h.index,
        label: `${h.racer ?? "Racer"} · ${h.label}${h.heatId ? ` — ${fmtClock(h.heatId)}` : ""}`,
      }))
    : heatsFromBoard(reservation);

  const pickRow = (key: EditSettlement, title: string, sub: string, accent: string) => (
    <button
      type="button"
      onClick={() => setRefundDest(key)}
      disabled={busy}
      style={{
        display: "block",
        width: "100%",
        textAlign: "left",
        padding: "0.6rem 0.75rem",
        borderRadius: 10,
        backgroundColor: refundDest === key ? `${accent}14` : "var(--ba-bg2)",
        border: `1px solid ${refundDest === key ? accent : "var(--ba-border)"}`,
        cursor: "pointer",
        marginBottom: 8,
      }}
    >
      <div
        style={{
          fontSize: "0.82rem",
          fontWeight: 700,
          color: refundDest === key ? accent : "var(--ba-fg)",
        }}
      >
        {title}
      </div>
      <div style={{ fontSize: "0.72rem", color: "var(--ba-muted)", marginTop: 2, lineHeight: 1.4 }}>
        {sub}
      </div>
    </button>
  );

  /** Closed-visit gate: checkbox is state, the button is the action. */
  const postCompleteGate = (onContinue: () => void) => (
    <div style={RED_BLOCK}>
      <div style={{ fontWeight: 700 }}>Manager check required</div>
      <div>
        The day-of order for this reservation is already closed — Conqueror and BMI will NOT be
        updated by an edit. Adjust them by hand afterwards.
      </div>
      <label
        style={{
          display: "flex",
          gap: 8,
          alignItems: "flex-start",
          marginTop: 8,
          cursor: "pointer",
          color: "var(--ba-fg)",
          fontWeight: 600,
        }}
      >
        <input
          type="checkbox"
          checked={blockedAckTicked}
          disabled={busy}
          onChange={(e) => setBlockedAckTicked(e.target.checked)}
          style={{ marginTop: 2 }}
        />
        <span>I understand — Conqueror/BMI will NOT be updated</span>
      </label>
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
        <button
          type="button"
          disabled={!blockedAckTicked || busy}
          onClick={onContinue}
          style={{
            ...PRIMARY_BTN,
            backgroundColor: "#ef4444",
            opacity: blockedAckTicked && !busy ? 1 : 0.5,
            cursor: blockedAckTicked && !busy ? "pointer" : "not-allowed",
          }}
        >
          Continue to edit
        </button>
      </div>
    </div>
  );

  const managerBanner = driftAck
    ? postCompleteGate(givePostCompleteAck)
    : managerList.length > 0 && (
        <div style={RED_BLOCK}>
          <div style={{ fontWeight: 700 }}>Manager check required</div>
          <div style={{ color: "var(--ba-fg)", marginTop: 2 }}>
            These systems will NOT be updated by this change. Tick each line to confirm you will
            make it by hand.
          </div>
          {managerList.map((w) => {
            const ticked = ackedCodes.has(w.code);
            const label = w.manualStep ?? w.message;
            return (
              <label
                key={w.code}
                style={{
                  display: "flex",
                  gap: 8,
                  alignItems: "flex-start",
                  marginTop: 8,
                  cursor: "pointer",
                  color: "var(--ba-fg)",
                  fontWeight: 600,
                }}
              >
                <input
                  type="checkbox"
                  checked={ticked}
                  disabled={busy}
                  onChange={(e) => toggleAck(w.code, e.target.checked)}
                  style={{ marginTop: 2 }}
                />
                <span style={{ flex: 1 }}>
                  {w.system && <SystemBadge system={w.system} />}
                  {label}
                  {w.manualStep && w.message !== w.manualStep && (
                    <div
                      style={{
                        fontSize: "0.7rem",
                        color: "var(--ba-muted)",
                        fontWeight: 400,
                        marginTop: 2,
                      }}
                    >
                      {w.message}
                    </div>
                  )}
                </span>
              </label>
            );
          })}
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10 }}>
            <label
              htmlFor="edit-ack-initials"
              style={{ fontSize: "0.75rem", fontWeight: 700, color: "var(--ba-fg)" }}
            >
              Your initials
            </label>
            <input
              id="edit-ack-initials"
              type="text"
              value={ackInitials}
              disabled={busy}
              maxLength={4}
              placeholder="e.g. EO"
              autoComplete="off"
              onChange={(e) => {
                setEditNotice(null);
                setAckInitials(e.target.value.replace(/[^A-Za-z]/g, "").toUpperCase());
              }}
              style={{ ...SMALL_INPUT, width: 72, textTransform: "uppercase" }}
            />
            <span style={{ fontSize: "0.68rem", color: "var(--ba-muted)" }}>
              2-4 letters — recorded with the edit
            </span>
          </div>
        </div>
      );

  const executeLabel = busy
    ? "Working..."
    : plan?.executionBlocked
      ? "Preview only"
      : gate.mode === "charge_card" && plan
        ? `Charge ${dollars(plan.diffCents)} & Update`
        : gate.mode === "payment_link"
          ? "Send payment link"
          : gate.mode === "refund" && plan
            ? refundDest === "store_credit"
              ? `Update & Issue ${dollars(-plan.diffCents)} Gift Card`
              : `Update & Refund ${dollars(-plan.diffCents)}`
            : "Confirm Changes";

  const executeColor = gate.mode === "refund" && refundDest === "store_credit" ? "#22c55e" : ACCENT;

  const manualSteps = result ? collectManualSteps(result) : [];
  const resultWarnings = result ? residualWarnings(result, manualSteps) : [];

  return (
    <ModalShell
      onClose={onClose}
      maxWidth={560}
      maxHeight="92vh"
      borderColor="rgba(245,158,11,0.3)"
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          marginBottom: "1rem",
        }}
      >
        <div>
          <h3 style={{ fontSize: "1rem", fontWeight: 700, color: ACCENT, margin: 0 }}>
            {intent === "refund"
              ? "Refund Reservation"
              : isCombo
                ? "Edit VIP Combo — racers"
                : "Edit Reservation"}
          </h3>
          {refundFromSibling && (
            <div style={{ fontSize: "0.72rem", color: "var(--ba-muted)", marginTop: 2 }}>
              Refunding from the bowling part of this booking — the venue charge lives on its order.
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          style={{
            background: "none",
            border: "none",
            color: "var(--ba-muted)",
            cursor: "pointer",
            fontSize: "1.2rem",
          }}
        >
          &times;
        </button>
      </div>

      {phase === "loading" && (
        <div style={{ color: "var(--ba-muted)", fontSize: "0.85rem", padding: "1rem 0" }}>
          Checking whether this reservation can be edited...
        </div>
      )}

      {(phase === "edit" || phase === "busy") && (
        <>
          {/* Booking summary */}
          <div style={{ ...SECTION, fontSize: "0.8rem", lineHeight: 1.7 }}>
            <div>
              <strong style={{ color: "var(--ba-fg)" }}>{reservation.guestName || "Guest"}</strong>
            </div>
            <div style={{ color: "var(--ba-muted)" }}>
              {fmtClock(reservation.eventAt ?? reservation.bookedAt)} &middot;{" "}
              {fmtDate(reservation.eventAt ?? reservation.bookedAt)} &middot;{" "}
              {CENTERS[reservation.centerCode] ?? reservation.centerCode} &middot;{" "}
              {STATUS_LABELS[reservation.status] ?? reservation.status}
            </div>
          </div>

          {/* Kill switches — known from the mount probe, BEFORE staff fill anything in */}
          {editingOff && (
            <div style={AMBER_BLOCK}>
              <div style={{ fontWeight: 700 }}>Editing is switched off right now</div>
              <div style={{ color: "var(--ba-fg)", marginTop: 2 }}>
                You can preview changes and process refunds only. Ask Eric to turn it back on.
              </div>
            </div>
          )}
          {refundsOff && (
            <div style={AMBER_BLOCK}>
              <div style={{ fontWeight: 700 }}>
                Refunds for this visit are switched off right now
              </div>
              <div style={{ color: "var(--ba-fg)", marginTop: 2 }}>
                {capabilities?.blockedReason
                  ? splitEnvNote(capabilities.blockedReason).text
                  : "The preview is accurate — ask Eric to turn it back on."}
              </div>
            </div>
          )}

          {editNotice && <ErrorCopyBlock copy={editNotice} tone="amber" />}

          {managerBanner}

          {/* ── Bowling / KBF form ── */}
          {bowlingEditable && (
            <div style={SECTION}>
              <div style={SECTION_TITLE}>Players</div>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                <button
                  type="button"
                  style={STEP_BTN}
                  disabled={busy}
                  onClick={() => stepPlayers(-1)}
                >
                  −
                </button>
                <span
                  style={{
                    fontWeight: 700,
                    fontSize: "0.95rem",
                    minWidth: 24,
                    textAlign: "center",
                  }}
                >
                  {effPlayerCount}
                </span>
                <button
                  type="button"
                  style={STEP_BTN}
                  disabled={busy}
                  onClick={() => stepPlayers(1)}
                >
                  +
                </button>
                <span style={{ fontSize: "0.72rem", color: "var(--ba-muted)" }}>players</span>
              </div>
              {Array.from({ length: effPlayerCount }, (_, i) => {
                const slot = i + 1;
                const cur = current?.players.find((p) => p.slot === slot);
                const ov = form.players[slot] ?? {};
                return (
                  <div
                    key={slot}
                    style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 6 }}
                  >
                    <input
                      value={ov.name ?? cur?.name ?? ""}
                      placeholder={`Player ${slot}`}
                      disabled={busy}
                      onChange={(e) => setPlayerField(slot, { name: e.target.value })}
                      style={{ ...SMALL_INPUT, flex: 1, minWidth: 0 }}
                    />
                    <input
                      value={ov.shoeSize ?? cur?.shoeSize ?? ""}
                      placeholder="Shoe"
                      disabled={busy}
                      onChange={(e) => setPlayerField(slot, { shoeSize: e.target.value })}
                      style={{ ...SMALL_INPUT, width: 58 }}
                    />
                    <label
                      style={{
                        display: "flex",
                        gap: 4,
                        alignItems: "center",
                        fontSize: "0.68rem",
                        color: "var(--ba-muted)",
                        cursor: "pointer",
                        whiteSpace: "nowrap",
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={ov.bumpers ?? cur?.bumpers ?? false}
                        disabled={busy}
                        onChange={(e) => setPlayerField(slot, { bumpers: e.target.checked })}
                      />
                      bumpers
                    </label>
                  </div>
                );
              })}

              {current?.pricingMode === "per_lane" && (
                <>
                  <div style={{ ...SECTION_TITLE, marginTop: 12 }}>Lanes</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <button
                      type="button"
                      style={STEP_BTN}
                      disabled={busy}
                      onClick={() => stepLanes(-1)}
                    >
                      −
                    </button>
                    <span
                      style={{
                        fontWeight: 700,
                        fontSize: "0.95rem",
                        minWidth: 24,
                        textAlign: "center",
                      }}
                    >
                      {effLaneCount}
                    </span>
                    <button
                      type="button"
                      style={STEP_BTN}
                      disabled={busy}
                      onClick={() => stepLanes(1)}
                    >
                      +
                    </button>
                    <span style={{ fontSize: "0.72rem", color: "var(--ba-muted)" }}>lanes</span>
                  </div>
                </>
              )}

              {current && current.attractions.length > 0 && (
                <>
                  <div style={{ ...SECTION_TITLE, marginTop: 12 }}>Attraction add-ons</div>
                  {current.attractions.map((a) => {
                    const qty = form.attractions?.[a.index] ?? a.quantity;
                    const setQty = (next: number) =>
                      setForm((f) => ({
                        ...f,
                        attractions: { ...(f.attractions ?? {}), [a.index]: Math.max(0, next) },
                      }));
                    return (
                      <div
                        key={a.index}
                        style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}
                      >
                        <button
                          type="button"
                          style={STEP_BTN}
                          disabled={busy || !a.editable}
                          onClick={() => setQty(qty - 1)}
                        >
                          −
                        </button>
                        <span
                          style={{
                            fontWeight: 700,
                            fontSize: "0.95rem",
                            minWidth: 24,
                            textAlign: "center",
                          }}
                        >
                          {qty}
                        </span>
                        <button
                          type="button"
                          style={STEP_BTN}
                          disabled={busy || !a.editable}
                          onClick={() => setQty(qty + 1)}
                        >
                          +
                        </button>
                        <span style={{ fontSize: "0.75rem" }}>
                          {a.name}{" "}
                          <span style={{ color: "var(--ba-muted)" }}>
                            {a.timeLabel}
                            {a.editable ? "" : " — change this one in BMI"}
                          </span>
                        </span>
                      </div>
                    );
                  })}
                </>
              )}

              {current && current.durationOptions.length > 0 && (
                <>
                  <div style={{ ...SECTION_TITLE, marginTop: 12 }}>Lane time</div>
                  <select
                    aria-label="Lane time length"
                    disabled={busy}
                    value={
                      form.durationOptionId ??
                      current.durationOptions.find(
                        (d) => d.multiplier === current.durationMultiplier,
                      )?.id ??
                      ""
                    }
                    onChange={(e) =>
                      setForm((f) => ({
                        ...f,
                        durationOptionId: e.target.value ? Number(e.target.value) : null,
                      }))
                    }
                    style={{ ...SMALL_INPUT, width: 140 }}
                  >
                    {current.durationOptions.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.label}
                      </option>
                    ))}
                  </select>
                  <div style={{ fontSize: "0.68rem", color: "var(--ba-muted)", marginTop: 4 }}>
                    Changing lane time rebooks the Conqueror reservation at the same start.
                  </div>
                </>
              )}

              {current ? (
                current.shoeCatalog.length > 0 && (
                  <>
                    <div style={{ ...SECTION_TITLE, marginTop: 12 }}>Shoes</div>
                    {current.shoeCatalog.map((c) => {
                      const qty =
                        form.shoes?.[c.squareProductId] ??
                        current.shoes.find((s) => s.squareProductId === c.squareProductId)
                          ?.quantity ??
                        0;
                      return (
                        <div
                          key={c.squareProductId}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 10,
                            marginBottom: 6,
                          }}
                        >
                          <button
                            type="button"
                            style={STEP_BTN}
                            disabled={busy}
                            onClick={() => setShoeQty(c.squareProductId, qty - 1)}
                          >
                            −
                          </button>
                          <span style={{ fontWeight: 700, minWidth: 20, textAlign: "center" }}>
                            {qty}
                          </span>
                          <button
                            type="button"
                            style={STEP_BTN}
                            disabled={busy}
                            onClick={() => setShoeQty(c.squareProductId, qty + 1)}
                          >
                            +
                          </button>
                          <span style={{ fontSize: "0.75rem", color: "var(--ba-fg)", flex: 1 }}>
                            {c.label}
                          </span>
                          <span style={{ fontSize: "0.72rem", color: "var(--ba-muted)" }}>
                            {dollars(c.priceCents)}
                          </span>
                        </div>
                      );
                    })}
                  </>
                )
              ) : (
                <div
                  style={{
                    fontSize: "0.7rem",
                    color: "var(--ba-muted)",
                    marginTop: 10,
                    lineHeight: 1.5,
                  }}
                >
                  Lane and shoe options load with the first price check — change something above to
                  load them.
                </div>
              )}
            </div>
          )}

          {/* ── Race / attraction / combo racers form ── */}
          {racersEditable && (
            <div style={SECTION}>
              {displayHeats.length > 0 && (
                <>
                  <div style={SECTION_TITLE}>Booked heats</div>
                  {displayHeats.map((h) => (
                    <label
                      key={h.index}
                      style={{
                        display: "flex",
                        gap: 8,
                        alignItems: "center",
                        fontSize: "0.78rem",
                        color: form.removeHeatIndexes.includes(h.index)
                          ? "#ef4444"
                          : "var(--ba-fg)",
                        marginBottom: 6,
                        cursor: "pointer",
                        textDecoration: form.removeHeatIndexes.includes(h.index)
                          ? "line-through"
                          : "none",
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={form.removeHeatIndexes.includes(h.index)}
                        disabled={busy}
                        onChange={() => toggleRemoveHeat(h.index)}
                      />
                      <span style={{ flex: 1 }}>{h.label}</span>
                      <span style={{ fontSize: "0.65rem", color: "var(--ba-muted)" }}>remove</span>
                    </label>
                  ))}
                </>
              )}
              {/* Refund intent hides this whole block (racersEditable), so no
                  extra guard here — growing a settled booking is an INCREASE,
                  which means rebuilding a frozen order, not a refund. */}
              <>
                <div style={{ ...SECTION_TITLE, marginTop: displayHeats.length > 0 ? 12 : 0 }}>
                  Add racers
                </div>
                {form.addRacers.map((row, i) => (
                  <div
                    key={i}
                    style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 6 }}
                  >
                    <input
                      value={row.firstName}
                      placeholder="First name"
                      disabled={busy}
                      onChange={(e) => patchRacerRow(i, { firstName: e.target.value })}
                      style={{ ...SMALL_INPUT, flex: 1, minWidth: 0 }}
                    />
                    <select
                      value={row.category}
                      disabled={busy}
                      onChange={(e) =>
                        patchRacerRow(i, {
                          category: e.target.value === "junior" ? "junior" : "adult",
                        })
                      }
                      style={{ ...SMALL_INPUT, width: 84 }}
                    >
                      <option value="adult">Adult</option>
                      <option value="junior">Junior</option>
                    </select>
                    <label
                      style={{
                        display: "flex",
                        gap: 4,
                        alignItems: "center",
                        fontSize: "0.68rem",
                        color: "var(--ba-muted)",
                        cursor: "pointer",
                        whiteSpace: "nowrap",
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={row.isNew}
                        disabled={busy}
                        onChange={(e) => patchRacerRow(i, { isNew: e.target.checked })}
                      />
                      new racer
                    </label>
                    <button
                      type="button"
                      onClick={() => dropRacerRow(i)}
                      disabled={busy}
                      aria-label="Remove row"
                      style={{
                        background: "none",
                        border: "none",
                        color: "var(--ba-muted)",
                        cursor: "pointer",
                        fontSize: "1rem",
                      }}
                    >
                      &times;
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  style={{ ...NAV_BTN, fontSize: "0.72rem" }}
                  disabled={busy}
                  onClick={addRacerRow}
                >
                  + Add racer
                </button>
              </>
            </div>
          )}

          {/* ── Day-of order lines ──
               Kind-agnostic ON PURPOSE. The server decides per line what may
               be touched (`editable`, one rule shared with applyOrderLineSpec),
               so this renders wherever the live order has a returnable line —
               food on a bowling order, a race pack on a racing order. Gating it
               to bowling hid the ONLY refund control a settled race has: its
               heats can't be repriced off a frozen order, but the pack line can
               be returned, which is exactly what a refund is. */}
          {current && current.orderLines.some((l) => l.editable) && (
            <div style={SECTION}>
              <div style={SECTION_TITLE}>
                {intent === "refund" ? "What are you refunding?" : "Charges on the day-of order"}
              </div>
              <div style={{ fontSize: "0.7rem", color: "var(--ba-muted)", marginBottom: 6 }}>
                {intent === "refund"
                  ? "Add the quantity you want to refund on each line, up to what the guest was charged for."
                  : "Set a quantity to 0 to return that line and refund it."}
              </div>
              {current.orderLines
                .filter((l) => l.editable)
                .map((l) => {
                  // The engine's contract is the DESIRED END STATE — how many of
                  // this line survive. On a refund screen that reads backwards
                  // ("set 2 to refund 1"), so refund intent counts UP from zero:
                  // the number shown IS the quantity being refunded. Only the
                  // display and the handler invert; the spec still carries the
                  // remaining quantity, so buildSpec and the server are unchanged.
                  const remaining = form.orderLines?.[l.uid] ?? l.quantity;
                  const refunding = intent === "refund";
                  const shown = refunding ? l.quantity - remaining : remaining;
                  const setShown = (next: number) => {
                    const clamped = Math.min(l.quantity, Math.max(0, next));
                    setForm((f) => ({
                      ...f,
                      orderLines: {
                        ...(f.orderLines ?? {}),
                        [l.uid]: refunding ? l.quantity - clamped : clamped,
                      },
                    }));
                  };
                  return (
                    <div
                      key={l.uid}
                      style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}
                    >
                      <button
                        type="button"
                        aria-label={refunding ? `Refund one fewer ${l.name}` : `Decrease ${l.name}`}
                        style={STEP_BTN}
                        disabled={busy || shown <= 0}
                        onClick={() => setShown(shown - 1)}
                      >
                        −
                      </button>
                      <span
                        style={{
                          fontWeight: 700,
                          fontSize: "0.95rem",
                          minWidth: 24,
                          textAlign: "center",
                          color: refunding && shown > 0 ? "#ef4444" : undefined,
                        }}
                      >
                        {shown}
                      </span>
                      <button
                        type="button"
                        aria-label={refunding ? `Refund one more ${l.name}` : `Increase ${l.name}`}
                        style={STEP_BTN}
                        disabled={busy || shown >= l.quantity}
                        onClick={() => setShown(shown + 1)}
                      >
                        +
                      </button>
                      <span style={{ fontSize: "0.75rem" }}>
                        {l.name}{" "}
                        <span style={{ color: "var(--ba-muted)" }}>
                          ${(l.unitPriceCents / 100).toFixed(2)} ea
                          {refunding
                            ? ` · ${l.quantity} on the bill${
                                shown > 0 ? ` — refunding ${shown}` : ""
                              }`
                            : shown === 0
                              ? " — will be returned"
                              : ""}
                        </span>
                      </span>
                    </div>
                  );
                })}
            </div>
          )}

          {/* Refund intent renders only the list above, so say something when it
              is empty rather than showing a modal with nothing in it. */}
          {intent === "refund" && current && !current.orderLines.some((l) => l.editable) && (
            <div style={{ ...SECTION, fontSize: "0.78rem", lineHeight: 1.6 }}>
              <div style={SECTION_TITLE}>What are you refunding?</div>
              <div style={{ color: "var(--ba-muted)" }}>
                Nothing on this visit&rsquo;s day-of order can be refunded from here
                {current.orderLines.length > 0
                  ? " — every line on it is $0.00 (shoe-size markers and comped items carry no money)."
                  : " — the order has no line items."}{" "}
                Refund it in Square directly.
              </div>
            </div>
          )}

          {/* ── Live quote panel ── */}
          <div style={SECTION}>
            <div style={SECTION_TITLE}>Price</div>

            {plan != null && plan.planHash === refreshedHash && (
              <div
                style={{ ...AMBER_BLOCK, marginBottom: 8, fontSize: "0.72rem", fontWeight: 600 }}
              >
                Prices refreshed — review the updated quote before executing.
              </div>
            )}

            {specEmpty && !plan && !planLoading && (
              <div style={{ fontSize: "0.78rem", color: "var(--ba-muted)" }}>
                No changes yet — adjust the reservation above to price them.
              </div>
            )}

            {planLoading && (
              <div style={{ fontSize: "0.78rem", color: "var(--ba-muted)" }}>Repricing...</div>
            )}

            {!planLoading &&
              planError &&
              planError.code !== "no_changes" &&
              planError.code !== "post_complete_ack_required" && (
                <ErrorCopyBlock copy={describeEditError(planError)} tone="amber" />
              )}
            {!planLoading && planError?.code === "no_changes" && !specEmpty && (
              <div style={{ fontSize: "0.78rem", color: "var(--ba-muted)" }}>
                These changes leave the reservation exactly as booked — nothing to do.
              </div>
            )}
            {!planLoading && driftAck && (
              <div style={{ fontSize: "0.78rem", color: "var(--ba-muted)" }}>
                Confirm the manager check above to price this change.
              </div>
            )}

            {!planLoading && plan && (
              <>
                {/* Old → new line diff, per leg */}
                {plan.legs.map((leg) => (
                  <div key={leg.reservationId} style={{ marginBottom: 8 }}>
                    {plan.legs.length > 1 && (
                      <div
                        style={{ fontSize: "0.68rem", color: "var(--ba-muted)", marginBottom: 4 }}
                      >
                        {leg.productKind} #{leg.reservationId}
                      </div>
                    )}
                    <table
                      style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.72rem" }}
                    >
                      <thead>
                        <tr style={{ color: "var(--ba-muted)" }}>
                          <th style={{ textAlign: "left", fontWeight: 600, paddingBottom: 4 }}>
                            Item
                          </th>
                          <th style={{ textAlign: "right", fontWeight: 600, paddingBottom: 4 }}>
                            Now
                          </th>
                          <th style={{ textAlign: "right", fontWeight: 600, paddingBottom: 4 }}>
                            After
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {buildDiffRows(leg.oldLines, leg.newLines).map((row, i) => (
                          <tr
                            key={i}
                            style={{
                              color: row.changed ? "var(--ba-fg)" : "var(--ba-muted)",
                              fontWeight: row.changed ? 600 : 400,
                            }}
                          >
                            <td style={{ padding: "2px 0" }}>{row.name}</td>
                            <td
                              style={{
                                textAlign: "right",
                                whiteSpace: "nowrap",
                                padding: "2px 0 2px 10px",
                              }}
                            >
                              {row.oldQty != null && row.oldTotalCents != null
                                ? `${row.oldQty} · ${dollars(row.oldTotalCents)}`
                                : "—"}
                            </td>
                            <td
                              style={{
                                textAlign: "right",
                                whiteSpace: "nowrap",
                                padding: "2px 0 2px 10px",
                              }}
                            >
                              {row.newQty != null && row.newTotalCents != null
                                ? `${row.newQty} · ${dollars(row.newTotalCents)}`
                                : "—"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ))}

                {/* Delta chip */}
                <div
                  style={{ display: "flex", alignItems: "center", gap: 8, margin: "6px 0 10px" }}
                >
                  <span
                    style={{
                      padding: "2px 10px",
                      borderRadius: 999,
                      fontWeight: 700,
                      fontSize: "0.78rem",
                      backgroundColor:
                        plan.diffCents > 0
                          ? "rgba(245,158,11,0.15)"
                          : plan.diffCents < 0
                            ? "rgba(34,197,94,0.15)"
                            : "var(--ba-muted2)",
                      color:
                        plan.diffCents > 0
                          ? ACCENT
                          : plan.diffCents < 0
                            ? "#22c55e"
                            : "var(--ba-muted)",
                    }}
                  >
                    {plan.diffCents > 0
                      ? `+${dollars(plan.diffCents)}`
                      : plan.diffCents < 0
                        ? `−${dollars(-plan.diffCents)}`
                        : "No price change"}
                  </span>
                  <span style={{ fontSize: "0.68rem", color: "var(--ba-muted)" }}>
                    {plan.diffCents > 0
                      ? "due now"
                      : plan.diffCents < 0
                        ? "back to the guest"
                        : "lines change, money doesn't"}
                  </span>
                </div>

                {/* Environment refusal — prominent, not fine print. The preview
                    above is still accurate; only running it is switched off. */}
                {blockedNote && (
                  <div
                    style={{ ...AMBER_BLOCK, marginBottom: 10 }}
                    title={blockedNote.envNote ?? undefined}
                  >
                    <div style={{ fontWeight: 700 }}>
                      Preview only — this can&rsquo;t run right now
                    </div>
                    <div style={{ color: "var(--ba-fg)", marginTop: 2 }}>{blockedNote.text}</div>
                  </div>
                )}

                {/* Warnings (manager ones live in the banner above) */}
                {otherWarnings.length > 0 && (
                  <div style={{ fontSize: "0.7rem", lineHeight: 1.5, marginBottom: 10 }}>
                    {otherWarnings.map((w, i) => (
                      <div key={i} style={{ color: WARNING_COLORS[w.severity] }}>
                        {w.message}
                      </div>
                    ))}
                  </div>
                )}

                {/* Money direction */}
                {plan.diffCents > 0 &&
                  (plan.chargeCard ? (
                    <div
                      style={{
                        padding: "0.5rem 0.75rem",
                        borderRadius: 8,
                        backgroundColor: "rgba(34,197,94,0.08)",
                        border: "1px solid rgba(34,197,94,0.3)",
                        fontSize: "0.75rem",
                        color: "#22c55e",
                        marginBottom: 10,
                        lineHeight: 1.5,
                        fontWeight: 600,
                      }}
                    >
                      Will charge {plan.chargeCard.brand} •{plan.chargeCard.last4} on file:{" "}
                      {dollars(plan.diffCents)} → added to the reservation deposit
                    </div>
                  ) : (
                    <div style={{ ...AMBER_BLOCK, marginBottom: 10, fontWeight: 600 }}>
                      No card on file — you&rsquo;ll get a secure payment link for the guest; the
                      edit completes when they pay.
                    </div>
                  ))}

                {plan.diffCents < 0 && (
                  <>
                    {pickRow(
                      "card_refund",
                      "Refund to original payment",
                      `${dollars(-plan.diffCents)} back to the original payment in 3-5 business days.`,
                      "#ef4444",
                    )}
                    {pickRow(
                      "store_credit",
                      "HeadPinz FastTrax Gift Card",
                      `Issue a ${dollars(-plan.diffCents)} HeadPinz FastTrax Gift Card the guest can spend online or in center.`,
                      "#22c55e",
                    )}

                    {needsDayofReason && (
                      <div style={{ marginTop: 10 }}>
                        <label
                          htmlFor="dayof-refund-reason"
                          style={{
                            display: "block",
                            fontSize: "0.75rem",
                            fontWeight: 700,
                            marginBottom: 4,
                          }}
                        >
                          Why is this being refunded?
                        </label>
                        <input
                          id="dayof-refund-reason"
                          type="text"
                          value={dayofRefundReason}
                          disabled={busy}
                          maxLength={120}
                          placeholder="e.g. Pizza returned unmade — lane 6"
                          onChange={(e) => {
                            setEditNotice(null);
                            setDayofRefundReason(e.target.value);
                          }}
                          style={{ ...SMALL_INPUT, width: "100%" }}
                        />
                        <div
                          style={{
                            fontSize: "0.68rem",
                            color: "var(--ba-muted)",
                            marginTop: 4,
                          }}
                        >
                          Recorded on the Square refund for the day-of charge and read by
                          accounting. Required.
                        </div>
                      </div>
                    )}
                  </>
                )}
              </>
            )}
          </div>

          {/* Notify + actions */}
          {isRace ? (
            <div
              style={{
                fontSize: "0.72rem",
                color: "var(--ba-muted)",
                margin: "0 2px 10px",
                lineHeight: 1.45,
              }}
            >
              Racing/attraction confirmations can&rsquo;t be resent automatically — contact the
              guest.
            </div>
          ) : (
            <label
              style={{
                display: "flex",
                gap: 8,
                alignItems: "flex-start",
                fontSize: "0.75rem",
                color: "var(--ba-muted)",
                margin: "0 2px 10px",
                cursor: "pointer",
                lineHeight: 1.45,
              }}
            >
              <input
                type="checkbox"
                checked={notifyGuest}
                disabled={busy}
                onChange={(e) => {
                  setNotifyTouched(true);
                  setNotifyChoice(e.target.checked);
                }}
                style={{ marginTop: 2 }}
              />
              <span>{notifyLabel({ intent, phase: planPhase })}</span>
            </label>
          )}

          <div
            style={{ display: "flex", gap: 8, justifyContent: "flex-end", alignItems: "center" }}
          >
            {!gate.enabled && gate.reason && plan && !plan.executionBlocked && (
              <span style={{ fontSize: "0.7rem", color: "var(--ba-muted)", marginRight: "auto" }}>
                {gate.reason}
              </span>
            )}
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              style={{ ...NAV_BTN, fontSize: "0.8rem" }}
            >
              Close
            </button>
            <button
              type="button"
              onClick={() => void runExecute()}
              disabled={busy || !gate.enabled}
              style={{
                ...PRIMARY_BTN,
                cursor: busy || !gate.enabled ? "not-allowed" : "pointer",
                backgroundColor: executeColor,
                opacity: busy || !gate.enabled ? 0.5 : 1,
              }}
            >
              {executeLabel}
            </button>
          </div>
        </>
      )}

      {phase === "success" && result && (
        <>
          <div
            style={{
              padding: "0.75rem",
              borderRadius: 10,
              backgroundColor:
                result.state === "pending_payment"
                  ? "rgba(245,158,11,0.08)"
                  : "rgba(34,197,94,0.08)",
              border:
                result.state === "pending_payment"
                  ? "1px solid rgba(245,158,11,0.3)"
                  : "1px solid rgba(34,197,94,0.3)",
              marginBottom: "0.9rem",
              fontSize: "0.85rem",
              color: "var(--ba-fg)",
              lineHeight: 1.6,
            }}
          >
            {result.state === "pending_payment" ? (
              <>
                <div style={{ fontWeight: 700, color: ACCENT }}>
                  Payment link created — send it to the guest (they also get a text/email if we have
                  their contact)
                </div>
                <div style={{ marginTop: 4, color: "var(--ba-muted)", fontSize: "0.78rem" }}>
                  The edit completes automatically when the guest pays {dollars(result.diffCents)}.
                </div>
                {result.paymentLinkUrl ? (
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      marginTop: 8,
                      flexWrap: "wrap",
                    }}
                  >
                    <span
                      style={{
                        fontFamily: "ui-monospace, monospace",
                        fontSize: "0.78rem",
                        fontWeight: 700,
                        wordBreak: "break-all",
                        flex: "1 1 200px",
                      }}
                    >
                      {result.paymentLinkUrl}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        void navigator.clipboard.writeText(result.paymentLinkUrl!).then(() => {
                          setLinkCopied(true);
                          setTimeout(() => setLinkCopied(false), 1500);
                        });
                      }}
                      style={{ ...NAV_BTN, fontSize: "0.7rem", padding: "0.25rem 0.6rem" }}
                    >
                      {linkCopied ? "Copied" : "Copy"}
                    </button>
                    <a
                      href={result.paymentLinkUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{
                        ...NAV_BTN,
                        fontSize: "0.7rem",
                        padding: "0.25rem 0.6rem",
                        textDecoration: "none",
                        display: "inline-block",
                      }}
                    >
                      Open ↗
                    </a>
                  </div>
                ) : (
                  <div style={{ marginTop: 6, color: "#ef4444", fontSize: "0.78rem" }}>
                    The link URL was not returned — find it in History (edit {result.editId}) or ask
                    support.
                  </div>
                )}
                <div style={{ marginTop: 6, color: "var(--ba-muted)", fontSize: "0.68rem" }}>
                  Edit id{" "}
                  <span style={{ fontFamily: "ui-monospace, monospace" }}>{result.editId}</span>
                </div>
              </>
            ) : (
              <>
                <div style={{ fontWeight: 700, color: "#22c55e" }}>Reservation updated.</div>
                {result.diffCents > 0 && (
                  <div style={{ marginTop: 4, color: "var(--ba-muted)", fontSize: "0.78rem" }}>
                    Charged {dollars(result.diffCents)}
                    {result.paymentIds[0] ? (
                      <span style={{ fontFamily: "monospace" }}>
                        {" "}
                        &middot; {result.paymentIds[0]}
                      </span>
                    ) : null}
                  </div>
                )}
                {result.diffCents < 0 &&
                  (result.storeCreditGan ? (
                    <div style={{ marginTop: 8 }}>
                      <div
                        style={{
                          fontSize: "0.68rem",
                          textTransform: "uppercase",
                          letterSpacing: 1,
                          color: "var(--ba-muted)",
                        }}
                      >
                        HeadPinz FastTrax Gift Card &middot; {dollars(-result.diffCents)}
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
                        <span
                          style={{ fontFamily: "monospace", fontSize: "1.05rem", fontWeight: 700 }}
                        >
                          {ganDisplay(result.storeCreditGan)}
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            void navigator.clipboard.writeText(result.storeCreditGan!).then(() => {
                              setGanCopied(true);
                              setTimeout(() => setGanCopied(false), 1500);
                            });
                          }}
                          style={{ ...NAV_BTN, fontSize: "0.7rem", padding: "0.25rem 0.6rem" }}
                        >
                          {ganCopied ? "Copied" : "Copy"}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div style={{ marginTop: 4, color: "var(--ba-muted)", fontSize: "0.78rem" }}>
                      Refunded {dollars(-result.diffCents)}
                      {result.refundIds[0] ? (
                        <span style={{ fontFamily: "monospace" }}>
                          {" "}
                          &middot; {result.refundIds[0]}
                        </span>
                      ) : null}
                    </div>
                  ))}
              </>
            )}
            {resultWarnings.length > 0 && (
              <div style={{ marginTop: 8, fontSize: "0.7rem", lineHeight: 1.5 }}>
                {resultWarnings.map((w, i) => (
                  <div key={i} style={{ color: WARNING_COLORS[w.severity] }}>
                    {w.message}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* By-hand follow-ups — red, titled, one line per system. Never a
              0.7rem amber line under a green "updated". */}
          {manualSteps.length > 0 && (
            <div style={{ ...RED_BLOCK, fontSize: "0.8rem" }}>
              <div style={{ fontWeight: 700 }}>Not updated automatically — do this by hand</div>
              <ul style={{ margin: "6px 0 0", paddingLeft: 18, color: "var(--ba-fg)" }}>
                {manualSteps.map((s, i) => (
                  <li key={i} style={{ marginBottom: 4 }}>
                    <SystemBadge system={s.system} />
                    {s.message}
                    {s.predicted && (
                      <span style={{ color: "var(--ba-muted)", fontSize: "0.7rem" }}>
                        {" "}
                        — acknowledged before the edit
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button
              type="button"
              onClick={finish}
              style={{
                ...PRIMARY_BTN,
                padding: "0.5rem 1.5rem",
                backgroundColor:
                  manualSteps.length > 0
                    ? "#ef4444"
                    : result.state === "pending_payment"
                      ? ACCENT
                      : "#22c55e",
              }}
            >
              {manualSteps.length > 0 ? "I will make these changes" : "Done"}
            </button>
          </div>
        </>
      )}

      {phase === "blocked" && (
        <>
          {ackRequired && !postCompleteAcked
            ? postCompleteGate(() => {
                givePostCompleteAck();
                setPhase("loading");
                void probe(true);
              })
            : blockCopy && <ErrorCopyBlock copy={blockCopy} tone="red" />}
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button type="button" onClick={onClose} style={{ ...NAV_BTN, fontSize: "0.8rem" }}>
              Close
            </button>
          </div>
        </>
      )}

      {phase === "error" && errCopy && (
        <>
          <ErrorCopyBlock copy={errCopy} tone="red" />
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
            <button type="button" onClick={onClose} style={{ ...NAV_BTN, fontSize: "0.8rem" }}>
              Close
            </button>
            {errorCtx === "execute" && offerLink && (
              <button
                type="button"
                onClick={() => {
                  setPhase("edit");
                  void runExecute({ kind: "payment_link" });
                }}
                style={{
                  ...NAV_BTN,
                  fontSize: "0.8rem",
                  color: ACCENT,
                  borderColor: "rgba(245,158,11,0.4)",
                }}
              >
                Send payment link
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                if (errorCtx === "mount") {
                  setPhase("loading");
                  void probe(postCompleteAcked);
                } else {
                  setPhase("edit");
                  void runExecute();
                }
              }}
              style={PRIMARY_BTN}
            >
              {errorCtx === "mount" ? "Try Again" : "Retry"}
            </button>
          </div>
        </>
      )}
    </ModalShell>
  );
}
