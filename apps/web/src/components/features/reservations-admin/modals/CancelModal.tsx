"use client";

/**
 * Cancel modal for the admin reservations board — all kinds (race, attraction,
 * bowling±add-ons, VIP combos) with two outcomes: refund to card, or a
 * HeadPinz FastTrax Gift Card. Opens with an authoritative server dry-run.
 * Extracted verbatim from app/admin/[token]/reservations/ReservationsClient.tsx
 * (only the overlay wrapper moved to ModalShell).
 */
import { useEffect, useState } from "react";
import { CENTERS, STATUS_LABELS } from "~/features/reservations-admin/constants";
import { dollars, fmtDate, fmtTime, ganDisplay } from "~/features/reservations-admin/format";
import type { Reservation } from "~/features/reservations-admin/types";
import ModalShell from "../ModalShell";
import { NAV_BTN } from "../theme";

export type CancelPlanView = {
  ok: boolean;
  dryRun?: boolean;
  alreadyCancelled?: boolean;
  outcome: string;
  legs: Array<{ neonId: number; kind: string; label: string; status: string }>;
  amountCents: number;
  steps: Array<{ kind: string; detail: string; fatal: boolean; amountCents?: number }>;
  warnings: string[];
  refundIds?: string[];
  refundCents?: number;
  storeCredit?: { giftCardId: string; gan: string; amountCents: number };
  notified?: { email: boolean; sms: boolean };
  notificationsSkipped?: boolean;
};

export default function CancelModal({
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
  const [phase, setPhase] = useState<
    "loading" | "choose" | "busy" | "success" | "blocked" | "error"
  >("loading");
  const [plan, setPlan] = useState<CancelPlanView | null>(null);
  const [outcome, setOutcome] = useState<"refund" | "store_credit" | null>(null);
  const [notifyGuest, setNotifyGuest] = useState(true);
  const [result, setResult] = useState<CancelPlanView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ganCopied, setGanCopied] = useState(false);

  // Authoritative dry-run on mount — its output IS the modal body, so staff
  // always see exactly what this cancel involves before choosing anything.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(
          `/api/admin/reservations/cancel?token=${encodeURIComponent(token)}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ neonId: reservation.id, outcome: "refund", dryRun: true }),
          },
        );
        const data = (await res.json()) as CancelPlanView & { error?: string; detail?: string };
        if (!alive) return;
        if (!res.ok) {
          setError(data.detail || data.error || `HTTP ${res.status}`);
          setPhase("blocked");
          return;
        }
        if (data.alreadyCancelled) {
          setError("This reservation is already cancelled.");
          setPhase("blocked");
          return;
        }
        setPlan(data);
        setPhase("choose");
      } catch (err) {
        if (!alive) return;
        setError(err instanceof Error ? err.message : "Failed to load the cancel preview");
        setPhase("error");
      }
    })();
    return () => {
      alive = false;
    };
  }, [reservation.id, token]);

  async function execute() {
    if (!plan) return;
    const chosen = plan.amountCents === 0 ? "refund" : outcome;
    if (!chosen) return;
    setPhase("busy");
    setError(null);
    try {
      const res = await fetch(`/api/admin/reservations/cancel?token=${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ neonId: reservation.id, outcome: chosen, notifyGuest }),
      });
      const data = (await res.json()) as CancelPlanView & { error?: string; detail?: string };
      if (!res.ok) {
        if (res.status === 409) {
          setError(data.detail || data.error || `HTTP ${res.status}`);
          setPhase("blocked");
        } else {
          setError(data.detail || data.error || `HTTP ${res.status}`);
          setPhase("error");
        }
        return;
      }
      setResult(data);
      setPhase("success");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Cancel failed");
      setPhase("error");
    }
  }

  function finish() {
    const guest = reservation.guestName || "Guest";
    if (result?.storeCredit) {
      onDone(
        `${guest}: cancelled — ${dollars(result.storeCredit.amountCents)} gift card ${ganDisplay(result.storeCredit.gan)}${result.notificationsSkipped ? " (kept for staff rebook)" : " sent"}`,
      );
    } else if (result?.refundCents) {
      onDone(`${guest}: cancelled — ${dollars(result.refundCents)} refund issued`);
    } else {
      onDone(`${guest}: reservation cancelled`);
    }
    onClose();
  }

  const isCombo = !!reservation.comboSpecialId;
  const multi = (plan?.legs.length ?? 1) > 1;
  const hasMoney = (plan?.amountCents ?? 0) > 0;

  const pickRow = (key: "refund" | "store_credit", title: string, sub: string, accent: string) => (
    <button
      type="button"
      onClick={() => setOutcome(key)}
      style={{
        display: "block",
        width: "100%",
        textAlign: "left",
        padding: "0.6rem 0.75rem",
        borderRadius: 10,
        backgroundColor: outcome === key ? `${accent}14` : "var(--ba-bg2)",
        border: `1px solid ${outcome === key ? accent : "var(--ba-border)"}`,
        cursor: "pointer",
        marginBottom: 8,
      }}
    >
      <div
        style={{
          fontSize: "0.82rem",
          fontWeight: 700,
          color: outcome === key ? accent : "var(--ba-fg)",
        }}
      >
        {title}
      </div>
      <div style={{ fontSize: "0.72rem", color: "var(--ba-muted)", marginTop: 2, lineHeight: 1.4 }}>
        {sub}
      </div>
    </button>
  );

  return (
    <ModalShell onClose={onClose} maxWidth={440} maxHeight="90vh" borderColor="rgba(239,68,68,0.3)">
      {/* Header */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "1rem",
        }}
      >
        <h3 style={{ fontSize: "1rem", fontWeight: 700, color: "#ef4444", margin: 0 }}>
          {isCombo
            ? "Cancel VIP Combo — both legs"
            : multi
              ? "Cancel Booking — all parts"
              : "Cancel Reservation"}
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
          Checking what this cancel involves...
        </div>
      )}

      {(phase === "choose" || phase === "busy") && plan && (
        <>
          {/* Booking summary — from the server dry-run (authoritative) */}
          <div
            style={{
              padding: "0.75rem",
              borderRadius: 10,
              backgroundColor: "var(--ba-bg2)",
              border: "1px solid var(--ba-border)",
              marginBottom: "0.9rem",
              fontSize: "0.8rem",
              lineHeight: 1.7,
            }}
          >
            <div>
              <strong style={{ color: "var(--ba-fg)" }}>{reservation.guestName || "Guest"}</strong>
            </div>
            <div style={{ color: "var(--ba-muted)" }}>
              {fmtTime(reservation.eventAt ?? reservation.bookedAt)} &middot;{" "}
              {fmtDate(reservation.eventAt ?? reservation.bookedAt)} &middot;{" "}
              {CENTERS[reservation.centerCode] ?? reservation.centerCode}
            </div>
            {plan.legs.map((leg) => (
              <div key={leg.neonId} style={{ color: "var(--ba-muted)" }}>
                {leg.label} <span style={{ opacity: 0.7 }}>#{leg.neonId}</span> &middot;{" "}
                {STATUS_LABELS[leg.status] ?? leg.status}
              </div>
            ))}
            {hasMoney && (
              <div style={{ color: "#22c55e", fontWeight: 600, marginTop: 2 }}>
                Paid{multi ? " (covers every part)" : ""}: {dollars(plan.amountCents)}
              </div>
            )}
          </div>

          {plan.warnings.length > 0 && (
            <div
              style={{
                padding: "0.5rem 0.75rem",
                borderRadius: 8,
                backgroundColor: "rgba(245,158,11,0.1)",
                border: "1px solid rgba(245,158,11,0.25)",
                fontSize: "0.72rem",
                color: "#f59e0b",
                marginBottom: "0.9rem",
                lineHeight: 1.5,
              }}
            >
              {plan.warnings.map((w, i) => (
                <div key={i}>{w}</div>
              ))}
            </div>
          )}

          {hasMoney ? (
            <>
              {pickRow(
                "refund",
                `Refund to card`,
                `${dollars(plan.amountCents)} back to the original card in 3-5 business days.`,
                "#ef4444",
              )}
              {pickRow(
                "store_credit",
                "HeadPinz FastTrax Gift Card",
                `Issue a ${dollars(plan.amountCents)} HeadPinz FastTrax Gift Card the guest rebooks with online — how "reschedules" work for racing and attractions.`,
                "#22c55e",
              )}
              {outcome === "store_credit" && (
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
                    onChange={(e) => setNotifyGuest(e.target.checked)}
                    style={{ marginTop: 2 }}
                  />
                  <span>
                    Email &amp; text the gift card to the guest
                    {!notifyGuest && (
                      <span style={{ display: "block", color: "#f59e0b", marginTop: 2 }}>
                        Nothing goes to the guest — you get the card number here and use it to pay
                        for their new booking.
                      </span>
                    )}
                  </span>
                </label>
              )}
            </>
          ) : (
            <div
              style={{
                padding: "0.6rem 0.75rem",
                borderRadius: 8,
                backgroundColor: "rgba(239,68,68,0.1)",
                border: "1px solid rgba(239,68,68,0.2)",
                fontSize: "0.75rem",
                color: "var(--ba-muted)",
                marginBottom: "1rem",
                lineHeight: 1.5,
              }}
            >
              No deposit was charged — this cancels the reservation only. No refund or gift card
              will be issued.
            </div>
          )}

          {/* Actions */}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button type="button" onClick={onClose} style={{ ...NAV_BTN, fontSize: "0.8rem" }}>
              Keep It
            </button>
            <button
              type="button"
              onClick={execute}
              disabled={phase === "busy" || (hasMoney && !outcome)}
              style={{
                padding: "0.5rem 1.25rem",
                borderRadius: 8,
                fontSize: "0.8rem",
                fontWeight: 700,
                cursor: phase === "busy" || (hasMoney && !outcome) ? "not-allowed" : "pointer",
                border: "none",
                backgroundColor: outcome === "store_credit" ? "#22c55e" : "#ef4444",
                color: "#fff",
                opacity: phase === "busy" || (hasMoney && !outcome) ? 0.5 : 1,
              }}
            >
              {phase === "busy"
                ? outcome === "store_credit"
                  ? "Issuing gift card..."
                  : "Cancelling..."
                : !hasMoney
                  ? "Cancel Reservation"
                  : outcome === "store_credit"
                    ? `Cancel & Issue ${dollars(plan.amountCents)} Gift Card`
                    : `Cancel & Refund ${dollars(plan.amountCents)}`}
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
              backgroundColor: "rgba(34,197,94,0.08)",
              border: "1px solid rgba(34,197,94,0.3)",
              marginBottom: "0.9rem",
              fontSize: "0.85rem",
              color: "var(--ba-fg)",
              lineHeight: 1.6,
            }}
          >
            <div style={{ fontWeight: 700, color: "#22c55e" }}>
              {result.storeCredit
                ? "HeadPinz FastTrax Gift Card issued — reservation cancelled."
                : "Reservation cancelled."}
            </div>
            {result.storeCredit ? (
              <div style={{ marginTop: 8 }}>
                <div
                  style={{
                    fontSize: "0.68rem",
                    textTransform: "uppercase",
                    letterSpacing: 1,
                    color: "var(--ba-muted)",
                  }}
                >
                  HeadPinz FastTrax Gift Card &middot; {dollars(result.storeCredit.amountCents)}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
                  <span style={{ fontFamily: "monospace", fontSize: "1.05rem", fontWeight: 700 }}>
                    {ganDisplay(result.storeCredit.gan)}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      void navigator.clipboard.writeText(result.storeCredit!.gan).then(() => {
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
            ) : result.refundCents ? (
              <div style={{ marginTop: 4, color: "var(--ba-muted)", fontSize: "0.78rem" }}>
                Refund {dollars(result.refundCents)}
                {result.refundIds?.[0] ? (
                  <span style={{ fontFamily: "monospace" }}> &middot; {result.refundIds[0]}</span>
                ) : null}
              </div>
            ) : null}
            <div
              style={{
                marginTop: 8,
                display: "flex",
                gap: 6,
                flexWrap: "wrap",
                fontSize: "0.7rem",
              }}
            >
              {result.notificationsSkipped ? (
                <span style={{ color: "#f59e0b", fontWeight: 600 }}>
                  Not sent to guest — use the card number above to rebook for them.
                </span>
              ) : (
                <>
                  <span
                    style={{
                      color: result.notified?.email ? "#22c55e" : "#ef4444",
                      fontWeight: 600,
                    }}
                  >
                    {result.notified?.email
                      ? "Email sent"
                      : "Email failed — copy the details and send manually."}
                  </span>
                  <span
                    style={{
                      color: result.notified?.sms ? "#22c55e" : "#ef4444",
                      fontWeight: 600,
                    }}
                  >
                    {result.notified?.sms ? "SMS sent" : "SMS not sent."}
                  </span>
                </>
              )}
            </div>
            {result.warnings.length > 0 && (
              <div style={{ marginTop: 8, fontSize: "0.7rem", color: "#f59e0b", lineHeight: 1.5 }}>
                {result.warnings.map((w, i) => (
                  <div key={i}>{w}</div>
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
                backgroundColor: "#22c55e",
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
            {error}
          </div>
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
            {error}
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button type="button" onClick={onClose} style={{ ...NAV_BTN, fontSize: "0.8rem" }}>
              Keep It
            </button>
            <button
              type="button"
              onClick={() => setPhase("choose")}
              style={{
                padding: "0.5rem 1.25rem",
                borderRadius: 8,
                fontSize: "0.8rem",
                fontWeight: 700,
                cursor: "pointer",
                border: "none",
                backgroundColor: "#ef4444",
                color: "#fff",
              }}
            >
              Try Again
            </button>
          </div>
        </>
      )}
    </ModalShell>
  );
}
