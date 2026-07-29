"use client";

/**
 * Manage Reservation — History tab: the merged newest-first stream of
 * cancel cascades (reservation_cancel_events, expandable to the step log)
 * and generic admin actions (admin_action_events) across every leg of the
 * money group.
 */
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
function editSummary(e: { diffCents: number; settlement: string; phase: string }): string {
  const where =
    e.phase === "mid" ? " (mid-session)" : e.phase === "post_complete" ? " (after close)" : "";
  if (e.diffCents > 0) return `Edited → charged ${dollars(e.diffCents)}${where}`;
  if (e.diffCents < 0) {
    const dest = e.settlement === "store_credit" ? "gift card" : "refund";
    return `Edited → ${dollars(-e.diffCents)} ${dest}${where}`;
  }
  return `Edited — no price change${where}`;
}

export default function HistoryTab({ history }: { history: HistoryEntry[] }) {
  return (
    <Card title="Action history — staff actions + cancellations, newest first">
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
                        display: "inline-block",
                        padding: "1px 6px",
                        borderRadius: 4,
                        fontSize: "0.62rem",
                        fontWeight: 700,
                        color: "#ef4444",
                        backgroundColor: "rgba(239,68,68,0.12)",
                        border: "1px solid rgba(239,68,68,0.3)",
                        marginRight: 6,
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
                  {Array.isArray(h.event.stepLog) && h.event.stepLog.length > 0 && (
                    <ul
                      style={{
                        margin: "6px 0 0",
                        paddingLeft: 18,
                        fontSize: "0.72rem",
                        color: "var(--ba-muted)",
                      }}
                    >
                      {(h.event.stepLog as Array<Record<string, unknown>>).map((s, j) => (
                        <li key={j}>
                          {String(s.kind ?? s.step ?? "step")}
                          {s.detail ? ` — ${String(s.detail)}` : ""}
                        </li>
                      ))}
                    </ul>
                  )}
                  {h.event.error && (
                    <div style={{ marginTop: 4, fontSize: "0.72rem", color: "#ef4444" }}>
                      {h.event.error}
                    </div>
                  )}
                </details>
              ) : h.source === "edit" ? (
                <details style={{ flex: 1 }}>
                  <summary style={{ cursor: "pointer" }}>
                    <span
                      style={{
                        display: "inline-block",
                        padding: "1px 6px",
                        borderRadius: 4,
                        fontSize: "0.62rem",
                        fontWeight: 700,
                        color: "#f59e0b",
                        backgroundColor: "rgba(245,158,11,0.12)",
                        border: "1px solid rgba(245,158,11,0.3)",
                        marginRight: 6,
                      }}
                    >
                      EDIT
                    </span>
                    <span style={{ fontWeight: 600 }}>{editSummary(h.event)}</span>{" "}
                    <span style={{ color: "var(--ba-muted)" }}>
                      by {h.event.actor} · {h.event.state}
                      {h.event.storeCreditGan ? ` · GC ${ganDisplay(h.event.storeCreditGan)}` : ""}
                    </span>
                  </summary>
                  {(h.event.refundIds?.length || h.event.paymentIds?.length) && (
                    <div style={{ marginTop: 4, fontSize: "0.7rem", color: "var(--ba-muted)" }}>
                      {h.event.paymentIds?.length
                        ? `charged: ${h.event.paymentIds.join(", ")}`
                        : null}
                      {h.event.paymentIds?.length && h.event.refundIds?.length ? " · " : null}
                      {h.event.refundIds?.length
                        ? `refunded: ${h.event.refundIds.join(", ")}`
                        : null}
                    </div>
                  )}
                  {Array.isArray(h.event.stepLog) && h.event.stepLog.length > 0 && (
                    <ul
                      style={{
                        margin: "6px 0 0",
                        paddingLeft: 18,
                        fontSize: "0.72rem",
                        color: "var(--ba-muted)",
                      }}
                    >
                      {(h.event.stepLog as Array<Record<string, unknown>>).map((s, j) => (
                        <li key={j}>
                          {String(s.kind ?? s.step ?? "step")}
                          {s.ok === false ? " — FAILED" : ""}
                          {s.detail ? ` — ${String(s.detail)}` : ""}
                        </li>
                      ))}
                    </ul>
                  )}
                  {h.event.error && (
                    <div style={{ marginTop: 4, fontSize: "0.72rem", color: "#ef4444" }}>
                      {h.event.error}
                    </div>
                  )}
                </details>
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
