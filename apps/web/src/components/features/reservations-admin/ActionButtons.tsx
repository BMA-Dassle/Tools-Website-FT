"use client";

/**
 * Single source for the per-row action set — Check In / Resched / View /
 * Resend / Cancel — previously copy-pasted between the mobile card list and
 * the desktop table. `layout` reproduces each branch's exact sizing;
 * `mode="checkin-only"` is the post-manage-modal row (all other actions live
 * inside the Manage Reservation modal).
 *
 * Gate logic is verbatim from the original branches. In the card layout the
 * caller additionally wraps this in the original
 * `!cancelled && status !== "completed"` row condition (per-button guards
 * here are identical under that wrapper).
 */
import {
  bowlingActionable,
  cancelActionable,
  comboConfirmPath,
} from "~/features/reservations-admin/actionable";
import type { ComboMergeInfo, Reservation } from "~/features/reservations-admin/types";

type Row = Reservation & { comboMerge?: ComboMergeInfo };

export default function ActionButtons({
  reservation: r,
  layout,
  mode = "full",
  onCheckIn,
  onReschedule,
  onResend,
  onCancel,
}: {
  reservation: Row;
  layout: "table" | "card";
  mode?: "full" | "checkin-only";
  onCheckIn: (r: Row) => void;
  onReschedule: (r: Row) => void;
  onResend: (r: Row) => void;
  onCancel: (r: Row) => void;
}) {
  const isCancelled = r.status === "cancelled";
  const notTerminal = !isCancelled && r.status !== "completed" && r.status !== "arrived";
  const hasAttr = (r.attractionBookings?.length ?? 0) > 0;
  const cPath = comboConfirmPath(r);
  const card = layout === "card";

  // Card buttons stretch (flex:1, tap-friendly); table buttons are compact.
  const base = card
    ? {
        flex: 1,
        background: "none",
        borderRadius: 4,
        fontSize: "0.6rem",
        fontWeight: 600 as const,
        padding: "3px 0",
        textTransform: "uppercase" as const,
        letterSpacing: "0.02em",
      }
    : {
        background: "none",
        borderRadius: 5,
        fontSize: "0.6rem",
        fontWeight: 600 as const,
        padding: "2px 6px",
        textTransform: "uppercase" as const,
        letterSpacing: "0.03em",
      };

  const showCheckIn = notTerminal && !r.checkinMethod && bowlingActionable(r);
  const showResched = mode === "full" && notTerminal && !!r.qamfReservationId && !r.comboSpecialId;
  const showView = mode === "full" && !!cPath;
  const showResend = mode === "full" && notTerminal && !!(r.guestEmail || r.guestPhone);
  const showCancel = mode === "full" && cancelActionable(r);

  return (
    <div style={card ? { display: "flex", gap: 4, marginTop: 6 } : { display: "flex", gap: 4 }}>
      {showCheckIn && (
        <button
          type="button"
          onClick={() => onCheckIn(r)}
          style={{
            ...base,
            cursor: "pointer",
            border: `1px solid ${r.dayofOrderLane ? "rgba(34,197,94,0.3)" : "rgba(245,158,11,0.3)"}`,
            color: r.dayofOrderLane ? "#22c55e" : "#f59e0b",
          }}
        >
          Check In
        </button>
      )}
      {showResched && (
        <button
          type="button"
          onClick={hasAttr ? undefined : () => onReschedule(r)}
          disabled={hasAttr}
          title={
            card
              ? undefined
              : hasAttr
                ? "Reschedule is bowling-only. Use Cancel — a HeadPinz FastTrax Gift Card lets the guest rebook any date."
                : "Reschedule bowling time"
          }
          style={{
            ...base,
            border: `1px solid ${hasAttr ? "var(--ba-border)" : "rgba(0,226,229,0.3)"}`,
            color: hasAttr ? "var(--ba-muted)" : "#00E2E5",
            cursor: hasAttr ? "not-allowed" : "pointer",
          }}
        >
          Resched
        </button>
      )}
      {showView && (
        <a
          href={cPath!}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            ...base,
            ...(card
              ? { display: "inline-flex", alignItems: "center", justifyContent: "center" }
              : { display: "inline-block" }),
            border: "1px solid rgba(96,165,250,0.3)",
            color: "#60a5fa",
            textDecoration: "none",
          }}
        >
          View
        </a>
      )}
      {showResend && (
        <button
          type="button"
          onClick={() => onResend(r)}
          style={{
            ...base,
            cursor: "pointer",
            border: "1px solid rgba(96,165,250,0.3)",
            color: "#60a5fa",
          }}
        >
          Resend
        </button>
      )}
      {showCancel && (
        <button
          type="button"
          onClick={() => onCancel(r)}
          title={
            r.comboSpecialId
              ? "Cancel the whole VIP combo — refund or HeadPinz FastTrax Gift Card"
              : card && bowlingActionable(r)
                ? "Cancel — refund or HeadPinz FastTrax Gift Card"
                : "Cancel — refund, or a HeadPinz FastTrax Gift Card the guest rebooks with"
          }
          style={{
            ...base,
            cursor: "pointer",
            border: "1px solid rgba(239,68,68,0.3)",
            color: "#ef4444",
          }}
        >
          Cancel
        </button>
      )}
    </div>
  );
}
