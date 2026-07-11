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
 * the form initializes from the board row; the first real change hydrates
 * lane/shoe/roster facts from plan.current. Money is NEVER computed here —
 * only server cents are rendered.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { CENTERS, STATUS_LABELS } from "~/features/reservations-admin/constants";
import { dollars, fmtClock, fmtDate, ganDisplay } from "~/features/reservations-admin/format";
import type { Reservation } from "~/features/reservations-admin/types";
import type { EditCurrentState } from "~/features/reservation-edit/plan";
import type { EditPaymentSource, EditSettlement } from "~/features/reservation-edit/types";
import type { EditResult } from "~/features/reservation-edit/service";
import ModalShell from "../ModalShell";
import { INPUT_STYLE, NAV_BTN } from "../theme";
import {
  buildDiffRows,
  buildSpec,
  classifyExecuteFailure,
  classifyMountOutcome,
  emptyForm,
  executeGate,
  isEmptySpec,
  planNeedsManagerAck,
  resultSummary,
  WARNING_COLORS,
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

/** Heats list before the first plan arrives — from the board row's metadata. */
const heatsFromBoard = (r: Reservation): Array<{ index: number; label: string }> =>
  (r.bookingMetadata?.heats ?? []).map((h, index) => ({
    index,
    label: `${h.assignedTo || "Racer"}${h.heatId ? ` — ${fmtClock(h.heatId)}` : ""}`,
  }));

export default function EditReservationModal({
  reservation,
  token,
  onClose,
  onDone,
}: {
  reservation: Reservation;
  token: string;
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const [phase, setPhase] = useState<"loading" | "edit" | "busy" | "success" | "blocked" | "error">(
    "loading",
  );
  const [form, setForm] = useState<EditFormState>(emptyForm);
  const [current, setCurrent] = useState<EditCurrentState | null>(null);
  const [refundDest, setRefundDest] = useState<EditSettlement | null>(null);
  const [notifyGuest, setNotifyGuest] = useState(true);
  /** Post-complete: the mount probe demanded a manager acknowledgment. */
  const [ackRequired, setAckRequired] = useState(false);
  /** Sticky "manager has acknowledged once" — sent on every dry-run. */
  const [ackGiven, setAckGiven] = useState(false);
  /** Live checkbox state — gates EXECUTE only. */
  const [acked, setAcked] = useState(false);
  const [result, setResult] = useState<EditResult | null>(null);
  const [blockMsg, setBlockMsg] = useState<string | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [errorCtx, setErrorCtx] = useState<"mount" | "execute">("mount");
  const [offerLink, setOfferLink] = useState(false);
  const [refreshedNotice, setRefreshedNotice] = useState(false);
  const [ganCopied, setGanCopied] = useState(false);
  const [idCopied, setIdCopied] = useState(false);

  const { plan, planError, planLoading, requestPlan, clearPlan, execute } = useEditPlan(
    reservation.id,
    token,
  );

  const isCombo = !!reservation.comboSpecialId;
  const isRace = reservation.productKind === "race" || reservation.productKind === "attraction";
  const bowlingEditable = !isCombo && !isRace;
  const racersEditable = isRace || isCombo;

  const basePlayerCount = current?.playerCount ?? reservation.playerCount ?? 1;
  const effPlayerCount = form.playerCount ?? basePlayerCount;
  const effLaneCount = form.laneCount ?? current?.laneCount ?? 1;

  const spec = useMemo(
    () => buildSpec(form, basePlayerCount, current),
    [form, basePlayerCount, current],
  );
  const specEmpty = isEmptySpec(spec);
  const specJson = JSON.stringify(spec);
  const requestKey = `${specJson}|${refundDest ?? ""}`;
  const lastKey = useRef<string | null>(null);

  /* ── Mount probe (empty spec — no_changes means "editable") ─────────── */
  const probe = useCallback(
    async (managerOverride: boolean) => {
      setPhase("loading");
      const r = await requestPlan({}, { immediate: true, managerOverride });
      if (r.kind === "superseded") return;
      const outcome = classifyMountOutcome(r);
      if (outcome.kind === "edit") {
        setPhase("edit");
      } else if (outcome.kind === "ack_required") {
        setAckRequired(true);
        setPhase("blocked");
      } else if (outcome.kind === "blocked") {
        setBlockMsg(outcome.message);
        setPhase("blocked");
      } else {
        setErrMsg(outcome.message);
        setErrorCtx("mount");
        setPhase("error");
      }
    },
    [requestPlan],
  );

  useEffect(() => {
    void probe(false);
    // Mount-only — the modal is keyed by reservation id upstream.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ── Cache plan.current so the form stays hydrated across no_changes ── */
  useEffect(() => {
    if (plan) {
      setCurrent(plan.current);
      if (planNeedsManagerAck(plan)) setAckRequired(true);
    }
  }, [plan]);

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
    setRefreshedNotice(false);
    void requestPlan(spec, {
      settlement: refundDest ?? undefined,
      managerOverride: ackGiven || undefined,
    });
  }, [phase, requestKey, specEmpty, spec, refundDest, ackGiven, requestPlan, clearPlan]);

  /* ── Execute ──────────────────────────────────────────────────────────── */
  const handleExecuteFailure = useCallback(
    async (error: { status: number; code: string; detail: string | null }, diffCents: number) => {
      const action = classifyExecuteFailure(error, diffCents);
      if (action.kind === "refresh_plan") {
        setRefreshedNotice(true);
        lastKey.current = requestKey;
        await requestPlan(spec, {
          settlement: refundDest ?? undefined,
          managerOverride: ackGiven || undefined,
          immediate: true,
        });
        setPhase("edit");
        return;
      }
      if (action.kind === "blocked") {
        setBlockMsg(action.message);
        setPhase("blocked");
        return;
      }
      setErrMsg(action.message);
      setOfferLink(action.offerPaymentLink);
      setErrorCtx("execute");
      setPhase("error");
    },
    [requestKey, requestPlan, spec, refundDest, ackGiven],
  );

  const runExecute = useCallback(
    async (overrideSource?: EditPaymentSource) => {
      const activePlan = plan;
      if (!activePlan) return;
      setPhase("busy");
      const settlementOpt = activePlan.diffCents < 0 ? (refundDest ?? undefined) : undefined;
      const managerOverride = ackGiven && acked ? true : undefined;
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
        const pre = await requestPlan(spec, {
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
      ackGiven,
      acked,
      spec,
      notifyGuest,
      requestPlan,
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
  const addRacerRow = () =>
    setForm((f) => ({
      ...f,
      addRacers: [...f.addRacers, { firstName: "", category: "adult", isNew: false }],
    }));
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

  /* ── Derived view state ──────────────────────────────────────────────── */
  const needsAck = ackRequired || planNeedsManagerAck(plan);
  const gate = executeGate({
    plan,
    planLoading,
    refundDest,
    needsManagerAck: needsAck,
    managerAcked: acked,
  });
  const busy = phase === "busy";
  const managerWarnings = (plan?.warnings ?? []).filter((w) => w.severity === "manager");
  const otherWarnings = (plan?.warnings ?? []).filter((w) => w.severity !== "manager");
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

  const managerBanner = needsAck && (
    <div
      style={{
        padding: "0.6rem 0.75rem",
        borderRadius: 8,
        backgroundColor: "rgba(239,68,68,0.12)",
        border: "1px solid rgba(239,68,68,0.3)",
        fontSize: "0.75rem",
        color: "#ef4444",
        marginBottom: "0.9rem",
        lineHeight: 1.5,
      }}
    >
      <div style={{ fontWeight: 700 }}>Manager check required</div>
      {managerWarnings.length > 0 ? (
        managerWarnings.map((w, i) => <div key={i}>{w.message}</div>)
      ) : (
        <div>
          Day-of order already closed — QAMF and BMI will NOT be updated. Adjust Conqueror/BMI
          manually.
        </div>
      )}
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
          checked={acked}
          disabled={busy}
          onChange={(e) => {
            setAcked(e.target.checked);
            if (e.target.checked) setAckGiven(true);
          }}
          style={{ marginTop: 2 }}
        />
        <span>I understand — QAMF/BMI will NOT be updated</span>
      </label>
    </div>
  );

  const executeLabel = busy
    ? "Working..."
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
          alignItems: "center",
          marginBottom: "1rem",
        }}
      >
        <h3 style={{ fontSize: "1rem", fontWeight: 700, color: ACCENT, margin: 0 }}>
          {isCombo ? "Edit VIP Combo — racers" : "Edit Reservation"}
        </h3>
        <button
          type="button"
          onClick={onClose}
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
            </div>
          )}

          {/* ── Live quote panel ── */}
          <div style={SECTION}>
            <div style={SECTION_TITLE}>Price</div>

            {refreshedNotice && (
              <div
                style={{
                  padding: "0.5rem 0.75rem",
                  borderRadius: 8,
                  backgroundColor: "rgba(245,158,11,0.1)",
                  border: "1px solid rgba(245,158,11,0.25)",
                  fontSize: "0.72rem",
                  color: ACCENT,
                  marginBottom: 8,
                  fontWeight: 600,
                }}
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

            {!planLoading && planError && planError.code !== "no_changes" && (
              <div
                style={{
                  padding: "0.5rem 0.75rem",
                  borderRadius: 8,
                  backgroundColor: "rgba(245,158,11,0.1)",
                  border: "1px solid rgba(245,158,11,0.25)",
                  fontSize: "0.72rem",
                  color: ACCENT,
                  lineHeight: 1.5,
                }}
              >
                {planError.detail || planError.code}
              </div>
            )}
            {!planLoading && planError?.code === "no_changes" && !specEmpty && (
              <div style={{ fontSize: "0.78rem", color: "var(--ba-muted)" }}>
                These changes leave the reservation exactly as booked — nothing to do.
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
                    <div
                      style={{
                        padding: "0.5rem 0.75rem",
                        borderRadius: 8,
                        backgroundColor: "rgba(245,158,11,0.1)",
                        border: "1px solid rgba(245,158,11,0.25)",
                        fontSize: "0.75rem",
                        color: ACCENT,
                        marginBottom: 10,
                        lineHeight: 1.5,
                        fontWeight: 600,
                      }}
                    >
                      No card on file — collect payment via link. The guest pays on a secure page
                      and the edit completes automatically.
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
                  </>
                )}
              </>
            )}
          </div>

          {/* Notify + actions */}
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
              onChange={(e) => setNotifyGuest(e.target.checked)}
              style={{ marginTop: 2 }}
            />
            <span>Email &amp; text the updated confirmation to the guest</span>
          </label>

          <div
            style={{ display: "flex", gap: 8, justifyContent: "flex-end", alignItems: "center" }}
          >
            {!gate.enabled && gate.reason && plan && (
              <span style={{ fontSize: "0.68rem", color: "var(--ba-muted)", marginRight: "auto" }}>
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
                padding: "0.5rem 1.25rem",
                borderRadius: 8,
                fontSize: "0.8rem",
                fontWeight: 700,
                cursor: busy || !gate.enabled ? "not-allowed" : "pointer",
                border: "none",
                backgroundColor: executeColor,
                color: "#fff",
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
                  Payment link created — send it to the guest.
                </div>
                <div style={{ marginTop: 4, color: "var(--ba-muted)", fontSize: "0.78rem" }}>
                  The edit completes automatically when the guest pays {dollars(result.diffCents)}.
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
                  <span style={{ fontFamily: "monospace", fontSize: "0.85rem", fontWeight: 700 }}>
                    {result.editId}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      void navigator.clipboard.writeText(result.editId).then(() => {
                        setIdCopied(true);
                        setTimeout(() => setIdCopied(false), 1500);
                      });
                    }}
                    style={{ ...NAV_BTN, fontSize: "0.7rem", padding: "0.25rem 0.6rem" }}
                  >
                    {idCopied ? "Copied" : "Copy"}
                  </button>
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
            {result.warnings.length > 0 && (
              <div style={{ marginTop: 8, fontSize: "0.7rem", lineHeight: 1.5 }}>
                {result.warnings.map((w, i) => (
                  <div key={i} style={{ color: WARNING_COLORS[w.severity] }}>
                    {w.message}
                  </div>
                ))}
              </div>
            )}
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button
              type="button"
              onClick={finish}
              style={{
                padding: "0.5rem 1.5rem",
                borderRadius: 8,
                fontSize: "0.8rem",
                fontWeight: 700,
                cursor: "pointer",
                border: "none",
                backgroundColor: result.state === "pending_payment" ? ACCENT : "#22c55e",
                color: "#fff",
              }}
            >
              Done
            </button>
          </div>
        </>
      )}

      {phase === "blocked" && (
        <>
          {ackRequired && !ackGiven ? (
            <div
              style={{
                padding: "0.6rem 0.75rem",
                borderRadius: 8,
                backgroundColor: "rgba(239,68,68,0.12)",
                border: "1px solid rgba(239,68,68,0.3)",
                fontSize: "0.78rem",
                color: "#ef4444",
                marginBottom: "1rem",
                lineHeight: 1.5,
              }}
            >
              <div style={{ fontWeight: 700 }}>Manager check required</div>
              <div>
                This reservation's day-of order is already closed — QAMF and BMI will NOT be updated
                by an edit. Adjust Conqueror/BMI manually.
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
                  checked={acked}
                  onChange={(e) => {
                    setAcked(e.target.checked);
                    if (e.target.checked) {
                      setAckGiven(true);
                      void probe(true);
                    }
                  }}
                  style={{ marginTop: 2 }}
                />
                <span>I understand — QAMF/BMI will NOT be updated</span>
              </label>
            </div>
          ) : (
            <div
              style={{
                padding: "0.6rem 0.75rem",
                borderRadius: 8,
                backgroundColor: "rgba(239,68,68,0.12)",
                border: "1px solid rgba(239,68,68,0.3)",
                fontSize: "0.78rem",
                color: "#ef4444",
                marginBottom: "1rem",
                lineHeight: 1.5,
                fontWeight: 600,
              }}
            >
              {blockMsg}
            </div>
          )}
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button type="button" onClick={onClose} style={{ ...NAV_BTN, fontSize: "0.8rem" }}>
              Close
            </button>
          </div>
        </>
      )}

      {phase === "error" && (
        <>
          <div
            style={{
              padding: "0.5rem 0.75rem",
              borderRadius: 8,
              fontSize: "0.8rem",
              fontWeight: 600,
              marginBottom: "1rem",
              backgroundColor: "rgba(239,68,68,0.15)",
              color: "#ef4444",
              border: "1px solid rgba(239,68,68,0.3)",
            }}
          >
            {errMsg}
          </div>
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
                if (errorCtx === "mount") void probe(ackGiven);
                else {
                  setPhase("edit");
                  void runExecute();
                }
              }}
              style={{
                padding: "0.5rem 1.25rem",
                borderRadius: 8,
                fontSize: "0.8rem",
                fontWeight: 700,
                cursor: "pointer",
                border: "none",
                backgroundColor: ACCENT,
                color: "#fff",
              }}
            >
              {errorCtx === "mount" ? "Try Again" : "Retry"}
            </button>
          </div>
        </>
      )}
    </ModalShell>
  );
}
