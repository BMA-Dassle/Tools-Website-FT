"use client";

/**
 * Manage Reservation — History tab: the merged newest-first stream of
 * cancel cascades (reservation_cancel_events, expandable to the step log),
 * edits (reservation_edit_events — with any by-hand follow-ups shown OUTSIDE
 * the collapsed details, because a collapsed step log is where res 12412's
 * failed Conqueror sync hid) and generic admin actions (admin_action_events)
 * across every leg of the money group.
 */
import type { CSSProperties } from "react";
import type { EditEventRow } from "@/lib/reservation-edit-log";
import { dollars, fmtDate, fmtTime, ganDisplay } from "~/features/reservations-admin/format";
import type { HistoryEntry } from "~/features/reservations-admin/service";
import { Card } from "./ui";

const ACTION_LABELS: Record<string, string> = {
  reschedule: "Rescheduled",
  resend: "Confirmation resent",
  checkin: "Checked in",
  checkin_method: "Check-in method set",
  notes_edit: "Notes edited",
  guest_edit: "Guest contact edited",
};

const SYSTEM_LABELS: Record<string, string> = {
  conqueror: "Conqueror",
  bmi: "BMI",
  square: "Square",
  guest: "Guest",
};

const BADGE: CSSProperties = {
  display: "inline-block",
  padding: "1px 6px",
  borderRadius: 4,
  fontSize: "0.62rem",
  fontWeight: 700,
  marginRight: 6,
};

function when(at: string): string {
  return `${fmtDate(at)} ${fmtTime(at)}`;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function actionSummary(e: { action: string; detail: any }): string {
  const d = e.detail ?? {};
  switch (e.action) {
    case "reschedule":
      return d.toBookedAt ? `→ ${when(d.toBookedAt)}` : "";
    case "resend":
      return [
        d.channel,
        d.overrideEmail ? `to ${d.overrideEmail}` : null,
        d.overridePhone ? `to ${d.overridePhone}` : null,
      ]
        .filter(Boolean)
        .join(" · ");
    case "checkin_method":
      return d.method ? `→ ${d.method}` : "cleared";
    case "notes_edit":
      return [d.memoSynced ? "Conqueror synced" : null, d.bmiMemoSynced ? "BMI synced" : null]
        .filter(Boolean)
        .join(" · ");
    case "guest_edit":
      return Object.keys(d.changed ?? {})
        .map((k) => k.replace("guest", "").toLowerCase())
        .join(", ");
    default:
      return "";
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** One-line summary of an edit: which way the money went, and how much. */
export function editSummary(e: {
  diffCents: number;
  settlement: string;
  phase: string;
  state?: string;
}): string {
  const where =
    e.phase === "mid" ? " (mid-session)" : e.phase === "post_complete" ? " (after close)" : "";
  if (e.state === "pending_payment") {
    return `Edit waiting on the guest to pay ${dollars(e.diffCents)} via payment link${where}`;
  }
  if (e.diffCents > 0) return `Edited → charged ${dollars(e.diffCents)}${where}`;
  if (e.diffCents < 0) {
    const dest = e.settlement === "store_credit" ? "gift card" : "refund";
    return `Edited → ${dollars(-e.diffCents)} ${dest}${where}`;
  }
  return `Edited — no price change${where}`;
}

interface ManualLine {
  system: string;
  message: string;
  predicted: boolean;
}

/**
 * By-hand follow-ups for an edit: the typed `manualSteps` the engine records
 * (predicted = acknowledged before Execute), falling back — for rows written
 * before the column existed — to failed `qamf_` / `bmi_` steps in the step log.
 */
export function manualStepsOf(e: EditEventRow): ManualLine[] {
  if (Array.isArray(e.manualSteps) && e.manualSteps.length > 0) {
    return e.manualSteps.map((s) => ({
      system: s.system,
      message: s.message,
      predicted: s.predicted,
    }));
  }
  if (!Array.isArray(e.stepLog)) return [];
  return (e.stepLog as Array<Record<string, unknown>>)
    .filter((s) => {
      const step = String(s.step ?? s.kind ?? "");
      return s.ok === false && (step.startsWith("qamf_") || step.startsWith("bmi_"));
    })
    .map((s) => {
      const step = String(s.step ?? s.kind ?? "");
      return {
        system: step.startsWith("qamf_") ? "conqueror" : "bmi",
        message: s.detail
          ? String(s.detail)
          : `${step} failed — check ${step.startsWith("qamf_") ? "Conqueror" : "BMI"} by hand`,
        predicted: false,
      };
    });
}

function StepLog({ stepLog, showFailed }: { stepLog: unknown; showFailed: boolean }) {
  if (!Array.isArray(stepLog) || stepLog.length === 0) return null;
  return (
    <ul
      style={{
        margin: "6px 0 0",
        paddingLeft: 18,
        fontSize: "0.72rem",
        color: "var(--ba-muted)",
      }}
    >
      {(stepLog as Array<Record<string, unknown>>).map((s, j) => (
        <li key={j}>
          {String(s.kind ?? s.step ?? "step")}
          {showFailed && s.ok === false ? " — FAILED" : ""}
          {s.detail ? ` — ${String(s.detail)}` : ""}
        </li>
      ))}
    </ul>
  );
}

export default function HistoryTab({ history }: { history: HistoryEntry[] }) {
  return (
    <Card title="Action history — staff actions, edits + cancellations, newest first">
      {history.length === 0 ? (
        <div style={{ color: "var(--ba-muted)", fontSize: "0.8rem" }}>
          Nothing yet — staff actions from the portal are recorded here from July 2026 on.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column" }}>
          {history.map((h, i) => (
            <div
              key={i}
              style={{
                display: "flex",
                gap: 12,
                padding: "8px 0",
                borderBottom: i < history.length - 1 ? "1px dashed var(--ba-border)" : undefined,
                fontSize: "0.8rem",
                alignItems: "baseline",
              }}
            >
              <span
                style={{
                  minWidth: 150,
                  color: "var(--ba-muted)",
                  fontSize: "0.72rem",
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {when(String(h.at))}
              </span>
              {h.source === "cancel" ? (
                <details style={{ flex: 1 }}>
                  <summary style={{ cursor: "pointer" }}>
                    <span
                      style={{
                        ...BADGE,
                        color: "#ef4444",
                        backgroundColor: "rgba(239,68,68,0.12)",
                        border: "1px solid rgba(239,68,68,0.3)",
                      }}
                    >
                      CANCEL
                    </span>
                    <span style={{ fontWeight: 600 }}>
                      {h.event.outcome === "store_credit"
                        ? "Cancelled → gift card"
                        : h.event.outcome === "refund"
                          ? "Cancelled → refund"
                          : "Cancelled"}
                    </span>{" "}
                    <span style={{ color: "var(--ba-muted)" }}>
                      by {h.event.actor} · {h.event.state}
                      {h.event.refundCents ? ` · ${dollars(h.event.refundCents)} refunded` : ""}
                      {h.event.storeCreditGan ? ` · GC ${ganDisplay(h.event.storeCreditGan)}` : ""}
                    </span>
                  </summary>
                  <StepLog stepLog={h.event.stepLog} showFailed={false} />
                  {h.event.error && (
                    <div style={{ marginTop: 4, fontSize: "0.72rem", color: "#ef4444" }}>
                      {h.event.error}
                    </div>
                  )}
                </details>
              ) : h.source === "edit" ? (
                <EditRow event={h.event} />
              ) : (
                <span style={{ flex: 1 }}>
                  <span style={{ fontWeight: 600 }}>
                    {ACTION_LABELS[h.event.action] ?? h.event.action}
                  </span>{" "}
                  <span style={{ color: "var(--ba-muted)" }}>
                    {actionSummary(h.event)}
                    {h.event.outcome === "failed" && (
                      <span style={{ color: "#ef4444", fontWeight: 600 }}>
                        {" "}
                        · failed{h.event.error ? `: ${h.event.error}` : ""}
                      </span>
                    )}
                  </span>
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function EditRow({ event: e }: { event: EditEventRow }) {
  const manual = manualStepsOf(e);
  const hasIds = !!(e.refundIds?.length || e.paymentIds?.length);
  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <details>
        <summary style={{ cursor: "pointer" }}>
          <span
            style={{
              ...BADGE,
              color: "#f59e0b",
              backgroundColor: "rgba(245,158,11,0.12)",
              border: "1px solid rgba(245,158,11,0.3)",
            }}
          >
            EDIT
          </span>
          {manual.length > 0 && (
            <span
              style={{
                ...BADGE,
                color: "#ef4444",
                backgroundColor: "rgba(239,68,68,0.12)",
                border: "1px solid rgba(239,68,68,0.3)",
              }}
              title="Conqueror / BMI were not updated automatically — the steps below still need doing by hand"
            >
              MANUAL FOLLOW-UP
            </span>
          )}
          <span style={{ fontWeight: 600 }}>{editSummary(e)}</span>{" "}
          <span style={{ color: "var(--ba-muted)" }}>
            by {e.actor} · {e.state}
            {e.storeCreditGan ? ` · GC ${ganDisplay(e.storeCreditGan)}` : ""}
          </span>
        </summary>
        {hasIds && (
          <div style={{ marginTop: 4, fontSize: "0.7rem", color: "var(--ba-muted)" }}>
            {e.paymentIds?.length ? `charged: ${e.paymentIds.join(", ")}` : null}
            {e.paymentIds?.length && e.refundIds?.length ? " · " : null}
            {e.refundIds?.length ? `refunded: ${e.refundIds.join(", ")}` : null}
          </div>
        )}
        <StepLog stepLog={e.stepLog} showFailed />
        {e.error && (
          <div style={{ marginTop: 4, fontSize: "0.72rem", color: "#ef4444" }}>{e.error}</div>
        )}
      </details>

      {/* Outside the <details> ON PURPOSE — a by-hand step must never be one
          click away from invisible. */}
      {manual.length > 0 && (
        <ul
          style={{
            margin: "6px 0 0",
            paddingLeft: 18,
            fontSize: "0.74rem",
            color: "#ef4444",
            lineHeight: 1.5,
          }}
        >
          {manual.map((m, j) => (
            <li key={j}>
              <strong>{SYSTEM_LABELS[m.system] ?? m.system}:</strong> {m.message}
              {m.predicted ? (
                <span style={{ color: "var(--ba-muted)" }}> — acknowledged before the edit</span>
              ) : (
                <span style={{ color: "var(--ba-muted)" }}> — failed during the edit</span>
              )}
            </li>
          ))}
        </ul>
      )}
      {e.acknowledged && e.acknowledged.codes.length > 0 && (
        <div style={{ marginTop: 4, fontSize: "0.7rem", color: "var(--ba-muted)" }}>
          acknowledged by {e.acknowledged.by ?? "staff (no initials)"} at {when(e.acknowledged.at)}
        </div>
      )}
    </div>
  );
}
