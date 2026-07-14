"use client";

/**
 * Manage Reservation — the full-page (full-iframe) modal opened by clicking
 * a board row. Sticky header (guest · chips · event time · short code ·
 * money-group strip), action bar (Check In / Reschedule / Resend / View /
 * Cancel — the existing modals open stacked above), and five tabs:
 * Overview · Payments · Guest · Notes · History.
 *
 * Paints instantly from the board's Reservation snapshot while
 * useReservationDetail fetches the authoritative money group + history;
 * the Payments tab lazily reads live Square facts on first activation.
 * Tolerates the board's 10s poll — its state is keyed by reservation id
 * and owned here, never clobbered by a list refresh.
 */
import { useState } from "react";
import {
  bowlingActionable,
  cancelActionable,
  comboConfirmPath,
} from "~/features/reservations-admin/actionable";
import { fmtClock, fmtDate } from "~/features/reservations-admin/format";
import { centerLabel } from "~/features/reservations-admin/format";
import type { ComboMergeInfo, Reservation } from "~/features/reservations-admin/types";
import ModalShell from "../ModalShell";
import BowlingResendModal from "../modals/BowlingResendModal";
import CancelModal from "../modals/CancelModal";
import CheckInModal from "../modals/CheckInModal";
import EditReservationModal from "../modals/EditReservationModal";
import RescheduleModal from "../modals/RescheduleModal";
import GuestTab from "./GuestTab";
import HistoryTab from "./HistoryTab";
import NotesTab from "./NotesTab";
import OverviewTab from "./OverviewTab";
import PaymentsTab from "./PaymentsTab";
import { CopyId, KindChip, StatusChip } from "./ui";
import { useReservationDetail } from "./useReservationDetail";

type Row = Reservation & { comboMerge?: ComboMergeInfo };

const TABS = ["Overview", "Payments", "Guest", "Notes", "History"] as const;
type Tab = (typeof TABS)[number];

const ACTION_BTN: React.CSSProperties = {
  background: "none",
  borderRadius: 6,
  fontSize: "0.72rem",
  fontWeight: 700,
  padding: "5px 12px",
  textTransform: "uppercase",
  letterSpacing: "0.03em",
  cursor: "pointer",
  whiteSpace: "nowrap",
};

export default function ManageReservationModal({
  reservation: r,
  token,
  onClose,
  onMutated,
  onToast,
}: {
  reservation: Row;
  token: string;
  onClose: () => void;
  /** Board reload — call after any mutation so the row behind updates. */
  onMutated: () => void;
  onToast: (msg: string) => void;
}) {
  const [tab, setTab] = useState<Tab>("Overview");
  const [action, setAction] = useState<
    "cancel" | "edit" | "reschedule" | "checkin" | "resend" | null
  >(null);
  const detailState = useReservationDetail(r.id, token);
  const { detail, detailError, detailLoading, refetch } = detailState;

  const isCancelled = r.status === "cancelled";
  const notTerminal = !isCancelled && r.status !== "completed" && r.status !== "arrived";
  const hasAttr = (r.attractionBookings?.length ?? 0) > 0;
  const cPath = comboConfirmPath(r);

  const showCheckIn = notTerminal && !r.checkinMethod && bowlingActionable(r);
  const showResched = notTerminal && !!r.qamfReservationId && !r.comboSpecialId && !hasAttr;
  const reschedHint = r.comboSpecialId
    ? "Combos don't reschedule — cancel to a gift card and rebook."
    : r.productKind === "race" || r.productKind === "attraction" || hasAttr
      ? "Cancel to a gift card is the rebook path."
      : null;
  const showResend = notTerminal && !!(r.guestEmail || r.guestPhone);
  const showCancel = cancelActionable(r);

  function mutated(msg: string) {
    onToast(msg);
    void refetch();
    onMutated();
  }

  return (
    <ModalShell onClose={onClose} variant="full">
      {/* ── Sticky header ── */}
      <div
        style={{
          padding: "14px 18px 0",
          borderBottom: "1px solid var(--ba-border)",
          backgroundColor: "var(--ba-bg)",
          borderTopLeftRadius: 12,
          borderTopRightRadius: 12,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                flexWrap: "wrap",
                gap: 8,
                fontSize: "1.05rem",
                fontWeight: 700,
              }}
            >
              {r.guestName || "Guest"}
              <KindChip kind={r.productKind} />
              <StatusChip status={r.status} />
              {r.comboSpecialId && (
                <span
                  style={{
                    padding: "1px 6px",
                    borderRadius: 4,
                    fontSize: "0.62rem",
                    fontWeight: 700,
                    textTransform: "uppercase",
                    backgroundColor: "rgba(212,175,55,0.18)",
                    color: "#d4af37",
                    border: "1px solid rgba(212,175,55,0.45)",
                  }}
                >
                  ★ VIP
                </span>
              )}
            </div>
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 12,
                marginTop: 4,
                fontSize: "0.78rem",
                color: "var(--ba-muted)",
                alignItems: "center",
              }}
            >
              <span
                style={{
                  fontVariantNumeric: "tabular-nums",
                  fontWeight: 600,
                  color: "var(--ba-fg)",
                }}
              >
                {fmtClock(r.eventAt ?? r.bookedAt)} · {fmtDate(r.eventAt ?? r.bookedAt)}
              </span>
              <span>{centerLabel(r.centerCode)}</span>
              {r.shortCode && (
                <CopyId
                  value={`https://headpinz.com/s/${r.shortCode}`}
                  label={`#${r.shortCode}`}
                  onCopied={onToast}
                />
              )}
              <span>res {r.id}</span>
            </div>
            {/* Money-group strip */}
            {detail && detail.group.length > 1 && (
              <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
                {detail.group.map((leg) => (
                  <span
                    key={leg.id}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      border:
                        leg.id === r.id
                          ? "1px solid rgba(212,175,55,0.6)"
                          : "1px solid var(--ba-border)",
                      backgroundColor: "var(--ba-bg2)",
                      borderRadius: 8,
                      padding: "3px 9px",
                      fontSize: "0.72rem",
                      color: "var(--ba-muted)",
                    }}
                  >
                    <KindChip kind={leg.productKind} />
                    <StatusChip status={leg.status} />#{leg.id}
                  </span>
                ))}
                <span
                  style={{
                    alignSelf: "center",
                    fontSize: "0.68rem",
                    color: "var(--ba-muted)",
                  }}
                >
                  one deposit funds every part — Cancel handles the whole booking
                </span>
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
              fontSize: "1.4rem",
              lineHeight: 1,
              padding: "0 4px",
            }}
          >
            &times;
          </button>
        </div>

        {/* ── Action bar ── */}
        <div
          style={{
            display: "flex",
            gap: 8,
            alignItems: "center",
            flexWrap: "wrap",
            padding: "10px 0",
          }}
        >
          {showCheckIn && (
            <button
              type="button"
              onClick={() => setAction("checkin")}
              style={{
                ...ACTION_BTN,
                border: `1px solid ${r.dayofOrderLane ? "rgba(34,197,94,0.4)" : "rgba(245,158,11,0.4)"}`,
                color: r.dayofOrderLane ? "#22c55e" : "#f59e0b",
              }}
            >
              Check In
            </button>
          )}
          {showResched ? (
            <button
              type="button"
              onClick={() => setAction("reschedule")}
              style={{
                ...ACTION_BTN,
                border: "1px solid rgba(0,226,229,0.4)",
                color: "#00E2E5",
              }}
            >
              Reschedule
            </button>
          ) : (
            reschedHint &&
            !isCancelled && (
              <span style={{ fontSize: "0.7rem", color: "var(--ba-muted)" }}>{reschedHint}</span>
            )
          )}
          {showResend && (
            <button
              type="button"
              onClick={() => setAction("resend")}
              style={{
                ...ACTION_BTN,
                border: "1px solid rgba(96,165,250,0.4)",
                color: "#60a5fa",
              }}
            >
              Resend
            </button>
          )}
          {cPath && (
            <a
              href={cPath}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                ...ACTION_BTN,
                display: "inline-block",
                border: "1px solid rgba(96,165,250,0.4)",
                color: "#60a5fa",
                textDecoration: "none",
              }}
            >
              View Confirmation ↗
            </a>
          )}
          <span style={{ flex: 1 }} />
          {!isCancelled && (
            <button
              type="button"
              onClick={() => setAction("edit")}
              title="Edit players, lanes, shoes, or racers — price differences charge or refund automatically"
              style={{
                ...ACTION_BTN,
                border: "1px solid rgba(245,158,11,0.4)",
                color: "#f59e0b",
              }}
            >
              Edit…
            </button>
          )}
          {showCancel && (
            <button
              type="button"
              onClick={() => setAction("cancel")}
              title={
                r.comboSpecialId
                  ? "Cancel the whole VIP combo — refund or HeadPinz FastTrax Gift Card"
                  : "Cancel — refund, or a HeadPinz FastTrax Gift Card the guest rebooks with"
              }
              style={{
                ...ACTION_BTN,
                border: "1px solid rgba(239,68,68,0.4)",
                color: "#ef4444",
              }}
            >
              Cancel…
            </button>
          )}
        </div>

        {/* ── Tabs ── */}
        <div style={{ display: "flex", gap: 2, overflowX: "auto" }}>
          {TABS.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              style={{
                background: "none",
                border: "none",
                borderBottom: tab === t ? "2px solid #00E2E5" : "2px solid transparent",
                color: tab === t ? "var(--ba-fg)" : "var(--ba-muted)",
                padding: "8px 13px",
                fontSize: "0.82rem",
                fontWeight: 600,
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      {/* ── Tab body ── */}
      <div className="ba-scroll" style={{ overflowY: "auto", flex: 1, padding: "14px 18px 24px" }}>
        {detailLoading && !detail && (
          <div style={{ color: "var(--ba-muted)", fontSize: "0.85rem", padding: "1rem 0" }}>
            Loading details…
          </div>
        )}
        {detailError && (
          <div
            style={{
              padding: "0.6rem 0.75rem",
              borderRadius: 8,
              backgroundColor: "rgba(239,68,68,0.12)",
              border: "1px solid rgba(239,68,68,0.3)",
              fontSize: "0.8rem",
              color: "#ef4444",
              marginBottom: 12,
            }}
          >
            {detailError}
          </div>
        )}
        {detail && (
          <>
            {tab === "Overview" && <OverviewTab detail={detail} boardRow={r} />}
            {tab === "Payments" && (
              <PaymentsTab
                payments={detailState.payments}
                paymentsError={detailState.paymentsError}
                paymentsLoading={detailState.paymentsLoading}
                loadPayments={detailState.loadPayments}
                onCopied={onToast}
                neonId={r.id}
                token={token}
              />
            )}
            {tab === "Guest" && (
              <GuestTab detail={detail} boardRow={r} token={token} onSaved={mutated} />
            )}
            {tab === "Notes" && <NotesTab detail={detail} token={token} onSaved={mutated} />}
            {tab === "History" && <HistoryTab history={detail.history} />}
          </>
        )}
      </div>

      {/* ── Stacked action sub-modals (render above the manage modal) ── */}
      {action === "cancel" && (
        <CancelModal
          reservation={r}
          token={token}
          onClose={() => setAction(null)}
          onDone={mutated}
        />
      )}
      {action === "edit" && (
        <EditReservationModal
          reservation={r}
          token={token}
          onClose={() => setAction(null)}
          onDone={mutated}
        />
      )}
      {action === "reschedule" && (
        <RescheduleModal
          reservation={r}
          token={token}
          onClose={() => setAction(null)}
          onRescheduled={(msg) => mutated(`${r.guestName || "Guest"}: ${msg}`)}
        />
      )}
      {action === "checkin" && (
        <CheckInModal
          reservation={r}
          token={token}
          onClose={() => setAction(null)}
          onCheckedIn={(msg) => mutated(`${r.guestName || "Guest"}: ${msg}`)}
        />
      )}
      {action === "resend" && (
        <BowlingResendModal
          reservation={r}
          token={token}
          onClose={() => setAction(null)}
          onSent={(msg) => onToast(`${r.guestName || "Guest"}: ${msg}`)}
        />
      )}
    </ModalShell>
  );
}
