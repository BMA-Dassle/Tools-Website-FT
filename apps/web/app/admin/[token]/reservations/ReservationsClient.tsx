"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { modalBackdropProps } from "@/lib/a11y";

/** Short display labels for the day-of-order `source` tag (the raw values are
 *  verbose, e.g. "race-dayof-pay-fallback-timepassed" overflowed the column). */
const DAYOF_SOURCE_LABELS: Record<string, string> = {
  webhook: "WEBHOOK",
  "race-dayof-pay": "AUTO",
  "race-dayof-pay-fallback-timepassed": "AUTO·PAST",
};
function dayofSourceLabel(source: string): string {
  return DAYOF_SOURCE_LABELS[source] ?? source.toUpperCase();
}

interface ReservationLine {
  label: string;
  quantity: number;
  unitPriceCents: number;
}

interface Reservation {
  id: number;
  centerCode: string;
  productKind: string;
  qamfReservationId?: string;
  bmiBillId?: string;
  bmiReservationNumber?: string;
  squareDepositOrderId?: string;
  squareDayofOrderId?: string;
  squareGiftCardGan?: string;
  shortCode?: string;
  depositCents: number;
  totalCents: number;
  status: string;
  bookedAt: string;
  playerCount?: number;
  guestName?: string;
  guestEmail?: string;
  guestPhone?: string;
  notes?: string;
  cancelledAt?: string;
  refundCents: number;
  dayofOrderSentAt?: string;
  dayofOrderLane?: string;
  dayofPaymentId?: string;
  dayofOrderError?: string;
  dayofOrderSource?: string;
  preArrivalSentAt?: string;
  laneReadySentAt?: string;
  bookingSource?: string;
  squareLoyaltyRewardId?: string;
  rewardDiscountCents: number;
  checkinMethod?: string;
  loyaltyAction?: string;
  squareCustomerId?: string;
  /** Guest-survey snapshot — null when no survey has been sent for this reservation. */
  survey?: {
    token: string;
    status: "sent" | "opened" | "completed";
    rewardKind: "pinz" | "gift_card" | "declined" | null;
    rewardValue: number | null;
    sentAt: string;
    openedAt: string | null;
    completedAt: string | null;
    channel: "sms" | "email" | null;
  } | null;
  attractionBookings?: Array<{
    slug: string;
    name: string;
    quantity: number;
    totalPriceDollars: number;
    timeLabel: string;
  }>;
  /** Combo special id (e.g. 'race-bowl') when this row is one leg of a VIP combo. */
  comboSpecialId?: string;
  insertedAt: string;
  lines: ReservationLine[];
}

/** Display metadata for a combo special, keyed by combo id (from the server registry). */
interface ComboMeta {
  name: string;
  accentColor: string;
  includes: string[];
  center: string;
}

interface GroupEvent {
  id: number;
  contractShortId: string;
  eventName: string;
  eventNumber: string;
  eventDate: string;
  eventDateDisplay: string;
  guestName: string;
  guestEmail: string;
  guestPhone: string | null;
  guestCount: number | null;
  plannerName: string | null;
  plannerEmail: string | null;
  plannerPhone: string | null;
  centerCode: string;
  brand: string;
  status: string;
  totalCents: number;
  depositDueCents: number;
  balanceCents: number;
  squareDepositOrderId: string | null;
  squareDayofOrderId: string | null;
  squareGiftCardGan: string | null;
  squareCustomerId: string | null;
  savedCardId: string | null;
  depositPaidAt: string | null;
  balancePaidAt: string | null;
  lineItems: Array<{ name: string; qty: number; total: number }>;
  notes: string | null;
  createdAt: string;
}

interface SquareLineItem {
  uid: string;
  name: string;
  quantity: number;
  note: string | null;
  priceCents: number;
  grossCents: number;
  taxCents: number;
  discountCents: number;
  totalCents: number;
  catalogId: string | null;
}

const CENTERS: Record<string, string> = {
  TXBSQN0FEKQ11: "Fort Myers",
  PPTR5G2N0QXF7: "Naples",
  // FastTrax has no bowling (HeadPinz-only), but it IS a group-function center,
  // so the page shows its group events when scoped here.
  LAB52GY480CJF: "FastTrax",
};

/** URL-friendly slugs → center codes for ?center= param (drives the portal embed,
 *  e.g. /admin/embed/bowling?center=fasttrax). */
const CENTER_SLUGS: Record<string, string> = {
  fm: "TXBSQN0FEKQ11",
  "fort-myers": "TXBSQN0FEKQ11",
  naples: "PPTR5G2N0QXF7",
  ft: "LAB52GY480CJF",
  fasttrax: "LAB52GY480CJF",
  "fast-trax": "LAB52GY480CJF",
};

/** Center codes stored as slugs (combos store session.center, e.g. "fort-myers"). */
const CENTER_LABELS_BY_SLUG: Record<string, string> = {
  "fort-myers": "Fort Myers",
  naples: "Naples",
  fasttrax: "FastTrax",
};

/** Resolve a center label whether the row stored a Square location ID or a slug. */
function centerLabel(code: string): string {
  return CENTERS[code] ?? CENTER_LABELS_BY_SLUG[code] ?? code;
}

const STATUS_COLORS: Record<string, string> = {
  confirmed: "#22c55e",
  confirm_pending: "#f59e0b",
  confirm_failed: "#ef4444",
  arrived: "#3b82f6",
  completed: "#6b7280",
  cancelled: "#ef4444",
};

const STATUS_LABELS: Record<string, string> = {
  confirmed: "Confirmed",
  confirm_pending: "Pending",
  confirm_failed: "Failed",
  arrived: "Arrived",
  completed: "Completed",
  cancelled: "Cancelled",
};

const SOURCE_LABELS: Record<string, string> = {
  web: "Web",
  kiosk: "Kiosk",
  conqueror: "Conq",
  admin: "Admin",
};

const SOURCE_COLORS: Record<string, string> = {
  web: "#22c55e",
  kiosk: "#f59e0b",
  conqueror: "#ec4899",
  admin: "#8b5cf6",
};

const KIND_BADGE: Record<string, { label: string; color: string; bg: string; border: string }> = {
  kbf: {
    label: "KBF",
    color: "#a855f7",
    bg: "rgba(168,85,247,0.15)",
    border: "rgba(168,85,247,0.3)",
  },
  open: {
    label: "Open",
    color: "#3b82f6",
    bg: "rgba(59,130,246,0.15)",
    border: "rgba(59,130,246,0.3)",
  },
  race: {
    label: "Race",
    color: "#22c55e",
    bg: "rgba(34,197,94,0.15)",
    border: "rgba(34,197,94,0.3)",
  },
  attraction: {
    label: "Attr",
    color: "#f59e0b",
    bg: "rgba(245,158,11,0.15)",
    border: "rgba(245,158,11,0.3)",
  },
  // Gold treatment for the Ultimate VIP combo — matches the combo accentColor.
  vip: {
    label: "VIP",
    color: "#d4af37",
    bg: "rgba(212,175,55,0.18)",
    border: "rgba(212,175,55,0.45)",
  },
};

const KIND_FULL_LABELS: Record<string, string> = {
  kbf: "Kids Bowl Free",
  open: "Open Bowling",
  race: "Karting",
  attraction: "Attraction",
};

/**
 * Compact chip rendering the guest-survey funnel state. Three flavors:
 *   - "sent"      gray  — delivered but customer hasn't opened yet
 *   - "opened"    blue  — clicked the link, hasn't submitted
 *   - "completed" green — submitted + tells you which reward they picked
 *
 * Hidden when survey is null (no survey sent for this reservation).
 */
function SurveyChip({ survey }: { survey: Reservation["survey"] }) {
  if (!survey) return null;
  const palette =
    survey.status === "completed"
      ? { bg: "rgba(34,197,94,0.15)", fg: "#22c55e", border: "rgba(34,197,94,0.35)" }
      : survey.status === "opened"
        ? { bg: "rgba(59,130,246,0.15)", fg: "#3b82f6", border: "rgba(59,130,246,0.35)" }
        : { bg: "rgba(148,163,184,0.15)", fg: "#94a3b8", border: "rgba(148,163,184,0.35)" };
  const label =
    survey.status === "completed"
      ? survey.rewardKind === "pinz"
        ? `Survey: 500 Pinz`
        : survey.rewardKind === "gift_card"
          ? `Survey: $5 GC`
          : survey.rewardKind === "declined"
            ? `Survey: done`
            : `Survey: done`
      : survey.status === "opened"
        ? `Survey: opened`
        : `Survey: sent`;
  const tooltipBits: string[] = [`sent ${new Date(survey.sentAt).toLocaleString()}`];
  if (survey.openedAt) tooltipBits.push(`opened ${new Date(survey.openedAt).toLocaleString()}`);
  if (survey.completedAt)
    tooltipBits.push(`completed ${new Date(survey.completedAt).toLocaleString()}`);
  if (survey.channel) tooltipBits.push(`via ${survey.channel}`);
  return (
    <span
      title={tooltipBits.join(" · ")}
      style={{
        display: "inline-block",
        padding: "1px 5px",
        borderRadius: 4,
        fontSize: "0.6rem",
        fontWeight: 600,
        backgroundColor: palette.bg,
        color: palette.fg,
        border: `1px solid ${palette.border}`,
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </span>
  );
}

type ShoeCategory = "Toddler" | "Male" | "Female";
const SHOE_SIZES: Record<ShoeCategory, string[]> = {
  Toddler: ["6", "7", "8", "9", "10", "11", "12", "13"],
  Male: [
    "1",
    "1.5",
    "2",
    "2.5",
    "3",
    "3.5",
    "4",
    "4.5",
    "5",
    "5.5",
    "6",
    "6.5",
    "7",
    "7.5",
    "8",
    "8.5",
    "9",
    "9.5",
    "10",
    "10.5",
    "11",
    "11.5",
    "12",
    "12.5",
    "13",
    "13.5",
    "14",
    "14.5",
    "15",
  ],
  Female: [
    "1",
    "1.5",
    "2",
    "2.5",
    "3",
    "3.5",
    "4",
    "4.5",
    "5",
    "5.5",
    "6",
    "6.5",
    "7",
    "7.5",
    "8",
    "8.5",
    "9",
    "9.5",
    "10",
    "10.5",
    "11",
    "11.5",
    "12",
  ],
};
const SHOE_CATEGORY_LABELS: Record<ShoeCategory, string> = {
  Toddler: "Toddler",
  Male: "Men",
  Female: "Women",
};

/** Food items that should be displayed on the admin board */
const FOOD_RE = /pizza\s+bowl\s+pizza|pizza\s+bowl\s+soda|chips.+salsa/i;

function todayET(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  } catch {
    return iso;
  }
}

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      timeZone: "America/New_York",
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function confirmPath(r: Reservation): string | null {
  return r.shortCode ? `/s/${r.shortCode}` : null;
}

const INPUT_STYLE: React.CSSProperties = {
  backgroundColor: "var(--ba-input-bg)",
  border: "1px solid var(--ba-input-border)",
  borderRadius: 8,
  color: "var(--ba-fg)",
  padding: "0.5rem 0.75rem",
  fontSize: "0.875rem",
};

const NAV_BTN: React.CSSProperties = {
  backgroundColor: "var(--ba-input-bg)",
  border: "1px solid var(--ba-input-border)",
  borderRadius: 8,
  color: "var(--ba-muted)",
  padding: "0.5rem 0.75rem",
  fontSize: "0.875rem",
  cursor: "pointer",
};

// ── Bowling Resend (uses shared AdminResendModal) ────────────────────────

import AdminResendModal from "@/components/admin/AdminResendModal";

function BowlingResendModal({
  reservation,
  token,
  onClose,
  onSent,
}: {
  reservation: Reservation;
  token: string;
  onClose: () => void;
  onSent: (msg: string) => void;
}) {
  return (
    <AdminResendModal
      title="Resend Confirmation"
      channels={["both", "email", "sms"]}
      defaultChannel="both"
      originalPhone={reservation.guestPhone}
      originalEmail={reservation.guestEmail}
      onClose={onClose}
      contextSection={
        <div className="text-xs text-white/50 mb-3 space-y-0.5">
          <div>
            Guest: <span className="text-white/80">{reservation.guestName || "Guest"}</span>
          </div>
          {reservation.guestPhone && <div>{reservation.guestPhone}</div>}
          {reservation.guestEmail && <div>{reservation.guestEmail}</div>}
          <div>
            {KIND_BADGE[reservation.productKind]?.label ?? reservation.productKind} &middot;{" "}
            {fmtTime(reservation.bookedAt)} &middot;{" "}
            {CENTERS[reservation.centerCode] ?? reservation.centerCode}
          </div>
        </div>
      }
      onSend={async ({ channel, phone, email }) => {
        const body: Record<string, unknown> = {
          neonId: reservation.id,
          channel,
        };
        if (phone) body.overridePhone = phone;
        if (email) body.overrideEmail = email;

        const res = await fetch(
          `/api/admin/bowling/reservations/resend?token=${encodeURIComponent(token)}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          },
        );
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

        const parts: string[] = [];
        if (data.email) parts.push("Email sent");
        if (data.sms) parts.push("SMS sent");
        if (data.sms === false && (channel === "sms" || channel === "both"))
          parts.push("SMS failed");
        const msg = parts.join(", ") || "Sent";
        onSent(msg);
        return msg;
      }}
    />
  );
}

// ── Cancel Modal ─────────────────────────────────────────────────────────

function CancelModal({
  reservation,
  token,
  onClose,
  onCancelled,
}: {
  reservation: Reservation;
  token: string;
  onClose: () => void;
  onCancelled: () => void;
}) {
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleCancel() {
    setCancelling(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/admin/bowling/reservations/cancel?token=${encodeURIComponent(token)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ neonId: reservation.id }),
        },
      );
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || `HTTP ${res.status}`);
      } else {
        onCancelled();
        onClose();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setCancelling(false);
    }
  }

  const hasDeposit = reservation.depositCents > 0;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 50,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "1rem",
        backgroundColor: "var(--ba-overlay)",
        backdropFilter: "blur(4px)",
      }}
      {...modalBackdropProps(onClose)}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 400,
          backgroundColor: "var(--ba-modal-bg)",
          border: "1px solid rgba(239,68,68,0.3)",
          borderRadius: 16,
          padding: "1.5rem",
        }}
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
          <h3 style={{ fontSize: "1rem", fontWeight: 700, color: "#ef4444", margin: 0 }}>
            Cancel Reservation
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

        {/* Reservation info */}
        <div
          style={{
            padding: "0.75rem",
            borderRadius: 10,
            backgroundColor: "var(--ba-bg2)",
            border: "1px solid var(--ba-border)",
            marginBottom: "1rem",
            fontSize: "0.8rem",
            lineHeight: 1.7,
          }}
        >
          <div>
            <strong style={{ color: "var(--ba-fg)" }}>{reservation.guestName || "Guest"}</strong>
          </div>
          <div style={{ color: "var(--ba-muted)" }}>
            {fmtTime(reservation.bookedAt)} &middot; {fmtDate(reservation.bookedAt)} &middot;{" "}
            {CENTERS[reservation.centerCode] ?? reservation.centerCode}
          </div>
          <div style={{ color: "var(--ba-muted)" }}>
            {reservation.playerCount ?? 1} bowler{(reservation.playerCount ?? 1) > 1 ? "s" : ""}{" "}
            &middot; {KIND_FULL_LABELS[reservation.productKind] ?? reservation.productKind}
          </div>
          {hasDeposit && (
            <div style={{ color: "#22c55e", fontWeight: 600, marginTop: 2 }}>
              Deposit: {dollars(reservation.depositCents)}
            </div>
          )}
        </div>

        {/* Warning */}
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
          {hasDeposit
            ? "This will cancel the QAMF reservation and issue a full refund of the deposit to the customer’s card."
            : "This will cancel the QAMF reservation. No refund is needed (no deposit was charged)."}
        </div>

        {/* Error */}
        {error && (
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
        )}

        {/* Actions */}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button
            type="button"
            onClick={onClose}
            style={{
              ...NAV_BTN,
              fontSize: "0.8rem",
            }}
          >
            Keep It
          </button>
          <button
            type="button"
            onClick={handleCancel}
            disabled={cancelling}
            style={{
              padding: "0.5rem 1.25rem",
              borderRadius: 8,
              fontSize: "0.8rem",
              fontWeight: 700,
              cursor: cancelling ? "not-allowed" : "pointer",
              border: "none",
              backgroundColor: cancelling ? "rgba(239,68,68,0.3)" : "#ef4444",
              color: "#fff",
              opacity: cancelling ? 0.6 : 1,
            }}
          >
            {cancelling ? "Cancelling..." : "Cancel & Refund"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Reschedule Modal ──────────────────────────────────────────────────────

type SlotInfo = { bookedAt: string; webOfferId: number };
type RescheduleInfo = {
  webOfferId: number;
  optionId?: number;
  optionType?: string;
  centerId: number;
  playerCount: number;
};

function RescheduleModal({
  reservation,
  token,
  onClose,
  onRescheduled,
}: {
  reservation: Reservation;
  token: string;
  onClose: () => void;
  onRescheduled: (msg: string) => void;
}) {
  const [info, setInfo] = useState<RescheduleInfo | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [loadingInfo, setLoadingInfo] = useState(true);

  // Date defaults to the current booking date in ET
  const currentDateET = (() => {
    try {
      return new Date(reservation.bookedAt).toLocaleDateString("en-CA", {
        timeZone: "America/New_York",
      });
    } catch {
      return todayET();
    }
  })();
  const [selectedDate, setSelectedDate] = useState(currentDateET);
  const [slots, setSlots] = useState<SlotInfo[]>([]);
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [selectedSlot, setSelectedSlot] = useState<string | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch web offer info from QAMF on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const qs = new URLSearchParams({
          neonId: String(reservation.id),
          token,
        });
        const res = await fetch(`/api/admin/bowling/reservations/reschedule/info?${qs}`, {
          cache: "no-store",
        });
        const data = await res.json();
        if (!cancelled) {
          if (!res.ok) {
            setInfoError(data.error || `HTTP ${res.status}`);
          } else {
            setInfo(data as RescheduleInfo);
          }
        }
      } catch (err) {
        if (!cancelled) {
          setInfoError(err instanceof Error ? err.message : "Failed to load");
        }
      } finally {
        if (!cancelled) setLoadingInfo(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reservation.id, token]);

  // Fetch availability when date or info changes
  useEffect(() => {
    if (!info) return;
    let cancelled = false;
    setLoadingSlots(true);
    setSlots([]);
    setSelectedSlot(null);
    (async () => {
      try {
        const qs = new URLSearchParams({
          centerId: String(info.centerId),
          players: String(info.playerCount),
          startDate: selectedDate,
          webOfferId: String(info.webOfferId),
        });
        const res = await fetch(`/api/bowling/v2/availability?${qs}`, { cache: "no-store" });
        const data = await res.json();
        if (!cancelled && data.Availabilities) {
          // Filter to matching web offer (QAMF may return others)
          const matching = (
            data.Availabilities as Array<{ BookedAt: string; WebOffer: { Id: number } }>
          )
            .filter((a) => a.WebOffer.Id === info.webOfferId)
            .map((a) => ({ bookedAt: a.BookedAt, webOfferId: a.WebOffer.Id }));
          setSlots(matching);
        }
      } catch {
        // Slots will remain empty — user can try another date
      } finally {
        if (!cancelled) setLoadingSlots(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [info, selectedDate]);

  async function handleReschedule() {
    if (!selectedSlot || !info) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/admin/bowling/reservations/reschedule?token=${encodeURIComponent(token)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            neonId: reservation.id,
            bookedAt: selectedSlot,
            webOfferId: info.webOfferId,
            optionId: info.optionId,
            optionType: info.optionType,
          }),
        },
      );
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || `HTTP ${res.status}`);
      } else {
        const newTime = fmtTime(selectedSlot);
        const newDate = fmtDate(selectedSlot);
        onRescheduled(`Rescheduled to ${newTime} ${newDate} — confirmation resent`);
        onClose();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 50,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "1rem",
        backgroundColor: "var(--ba-overlay)",
        backdropFilter: "blur(4px)",
      }}
      {...modalBackdropProps(onClose)}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 480,
          backgroundColor: "var(--ba-modal-bg)",
          border: "1px solid rgba(0,226,229,0.25)",
          borderRadius: 16,
          padding: "1.5rem",
          maxHeight: "calc(100dvh - 2rem)",
          overflowY: "auto",
        }}
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
          <h3
            style={{
              fontSize: "1rem",
              fontWeight: 700,
              color: "#00E2E5",
              margin: 0,
              textTransform: "uppercase",
              letterSpacing: "0.05em",
            }}
          >
            Change Time
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

        {/* Current booking info */}
        <div
          style={{
            padding: "0.75rem",
            borderRadius: 10,
            backgroundColor: "var(--ba-bg2)",
            border: "1px solid var(--ba-border)",
            marginBottom: "1rem",
            fontSize: "0.8rem",
            lineHeight: 1.7,
          }}
        >
          <div>
            <strong style={{ color: "var(--ba-fg)" }}>{reservation.guestName || "Guest"}</strong>
          </div>
          <div style={{ color: "var(--ba-muted)" }}>
            Current: {fmtTime(reservation.bookedAt)} &middot; {fmtDate(reservation.bookedAt)}{" "}
            &middot; {CENTERS[reservation.centerCode] ?? reservation.centerCode}
          </div>
          <div style={{ color: "var(--ba-muted)" }}>
            {reservation.playerCount ?? 1} bowler{(reservation.playerCount ?? 1) > 1 ? "s" : ""}{" "}
            &middot; {KIND_FULL_LABELS[reservation.productKind] ?? reservation.productKind}
          </div>
        </div>

        {/* Note about same web offer */}
        <div
          style={{
            padding: "0.5rem 0.75rem",
            borderRadius: 8,
            backgroundColor: "rgba(0,226,229,0.06)",
            border: "1px solid rgba(0,226,229,0.15)",
            fontSize: "0.7rem",
            color: "var(--ba-muted)",
            marginBottom: "1rem",
          }}
        >
          Only times within the same experience/web offer are shown. Price and deposit stay the
          same.
        </div>

        {/* Loading info */}
        {loadingInfo && (
          <div style={{ textAlign: "center", padding: "2rem", color: "var(--ba-muted)" }}>
            Loading offer info...
          </div>
        )}

        {/* Info error */}
        {infoError && (
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
            {infoError}
          </div>
        )}

        {/* Date picker + time slots */}
        {info && !infoError && (
          <>
            <label style={{ display: "block", marginBottom: "0.75rem" }}>
              <span
                style={{
                  fontSize: "0.7rem",
                  color: "var(--ba-muted)",
                  display: "block",
                  marginBottom: 4,
                }}
              >
                New date
              </span>
              <input
                type="date"
                value={selectedDate}
                onChange={(e) => setSelectedDate(e.target.value)}
                style={{
                  ...INPUT_STYLE,
                  width: "100%",
                }}
              />
            </label>

            {/* Time slots */}
            <div style={{ marginBottom: "1rem" }}>
              <span
                style={{
                  fontSize: "0.7rem",
                  color: "var(--ba-muted)",
                  display: "block",
                  marginBottom: 6,
                }}
              >
                Available times
              </span>

              {loadingSlots ? (
                <div
                  style={{
                    textAlign: "center",
                    padding: "1.5rem",
                    color: "var(--ba-muted)",
                    fontSize: "0.8rem",
                  }}
                >
                  Checking availability...
                </div>
              ) : slots.length === 0 ? (
                <div
                  style={{
                    textAlign: "center",
                    padding: "1.5rem",
                    color: "var(--ba-muted)",
                    fontSize: "0.8rem",
                  }}
                >
                  No available times for this date. Try another date.
                </div>
              ) : (
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fill, minmax(90px, 1fr))",
                    gap: 6,
                    maxHeight: 200,
                    overflowY: "auto",
                    padding: 2,
                  }}
                >
                  {slots.map((slot) => {
                    const isSelected = selectedSlot === slot.bookedAt;
                    const isCurrent = slot.bookedAt === reservation.bookedAt;
                    return (
                      <button
                        key={slot.bookedAt}
                        type="button"
                        onClick={() => setSelectedSlot(slot.bookedAt)}
                        disabled={isCurrent}
                        style={{
                          padding: "0.4rem 0.5rem",
                          borderRadius: 8,
                          fontSize: "0.75rem",
                          fontWeight: 600,
                          cursor: isCurrent ? "not-allowed" : "pointer",
                          border: isSelected ? "1.5px solid #00E2E5" : "1px solid var(--ba-border)",
                          backgroundColor: isSelected
                            ? "rgba(0,226,229,0.15)"
                            : isCurrent
                              ? "var(--ba-bg2)"
                              : "var(--ba-input-bg)",
                          color: isSelected
                            ? "#00E2E5"
                            : isCurrent
                              ? "var(--ba-muted)"
                              : "var(--ba-fg)",
                        }}
                      >
                        {fmtTime(slot.bookedAt)}
                        {isCurrent && (
                          <span
                            style={{
                              display: "block",
                              fontSize: "0.55rem",
                              color: "var(--ba-muted)",
                              marginTop: 1,
                            }}
                          >
                            current
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </>
        )}

        {/* Error */}
        {error && (
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
        )}

        {/* Actions */}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button type="button" onClick={onClose} style={{ ...NAV_BTN, fontSize: "0.8rem" }}>
            Cancel
          </button>
          <button
            type="button"
            onClick={handleReschedule}
            disabled={submitting || !selectedSlot}
            style={{
              padding: "0.5rem 1.25rem",
              borderRadius: 8,
              fontSize: "0.8rem",
              fontWeight: 700,
              cursor: submitting || !selectedSlot ? "not-allowed" : "pointer",
              border: "none",
              backgroundColor: submitting || !selectedSlot ? "rgba(0,226,229,0.2)" : "#00E2E5",
              color: submitting || !selectedSlot ? "rgba(0,226,229,0.5)" : "#000418",
              opacity: submitting ? 0.6 : 1,
            }}
          >
            {submitting ? "Rescheduling..." : "Reschedule"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Check-In Modal ──────────────────────────────────────────────────────

function CheckInModal({
  reservation,
  token,
  onClose,
  onCheckedIn,
}: {
  reservation: Reservation;
  token: string;
  onClose: () => void;
  onCheckedIn: (msg: string) => void;
}) {
  const [phase, setPhase] = useState<string>("loading");
  const [laneLabel, setLaneLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [savingShoes, setSavingShoes] = useState(false);

  // Shoe sizes + optional names: one entry per player slot
  const playerCount = reservation.playerCount ?? 1;
  const [shoes, setShoes] = useState<Array<{ category: ShoeCategory | null; size: string | null }>>(
    () => Array.from({ length: playerCount }, () => ({ category: null, size: null })),
  );
  const [names, setNames] = useState<string[]>(() => Array.from({ length: playerCount }, () => ""));

  // Parse existing shoe size string like "Female 8" into category + size
  function parseShoeSize(raw: string | null): {
    category: ShoeCategory | null;
    size: string | null;
  } {
    if (!raw) return { category: null, size: null };
    const space = raw.indexOf(" ");
    if (space === -1) return { category: null, size: null };
    const cat = raw.slice(0, space);
    const sz = raw.slice(space + 1);
    if (cat === "Female" || cat === "Women") return { category: "Female", size: sz };
    if (cat === "Male" || cat === "Men") return { category: "Male", size: sz };
    if (cat === "Toddler" || cat === "Kids") return { category: "Toddler", size: sz };
    return { category: null, size: null };
  }

  // Fetch phase + existing players on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [phaseRes, playersRes] = await Promise.all([
          fetch(`/api/bowling/v2/reservations/${reservation.id}/checkin`, { cache: "no-store" }),
          fetch(`/api/bowling/v2/reservations/${reservation.id}/players`, { cache: "no-store" }),
        ]);
        if (cancelled) return;
        if (phaseRes.ok) {
          const pd = await phaseRes.json();
          setPhase(pd.phase || "not_ready");
          setLaneLabel(pd.laneLabel || "");
        } else {
          setPhase("error");
        }
        if (playersRes.ok) {
          const plData = await playersRes.json();
          const existing = (plData.players || []) as Array<{
            slot: number;
            name?: string | null;
            shoeSize?: string | null;
          }>;
          if (existing.length > 0) {
            setShoes((prev) =>
              prev.map((_, i) => {
                const player = existing.find((p) => p.slot === i + 1);
                return parseShoeSize(player?.shoeSize ?? null);
              }),
            );
            setNames((prev) =>
              prev.map((_, i) => {
                const player = existing.find((p) => p.slot === i + 1);
                const n = player?.name ?? "";
                return n.startsWith("Bowler ") ? "" : n;
              }),
            );
          }
        }
      } catch {
        if (!cancelled) setPhase("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reservation.id]);

  // Poll phase every 10s while not_ready
  useEffect(() => {
    if (phase !== "not_ready") return;
    const id = setInterval(async () => {
      try {
        const res = await fetch(`/api/bowling/v2/reservations/${reservation.id}/checkin`, {
          cache: "no-store",
        });
        if (res.ok) {
          const pd = await res.json();
          setPhase(pd.phase || "not_ready");
          setLaneLabel(pd.laneLabel || "");
        }
      } catch {
        /* ignore */
      }
    }, 10_000);
    return () => clearInterval(id);
  }, [phase, reservation.id]);

  function shoeString(s: { category: ShoeCategory | null; size: string | null }): string | null {
    if (!s.category || !s.size) return null;
    return `${s.category} ${s.size}`;
  }

  async function saveShoes() {
    const payload = shoes.map((s, i) => ({
      slot: i + 1,
      shoeSize: shoeString(s),
      name: names[i]?.trim() || `Bowler ${i + 1}`,
    }));
    const res = await fetch(`/api/bowling/v2/reservations/${reservation.id}/players`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ players: payload }),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      throw new Error(d.error || `Save shoes failed (${res.status})`);
    }
  }

  async function handleSaveShoesOnly() {
    setSavingShoes(true);
    setError(null);
    try {
      await saveShoes();
      onCheckedIn("Shoe sizes saved");
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setSavingShoes(false);
    }
  }

  async function handleCheckin() {
    setSubmitting(true);
    setError(null);
    try {
      // 1. Save shoe sizes
      await saveShoes();
      // 2. Open lanes (express check-in POST)
      const openRes = await fetch(`/api/bowling/v2/reservations/${reservation.id}/checkin`, {
        method: "POST",
        headers: { "content-type": "application/json" },
      });
      const openData = await openRes.json();
      if (!openRes.ok) throw new Error(openData.error || `Lane open failed (${openRes.status})`);
      // 3. Override method to "desk" (admin check-in)
      await fetch(`/api/admin/bowling/reservations/checkin?token=${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ neonId: reservation.id, method: "desk" }),
      });
      onCheckedIn(`Checked in — ${openData.laneLabel || laneLabel || "lanes opened"}`);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setSubmitting(false);
    }
  }

  // Phase banner colors
  const bannerStyle: Record<string, { bg: string; border: string; color: string; text: string }> = {
    loading: {
      bg: "var(--ba-bg2)",
      border: "var(--ba-border)",
      color: "var(--ba-muted)",
      text: "Loading lane status…",
    },
    not_ready: {
      bg: "rgba(245,158,11,0.1)",
      border: "rgba(245,158,11,0.25)",
      color: "#f59e0b",
      text: "Lanes not yet assigned — polling for updates…",
    },
    ready: {
      bg: "rgba(34,197,94,0.1)",
      border: "rgba(34,197,94,0.25)",
      color: "#22c55e",
      text: `${laneLabel || "Lane"} ready`,
    },
    running: {
      bg: "rgba(20,184,166,0.1)",
      border: "rgba(20,184,166,0.25)",
      color: "#14b8a6",
      text: `Already open — ${laneLabel || "lanes running"}`,
    },
    completed: {
      bg: "var(--ba-bg2)",
      border: "var(--ba-border)",
      color: "var(--ba-muted)",
      text: "Session completed",
    },
    cancelled: {
      bg: "var(--ba-bg2)",
      border: "var(--ba-border)",
      color: "var(--ba-muted)",
      text: "Reservation cancelled",
    },
    error: {
      bg: "rgba(239,68,68,0.1)",
      border: "rgba(239,68,68,0.25)",
      color: "#ef4444",
      text: "Failed to load lane status",
    },
  };
  const banner = bannerStyle[phase] || bannerStyle.error;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 50,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "1rem",
        backgroundColor: "var(--ba-overlay)",
        backdropFilter: "blur(4px)",
      }}
      {...modalBackdropProps(onClose)}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 500,
          backgroundColor: "var(--ba-modal-bg)",
          border: "1px solid var(--ba-modal-border)",
          borderRadius: 16,
          padding: "1.5rem",
          maxHeight: "calc(100dvh - 2rem)",
          overflowY: "auto",
        }}
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
          <h3
            style={{
              fontSize: "1rem",
              fontWeight: 700,
              color: "#22c55e",
              margin: 0,
              textTransform: "uppercase",
              letterSpacing: "0.05em",
            }}
          >
            Check In
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

        {/* Reservation info */}
        <div
          style={{
            padding: "0.75rem",
            borderRadius: 10,
            backgroundColor: "var(--ba-bg2)",
            border: "1px solid var(--ba-border)",
            marginBottom: "1rem",
            fontSize: "0.8rem",
            lineHeight: 1.7,
          }}
        >
          <div>
            <strong style={{ color: "var(--ba-fg)" }}>{reservation.guestName || "Guest"}</strong>
          </div>
          <div style={{ color: "var(--ba-muted)" }}>
            {fmtTime(reservation.bookedAt)} &middot; {fmtDate(reservation.bookedAt)} &middot;{" "}
            {CENTERS[reservation.centerCode] ?? reservation.centerCode}
          </div>
          <div style={{ color: "var(--ba-muted)" }}>
            {playerCount} bowler{playerCount > 1 ? "s" : ""} &middot;{" "}
            {KIND_FULL_LABELS[reservation.productKind] ?? reservation.productKind}
          </div>
        </div>

        {/* Phase banner */}
        <div
          style={{
            padding: "0.6rem 0.75rem",
            borderRadius: 8,
            backgroundColor: banner.bg,
            border: `1px solid ${banner.border}`,
            fontSize: "0.75rem",
            fontWeight: 600,
            color: banner.color,
            marginBottom: "1rem",
          }}
        >
          {banner.text}
        </div>

        {/* Shoe size picker */}
        {phase !== "loading" && phase !== "completed" && phase !== "cancelled" && (
          <div style={{ marginBottom: "1rem" }}>
            <span
              style={{
                fontSize: "0.7rem",
                color: "var(--ba-muted)",
                display: "block",
                marginBottom: 8,
                textTransform: "uppercase",
                letterSpacing: "0.05em",
                fontWeight: 600,
              }}
            >
              Shoe Sizes
            </span>
            {shoes.map((shoe, idx) => (
              <div
                key={idx}
                style={{
                  marginBottom: 10,
                  padding: "0.5rem",
                  borderRadius: 8,
                  backgroundColor: "var(--ba-bg2)",
                  border: "1px solid var(--ba-border)",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
                  <span
                    style={{
                      fontSize: "0.7rem",
                      fontWeight: 600,
                      color: "var(--ba-muted)",
                      whiteSpace: "nowrap",
                    }}
                  >
                    Bowler {idx + 1}
                  </span>
                  <input
                    type="text"
                    placeholder="Name (optional)"
                    value={names[idx] ?? ""}
                    onChange={(e) =>
                      setNames((prev) => prev.map((n, i) => (i === idx ? e.target.value : n)))
                    }
                    style={{
                      ...INPUT_STYLE,
                      padding: "0.2rem 0.5rem",
                      fontSize: "0.68rem",
                      flex: 1,
                    }}
                  />
                </div>
                {/* Category buttons */}
                <div style={{ display: "flex", gap: 4, marginBottom: shoe.category ? 6 : 0 }}>
                  {(["Toddler", "Male", "Female"] as ShoeCategory[]).map((cat) => (
                    <button
                      key={cat}
                      type="button"
                      onClick={() =>
                        setShoes((prev) =>
                          prev.map((s, i) =>
                            i === idx
                              ? { category: s.category === cat ? null : cat, size: null }
                              : s,
                          ),
                        )
                      }
                      style={{
                        padding: "0.25rem 0.6rem",
                        borderRadius: 6,
                        fontSize: "0.65rem",
                        fontWeight: 600,
                        cursor: "pointer",
                        border: `1px solid ${shoe.category === cat ? "rgba(0,226,229,0.4)" : "var(--ba-border)"}`,
                        backgroundColor:
                          shoe.category === cat ? "rgba(0,226,229,0.15)" : "var(--ba-input-bg)",
                        color: shoe.category === cat ? "#00E2E5" : "var(--ba-muted)",
                      }}
                    >
                      {SHOE_CATEGORY_LABELS[cat]}
                    </button>
                  ))}
                  {shoe.category && shoe.size && (
                    <span
                      style={{
                        marginLeft: "auto",
                        fontSize: "0.65rem",
                        fontWeight: 600,
                        color: "#00E2E5",
                      }}
                    >
                      {SHOE_CATEGORY_LABELS[shoe.category]} {shoe.size}
                    </span>
                  )}
                </div>
                {/* Size chips */}
                {shoe.category && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 3, marginTop: 4 }}>
                    {SHOE_SIZES[shoe.category].map((sz) => (
                      <button
                        key={sz}
                        type="button"
                        onClick={() =>
                          setShoes((prev) =>
                            prev.map((s, i) => (i === idx ? { ...s, size: sz } : s)),
                          )
                        }
                        style={{
                          padding: "0.2rem 0.4rem",
                          borderRadius: 5,
                          fontSize: "0.6rem",
                          fontWeight: 600,
                          cursor: "pointer",
                          minWidth: 28,
                          textAlign: "center",
                          border: `1px solid ${shoe.size === sz ? "#22c55e" : "var(--ba-border)"}`,
                          backgroundColor:
                            shoe.size === sz ? "rgba(34,197,94,0.15)" : "var(--ba-input-bg)",
                          color: shoe.size === sz ? "#22c55e" : "var(--ba-fg)",
                        }}
                      >
                        {sz}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Error */}
        {error && (
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
        )}

        {/* Actions */}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button type="button" onClick={onClose} style={{ ...NAV_BTN, fontSize: "0.8rem" }}>
            Close
          </button>
          {(phase === "not_ready" || phase === "running" || phase === "error") && (
            <button
              type="button"
              onClick={handleSaveShoesOnly}
              disabled={savingShoes}
              style={{
                padding: "0.5rem 1.25rem",
                borderRadius: 8,
                fontSize: "0.8rem",
                fontWeight: 700,
                cursor: savingShoes ? "not-allowed" : "pointer",
                border: "none",
                backgroundColor: savingShoes ? "rgba(0,226,229,0.2)" : "rgba(0,226,229,0.9)",
                color: savingShoes ? "rgba(0,226,229,0.5)" : "#000418",
                opacity: savingShoes ? 0.6 : 1,
              }}
            >
              {savingShoes ? "Saving…" : "Save Shoes"}
            </button>
          )}
          {phase === "ready" && (
            <button
              type="button"
              onClick={handleCheckin}
              disabled={submitting}
              style={{
                padding: "0.5rem 1.25rem",
                borderRadius: 8,
                fontSize: "0.8rem",
                fontWeight: 700,
                cursor: submitting ? "not-allowed" : "pointer",
                border: "none",
                backgroundColor: submitting ? "rgba(34,197,94,0.3)" : "#22c55e",
                color: "#fff",
                opacity: submitting ? 0.6 : 1,
              }}
            >
              {submitting ? "Checking in…" : "Check In & Open Lanes"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────

export default function ReservationsClient({ token }: { token: string }) {
  // Theme: "dark" (default) or "light" — set via URL ?theme= or portal postMessage
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    if (typeof window === "undefined") return "dark";
    const p = new URLSearchParams(window.location.search);
    return p.get("theme") === "light" ? "light" : "dark";
  });

  // Listen for theme changes from portal via postMessage
  // Portal sends { type: "portal.theme", value: "light" | "dark" }
  // targeted to the FastTrax origin. Also fires on iframe onLoad.
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.origin !== "https://portal.headpinz.com") return;
      if (
        e.data?.type === "portal.theme" &&
        (e.data.value === "dark" || e.data.value === "light")
      ) {
        setTheme(e.data.value);
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const [date, setDate] = useState(todayET);
  // Read ?center= slug from URL on mount (e.g. ?center=fm or ?center=naples)
  const [center, setCenter] = useState<string>(() => {
    if (typeof window === "undefined") return "";
    const p = new URLSearchParams(window.location.search);
    const slug = p.get("center")?.toLowerCase() || "";
    return CENTER_SLUGS[slug] || "";
  });
  const [search, setSearch] = useState("");
  const [hideCancelled, setHideCancelled] = useState(true);
  const [hideWalkins, setHideWalkins] = useState(true);
  const [kindFilter, setKindFilter] = useState<string | null>(null);
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [groupEvents, setGroupEvents] = useState<GroupEvent[]>([]);
  // VIP combos for the date, fetched UNSCOPED of center (a combo spans FastTrax
  // racing + HeadPinz bowling) so they surface in every location's portal view.
  const [vipReservations, setVipReservations] = useState<Reservation[]>([]);
  const [comboMeta, setComboMeta] = useState<Record<string, ComboMeta>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [resendTarget, setResendTarget] = useState<Reservation | null>(null);
  const [cancelTarget, setCancelTarget] = useState<Reservation | null>(null);
  const [rescheduleTarget, setRescheduleTarget] = useState<Reservation | null>(null);
  const [checkinTarget, setCheckinTarget] = useState<Reservation | null>(null);
  const [orderTarget, setOrderTarget] = useState<{
    guestName: string;
    squareDayofOrderId: string | null;
    rewardDiscountCents: number;
    squareLoyaltyRewardId?: string | null;
  } | null>(null);
  const [orderItems, setOrderItems] = useState<SquareLineItem[] | null>(null);
  const [orderLoading, setOrderLoading] = useState(false);
  const [orderMeta, setOrderMeta] = useState<{
    state: string;
    totalCents: number;
    taxCents: number;
    discountCents: number;
    remainingCents: number;
  } | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  async function setCheckinMethod(neonId: number, method: "self" | "desk" | null) {
    try {
      const res = await fetch(
        `/api/admin/bowling/reservations/checkin?token=${encodeURIComponent(token)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ neonId, method }),
        },
      );
      if (!res.ok) throw new Error("Failed");
      setReservations((prev) =>
        prev.map((r) => (r.id === neonId ? { ...r, checkinMethod: method ?? undefined } : r)),
      );
    } catch {
      setToast("Check-in update failed");
    }
  }

  const load = useCallback(
    async (opts?: { silent?: boolean }) => {
      const silent = opts?.silent ?? false;
      if (!silent) {
        setLoading(true);
        setError(null);
      }
      try {
        const params = new URLSearchParams({
          token,
          date,
          ...(center ? { center } : {}),
        });
        const res = await fetch(`/api/admin/bowling/reservations?${params}`, {
          cache: "no-store",
        });
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || `HTTP ${res.status}`);
        }
        const data = await res.json();
        setReservations(data.reservations ?? []);
        setGroupEvents(data.groupEvents ?? []);
        setVipReservations(data.vipReservations ?? []);
        setComboMeta(data.comboMeta ?? {});
        setError(null);
      } catch (err) {
        if (!silent) {
          setError(err instanceof Error ? err.message : "Failed to load");
          setReservations([]);
          setGroupEvents([]);
          setVipReservations([]);
          setComboMeta({});
        }
      } finally {
        setLoading(false);
      }
    },
    [token, date, center],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // Auto-refresh every 10s — silent so cards update inline without flash
  useEffect(() => {
    const id = setInterval(() => {
      void load({ silent: true });
    }, 10_000);
    return () => clearInterval(id);
  }, [load]);

  // Fetch Square order details when target is set
  useEffect(() => {
    if (!orderTarget?.squareDayofOrderId) return;
    setOrderLoading(true);
    setOrderItems(null);
    setOrderMeta(null);
    const params = new URLSearchParams({ token, orderId: orderTarget.squareDayofOrderId });
    fetch(`/api/admin/bowling/square-order?${params}`, { cache: "no-store" })
      .then((res) => res.json())
      .then((data) => {
        if (data.error) {
          setOrderItems([]);
          return;
        }
        setOrderItems(data.lineItems ?? []);
        setOrderMeta({
          state: data.state,
          totalCents: data.totalCents,
          taxCents: data.taxCents ?? 0,
          discountCents: data.discountCents ?? 0,
          remainingCents: data.remainingCents,
        });
      })
      .catch(() => setOrderItems([]))
      .finally(() => setOrderLoading(false));
  }, [orderTarget, token]);

  // Client-side search + cancelled filter + kind filter
  const filtered = useMemo(() => {
    let list = reservations;
    if (hideWalkins) {
      list = list.filter((r) => !r.bookingSource || r.bookingSource === "web");
    }
    if (hideCancelled) {
      list = list.filter((r) => r.status !== "cancelled" && r.status !== "completed");
    }
    if (kindFilter) {
      list = list.filter((r) => r.productKind === kindFilter);
    }
    if (search.trim()) {
      const q = search.toLowerCase().trim();
      list = list.filter((r) => {
        const fields = [
          r.guestName,
          r.guestEmail,
          r.guestPhone,
          r.qamfReservationId,
          r.notes,
          r.dayofOrderLane,
          String(r.id),
        ];
        return fields.some((f) => f?.toLowerCase().includes(q));
      });
    }
    return list;
  }, [reservations, search, hideCancelled, hideWalkins, kindFilter]);

  // VIP combos — group the legs (race + bowling) that share one day-of order.
  // A combo books as 2 rows with the same square_dayof_order_id; the bowling
  // leg carries the real lane + slot time, the race leg(s) are the karting heats.
  const comboGroups = useMemo(() => {
    const byOrder = new Map<string, Reservation[]>();
    for (const r of vipReservations) {
      const key = r.squareDayofOrderId || r.bmiBillId || `id-${r.id}`;
      const arr = byOrder.get(key) ?? [];
      arr.push(r);
      byOrder.set(key, arr);
    }
    const groups = Array.from(byOrder.entries()).map(([key, legs]) => {
      const sorted = [...legs].sort((a, b) => a.bookedAt.localeCompare(b.bookedAt));
      const bowling = sorted.find((l) => l.productKind === "open" || l.productKind === "kbf");
      const races = sorted.filter((l) => l.productKind === "race");
      // Anchor time = the bowling slot (real schedule); fall back to earliest leg.
      const anchor = bowling ?? sorted[0];
      const comboId = sorted.find((l) => l.comboSpecialId)?.comboSpecialId ?? "";
      const allCancelled = sorted.every(
        (l) => l.status === "cancelled" || l.status === "completed",
      );
      return {
        key,
        comboId,
        meta: comboMeta[comboId],
        legs: sorted,
        bowling,
        races,
        anchor,
        guestName: anchor.guestName ?? "Guest",
        guestPhone: anchor.guestPhone,
        playerCount: anchor.playerCount,
        centerCode: anchor.centerCode,
        lane: bowling?.dayofOrderLane,
        totalCents: sorted.reduce((s, l) => s + (l.totalCents ?? 0), 0),
        allCancelled,
      };
    });
    let out = groups;
    if (hideCancelled) out = out.filter((g) => !g.allCancelled);
    if (search.trim()) {
      const query = search.toLowerCase().trim();
      out = out.filter((g) =>
        g.legs.some((l) =>
          [l.guestName, l.guestEmail, l.guestPhone, l.qamfReservationId, l.dayofOrderLane].some(
            (f) => f?.toLowerCase().includes(query),
          ),
        ),
      );
    }
    return out.sort((a, b) => a.anchor.bookedAt.localeCompare(b.anchor.bookedAt));
  }, [vipReservations, comboMeta, hideCancelled, search]);

  const vipActive = kindFilter === "vip";

  // Group events respect the "Active Only" toggle just like reservations do:
  // hide completed events (cancelled/denied are already excluded server-side).
  const visibleGroupEvents = useMemo(
    () => (hideCancelled ? groupEvents.filter((g) => g.status !== "completed") : groupEvents),
    [groupEvents, hideCancelled],
  );

  // Stats
  const active = filtered.filter((r) => r.status !== "cancelled" && r.status !== "completed");
  const totalCancelledAll = reservations.filter((r) => r.status === "cancelled").length;
  const totalCompletedAll = reservations.filter((r) => r.status === "completed").length;
  const totalWalkins = reservations.filter(
    (r) => r.bookingSource && r.bookingSource !== "web",
  ).length;
  const totalHidden = totalCancelledAll + totalCompletedAll;
  const totalDeposit = active.reduce((s, r) => s + r.depositCents, 0);
  const totalRevenue = active.reduce((s, r) => s + r.totalCents, 0);
  const totalPlayers = active.reduce((s, r) => s + (r.playerCount ?? 0), 0);

  function copyLink(r: Reservation) {
    const path = confirmPath(r);
    if (!path) return;
    const url = `${window.location.origin}${path}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopiedId(r.id);
      setTimeout(() => setCopiedId((prev) => (prev === r.id ? null : prev)), 1500);
    });
  }

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 4000);
  }

  // Theme palette — CSS variable approach avoids touching 137 inline styles.
  // The <style> block sets variables on [data-theme], and key surface colors
  // reference them. Accent colors (status badges, pills) stay hardcoded
  // since they work on both backgrounds.
  const themeStyle =
    theme === "light"
      ? `
    [data-ba-theme="light"] { --ba-bg: #f8f9fb; --ba-fg: #1a1a2e; --ba-bg2: #ffffff; --ba-border: rgba(0,0,0,0.1); --ba-muted: rgba(0,0,0,0.45); --ba-muted2: rgba(0,0,0,0.08); --ba-hover: rgba(0,0,0,0.04); --ba-input-bg: #ffffff; --ba-input-border: rgba(0,0,0,0.15); --ba-shadow: rgba(0,0,0,0.08); --ba-modal-bg: #ffffff; --ba-modal-border: rgba(0,0,0,0.12); --ba-overlay: rgba(0,0,0,0.4); }
  `
      : `
    [data-ba-theme="dark"] { --ba-bg: #0a1628; --ba-fg: #fff; --ba-bg2: rgba(255,255,255,0.03); --ba-border: rgba(255,255,255,0.06); --ba-muted: rgba(255,255,255,0.35); --ba-muted2: rgba(255,255,255,0.06); --ba-hover: rgba(255,255,255,0.04); --ba-input-bg: rgba(255,255,255,0.05); --ba-input-border: rgba(255,255,255,0.1); --ba-shadow: rgba(0,0,0,0.5); --ba-modal-bg: #111827; --ba-modal-border: rgba(255,255,255,0.08); --ba-overlay: rgba(0,0,0,0.7); }
  `;

  return (
    <div
      data-ba-theme={theme}
      style={{
        minHeight: "100vh",
        backgroundColor: "var(--ba-bg)",
        color: "var(--ba-fg)",
        fontFamily: "system-ui, -apple-system, sans-serif",
        padding: "1rem",
      }}
    >
      {/* eslint-disable-next-line react/no-danger -- theme CSS variables */}
      <style dangerouslySetInnerHTML={{ __html: themeStyle }} />
      {/* Toast */}
      {toast && (
        <div
          style={{
            position: "fixed",
            top: 16,
            right: 16,
            zIndex: 60,
            padding: "0.75rem 1.25rem",
            borderRadius: 10,
            backgroundColor: "rgba(34,197,94,0.9)",
            color: "#fff",
            fontWeight: 600,
            fontSize: "0.85rem",
            boxShadow: "0 4px 20px rgba(0,0,0,0.4)",
          }}
        >
          {toast}
        </div>
      )}

      {/* Resend modal */}
      {resendTarget && (
        <BowlingResendModal
          reservation={resendTarget}
          token={token}
          onClose={() => setResendTarget(null)}
          onSent={(msg) => showToast(`${resendTarget.guestName || "Guest"}: ${msg}`)}
        />
      )}

      {/* Cancel modal */}
      {cancelTarget && (
        <CancelModal
          reservation={cancelTarget}
          token={token}
          onClose={() => setCancelTarget(null)}
          onCancelled={() => {
            showToast(`Reservation cancelled for ${cancelTarget.guestName || "guest"}`);
            void load();
          }}
        />
      )}

      {/* Reschedule modal */}
      {rescheduleTarget && (
        <RescheduleModal
          reservation={rescheduleTarget}
          token={token}
          onClose={() => setRescheduleTarget(null)}
          onRescheduled={(msg) => {
            showToast(`${rescheduleTarget.guestName || "Guest"}: ${msg}`);
            void load();
          }}
        />
      )}

      {/* Check-in modal */}
      {checkinTarget && (
        <CheckInModal
          reservation={checkinTarget}
          token={token}
          onClose={() => setCheckinTarget(null)}
          onCheckedIn={(msg) => {
            showToast(`${checkinTarget.guestName || "Guest"}: ${msg}`);
            void load();
          }}
        />
      )}

      {/* Square order details modal */}
      {orderTarget && (
        <div
          {...modalBackdropProps(() => {
            setOrderTarget(null);
            setOrderItems(null);
            setOrderMeta(null);
          })}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 50,
            background: "var(--ba-overlay)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
          }}
        >
          <div
            style={{
              background: "var(--ba-modal-bg)",
              borderRadius: 12,
              padding: 24,
              border: "1px solid var(--ba-modal-border)",
              maxWidth: 500,
              width: "100%",
              maxHeight: "80vh",
              overflow: "auto",
            }}
          >
            <h3 style={{ margin: "0 0 4px", fontSize: "0.95rem", fontWeight: 700 }}>
              Square Order — {orderTarget.guestName}
            </h3>
            <p
              style={{
                margin: "0 0 16px",
                color: "var(--ba-muted)",
                fontSize: "0.68rem",
                fontFamily: "monospace",
              }}
            >
              {orderTarget.squareDayofOrderId}
            </p>

            {orderLoading && (
              <p style={{ color: "var(--ba-muted)", fontSize: "0.8rem" }}>Loading…</p>
            )}

            {orderMeta && (
              <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 12 }}>
                <span
                  style={{
                    padding: "2px 8px",
                    borderRadius: 5,
                    fontSize: "0.65rem",
                    fontWeight: 600,
                    background:
                      orderMeta.state === "OPEN"
                        ? "rgba(59,130,246,0.15)"
                        : orderMeta.state === "COMPLETED"
                          ? "rgba(34,197,94,0.15)"
                          : "rgba(239,68,68,0.15)",
                    color:
                      orderMeta.state === "OPEN"
                        ? "#3b82f6"
                        : orderMeta.state === "COMPLETED"
                          ? "#22c55e"
                          : "#ef4444",
                    border: `1px solid ${orderMeta.state === "OPEN" ? "rgba(59,130,246,0.3)" : orderMeta.state === "COMPLETED" ? "rgba(34,197,94,0.3)" : "rgba(239,68,68,0.3)"}`,
                  }}
                >
                  {orderMeta.state}
                </span>
                {orderMeta.remainingCents > 0 && (
                  <span style={{ color: "var(--ba-muted)", fontSize: "0.75rem" }}>
                    Due:{" "}
                    <strong style={{ color: "#f59e0b" }}>
                      ${(orderMeta.remainingCents / 100).toFixed(2)}
                    </strong>
                  </span>
                )}
              </div>
            )}

            {orderTarget.rewardDiscountCents > 0 && (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  marginBottom: 12,
                  padding: "6px 10px",
                  borderRadius: 6,
                  background: "rgba(255,215,0,0.08)",
                  border: "1px solid rgba(255,215,0,0.2)",
                }}
              >
                <span style={{ fontSize: "0.85rem" }}>⭐</span>
                <span style={{ color: "#FFD700", fontSize: "0.75rem", fontWeight: 600 }}>
                  HeadPinz Reward −${(orderTarget.rewardDiscountCents / 100).toFixed(2)}
                </span>
                {orderTarget.squareLoyaltyRewardId && (
                  <span
                    style={{
                      color: "var(--ba-muted)",
                      fontSize: "0.6rem",
                      fontFamily: "monospace",
                    }}
                  >
                    {orderTarget.squareLoyaltyRewardId.slice(0, 8)}…
                  </span>
                )}
              </div>
            )}

            {orderItems &&
              orderItems.length > 0 &&
              (() => {
                const subtotalCents = orderItems.reduce((s, li) => s + li.grossCents, 0);
                const taxCents =
                  orderMeta?.taxCents ?? orderItems.reduce((s, li) => s + li.taxCents, 0);
                const discountCents =
                  orderMeta?.discountCents ?? orderItems.reduce((s, li) => s + li.discountCents, 0);
                const totalCents =
                  orderMeta?.totalCents ?? subtotalCents + taxCents - discountCents;
                return (
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.78rem" }}>
                    <thead>
                      <tr style={{ borderBottom: "1px solid var(--ba-border)" }}>
                        {["Item", "Qty", "Price"].map((h) => (
                          <th
                            key={h}
                            style={{
                              padding: "6px 8px",
                              textAlign: h === "Item" ? "left" : "right",
                              color: "var(--ba-muted)",
                              fontSize: "0.65rem",
                              textTransform: "uppercase",
                              fontWeight: 600,
                            }}
                          >
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {orderItems.map((li) => (
                        <tr key={li.uid} style={{ borderBottom: "1px solid var(--ba-border)" }}>
                          <td style={{ padding: "6px 8px" }}>
                            <div style={{ fontWeight: 600 }}>{li.name}</div>
                            {li.note && (
                              <div
                                style={{
                                  color: "var(--ba-muted)",
                                  fontSize: "0.68rem",
                                  fontStyle: "italic",
                                }}
                              >
                                {li.note}
                              </div>
                            )}
                          </td>
                          <td
                            style={{
                              padding: "6px 8px",
                              textAlign: "right",
                              color: "var(--ba-muted)",
                            }}
                          >
                            {li.quantity}
                          </td>
                          <td
                            style={{
                              padding: "6px 8px",
                              textAlign: "right",
                              fontWeight: 600,
                              color: li.grossCents === 0 ? "var(--ba-muted)" : "var(--ba-fg)",
                            }}
                          >
                            {li.grossCents === 0 ? "$0" : `$${(li.grossCents / 100).toFixed(2)}`}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr style={{ borderTop: "1px solid var(--ba-border)" }}>
                        <td
                          colSpan={2}
                          style={{
                            padding: "5px 8px",
                            textAlign: "right",
                            color: "var(--ba-muted)",
                            fontSize: "0.72rem",
                          }}
                        >
                          Subtotal
                        </td>
                        <td
                          style={{
                            padding: "5px 8px",
                            textAlign: "right",
                            color: "var(--ba-fg)",
                            fontSize: "0.72rem",
                          }}
                        >
                          ${(subtotalCents / 100).toFixed(2)}
                        </td>
                      </tr>
                      {taxCents > 0 && (
                        <tr>
                          <td
                            colSpan={2}
                            style={{
                              padding: "2px 8px",
                              textAlign: "right",
                              color: "var(--ba-muted)",
                              fontSize: "0.72rem",
                            }}
                          >
                            Tax
                          </td>
                          <td
                            style={{
                              padding: "2px 8px",
                              textAlign: "right",
                              color: "var(--ba-muted)",
                              fontSize: "0.72rem",
                            }}
                          >
                            ${(taxCents / 100).toFixed(2)}
                          </td>
                        </tr>
                      )}
                      {discountCents > 0 && (
                        <tr>
                          <td
                            colSpan={2}
                            style={{
                              padding: "2px 8px",
                              textAlign: "right",
                              color: "#f59e0b",
                              fontSize: "0.72rem",
                            }}
                          >
                            Discount
                          </td>
                          <td
                            style={{
                              padding: "2px 8px",
                              textAlign: "right",
                              color: "#f59e0b",
                              fontSize: "0.72rem",
                            }}
                          >
                            −${(discountCents / 100).toFixed(2)}
                          </td>
                        </tr>
                      )}
                      <tr style={{ borderTop: "1px solid var(--ba-border)" }}>
                        <td
                          colSpan={2}
                          style={{
                            padding: "5px 8px",
                            textAlign: "right",
                            fontWeight: 700,
                            fontSize: "0.78rem",
                          }}
                        >
                          Total
                        </td>
                        <td
                          style={{
                            padding: "5px 8px",
                            textAlign: "right",
                            fontWeight: 700,
                            fontSize: "0.78rem",
                          }}
                        >
                          ${(totalCents / 100).toFixed(2)}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                );
              })()}

            {orderItems && orderItems.length === 0 && (
              <p style={{ color: "var(--ba-muted)", fontSize: "0.8rem" }}>No line items</p>
            )}

            <div style={{ marginTop: 16, textAlign: "right" }}>
              <button
                type="button"
                onClick={() => {
                  setOrderTarget(null);
                  setOrderItems(null);
                  setOrderMeta(null);
                }}
                style={{
                  padding: "6px 16px",
                  borderRadius: 6,
                  fontSize: "0.75rem",
                  background: "var(--ba-input-bg)",
                  border: "1px solid var(--ba-input-border)",
                  color: "var(--ba-fg)",
                  cursor: "pointer",
                  fontWeight: 600,
                }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Filters */}
      <div style={{ maxWidth: 1200, margin: "0 auto", marginBottom: "1.5rem" }}>
        <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", alignItems: "center" }}>
          <button
            type="button"
            onClick={() => setHideCancelled((v) => !v)}
            style={{
              ...NAV_BTN,
              fontSize: "0.75rem",
              fontWeight: 600,
              backgroundColor: hideCancelled ? "rgba(34,197,94,0.15)" : "var(--ba-input-bg)",
              borderColor: hideCancelled ? "rgba(34,197,94,0.3)" : "var(--ba-input-border)",
              color: hideCancelled ? "#22c55e" : "var(--ba-muted)",
            }}
          >
            {hideCancelled ? "Active Only" : "All Statuses"}
          </button>
          <button
            type="button"
            onClick={() => setHideWalkins((v) => !v)}
            style={{
              ...NAV_BTN,
              fontSize: "0.75rem",
              fontWeight: 600,
              backgroundColor: hideWalkins ? "rgba(34,197,94,0.15)" : "var(--ba-input-bg)",
              borderColor: hideWalkins ? "rgba(34,197,94,0.3)" : "var(--ba-input-border)",
              color: hideWalkins ? "#22c55e" : "var(--ba-muted)",
            }}
          >
            {hideWalkins ? "Web Only" : "All Sources"}
          </button>
          {(["kbf", "open", "race", "attraction"] as const).map((k) => {
            const badge = KIND_BADGE[k];
            const isActive = kindFilter === k;
            return (
              <button
                key={k}
                type="button"
                onClick={() => setKindFilter(isActive ? null : k)}
                style={{
                  ...NAV_BTN,
                  fontSize: "0.7rem",
                  fontWeight: 600,
                  backgroundColor: isActive ? badge.bg : "var(--ba-input-bg)",
                  borderColor: isActive ? badge.border : "var(--ba-input-border)",
                  color: isActive ? badge.color : "var(--ba-muted)",
                }}
              >
                {badge.label}
                <span style={{ marginLeft: 3, opacity: 0.7, fontSize: "0.6rem" }}>
                  ({reservations.filter((r) => r.productKind === k).length})
                </span>
              </button>
            );
          })}
          {/* VIP combos — special filter (not a productKind). Always shows all
              VIP combos for the date across centers (FastTrax + HeadPinz). */}
          {(() => {
            const badge = KIND_BADGE.vip;
            const count = new Set(
              vipReservations.map((r) => r.squareDayofOrderId || r.bmiBillId || `id-${r.id}`),
            ).size;
            return (
              <button
                type="button"
                onClick={() => setKindFilter(vipActive ? null : "vip")}
                style={{
                  ...NAV_BTN,
                  fontSize: "0.7rem",
                  fontWeight: 700,
                  backgroundColor: vipActive ? badge.bg : "var(--ba-input-bg)",
                  borderColor: vipActive ? badge.border : "var(--ba-input-border)",
                  color: vipActive ? badge.color : "var(--ba-muted)",
                }}
              >
                ★ {badge.label}
                <span style={{ marginLeft: 3, opacity: 0.7, fontSize: "0.6rem" }}>({count})</span>
              </button>
            );
          })()}
          <button
            type="button"
            onClick={() => setDate(todayET())}
            style={{
              ...NAV_BTN,
              fontSize: "0.75rem",
              textTransform: "uppercase",
              letterSpacing: "0.05em",
              fontWeight: 600,
            }}
          >
            Today
          </button>
          <button
            type="button"
            onClick={() => {
              const d = new Date(date + "T12:00:00");
              d.setDate(d.getDate() - 1);
              setDate(d.toISOString().slice(0, 10));
            }}
            style={NAV_BTN}
          >
            &larr;
          </button>
          <button
            type="button"
            onClick={() => {
              const d = new Date(date + "T12:00:00");
              d.setDate(d.getDate() + 1);
              setDate(d.toISOString().slice(0, 10));
            }}
            style={NAV_BTN}
          >
            &rarr;
          </button>
          <span style={{ color: "var(--ba-muted)", fontSize: "0.875rem" }}>
            {fmtDate(date + "T12:00:00")}
          </span>
        </div>

        {/* Search */}
        <div style={{ marginTop: "0.75rem" }}>
          <input
            type="text"
            placeholder="Search name, email, phone, QAMF ID, lane..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{
              ...INPUT_STYLE,
              width: "100%",
              maxWidth: 400,
            }}
          />
        </div>

        {/* Stats bar */}
        {!loading && filtered.length > 0 && (
          <div
            style={{
              display: "flex",
              gap: "1.5rem",
              marginTop: "0.75rem",
              fontSize: "0.8rem",
              color: "var(--ba-muted)",
              flexWrap: "wrap",
            }}
          >
            <span>
              <strong style={{ color: "var(--ba-fg)" }}>{active.length}</strong> active
              {hideCancelled && totalHidden > 0 && (
                <span style={{ color: "var(--ba-muted)" }}>
                  {" "}
                  + {totalHidden} hidden
                  {totalCancelledAll > 0 && totalCompletedAll > 0
                    ? ` (${totalCancelledAll} cancelled, ${totalCompletedAll} completed)`
                    : totalCancelledAll > 0
                      ? " (cancelled)"
                      : " (completed)"}
                </span>
              )}
              {!hideCancelled && totalCancelledAll > 0 && (
                <span style={{ color: "rgba(239,68,68,0.7)" }}>
                  {" "}
                  · {totalCancelledAll} cancelled
                </span>
              )}
              {hideWalkins && totalWalkins > 0 && (
                <span style={{ color: "var(--ba-muted)" }}> · {totalWalkins} walk-in</span>
              )}
            </span>
            <span>
              <strong style={{ color: "var(--ba-fg)" }}>{totalPlayers}</strong> bowlers
            </span>
            <span>
              Deposits <strong style={{ color: "#22c55e" }}>{dollars(totalDeposit)}</strong>
            </span>
            <span>
              Total <strong style={{ color: "#22c55e" }}>{dollars(totalRevenue)}</strong>
            </span>
          </div>
        )}
      </div>

      {/* Content */}
      <div style={{ maxWidth: 1200, margin: "0 auto" }}>
        {loading ? (
          <div style={{ textAlign: "center", padding: "3rem", color: "var(--ba-muted)" }}>
            Loading...
          </div>
        ) : error ? (
          <div
            style={{
              textAlign: "center",
              padding: "2rem",
              color: "#ef4444",
              backgroundColor: "rgba(239,68,68,0.1)",
              borderRadius: 12,
              border: "1px solid rgba(239,68,68,0.3)",
            }}
          >
            {error}
          </div>
        ) : vipActive ? (
          comboGroups.length === 0 ? (
            <div style={{ textAlign: "center", padding: "3rem", color: "var(--ba-muted)" }}>
              {search ? "No matching VIP combos." : "No VIP combos for this date."}
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 700,
                  textTransform: "uppercase",
                  letterSpacing: 1,
                  color: "#d4af37",
                  marginBottom: 4,
                }}
              >
                ★ VIP Combos ({comboGroups.length}) — all centers
              </div>
              {comboGroups.map((g) => {
                const name = g.meta?.name ?? "VIP Combo";
                const accent = g.meta?.accentColor ?? "#d4af37";
                const steps = g.meta?.includes ?? [
                  "Starter Race",
                  "1.5 Hours of VIP Bowling",
                  "Intermediate Race",
                ];
                const bowlingTime = g.bowling ? fmtTime(g.bowling.bookedAt) : null;
                return (
                  <div
                    key={g.key}
                    style={{
                      borderRadius: 12,
                      border: "1px solid rgba(212,175,55,0.45)",
                      borderLeft: `4px solid ${accent}`,
                      background: "rgba(212,175,55,0.06)",
                      padding: "14px 16px",
                      opacity: g.allCancelled ? 0.55 : 1,
                    }}
                  >
                    {/* Header */}
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "baseline",
                        gap: 8,
                        flexWrap: "wrap",
                      }}
                    >
                      <div style={{ fontWeight: 700, color: "var(--ba-fg)", fontSize: "1rem" }}>
                        <span style={{ color: accent }}>★</span> {name}
                      </div>
                      <div style={{ fontWeight: 700, color: "#22c55e" }}>
                        {dollars(g.totalCents)}
                      </div>
                    </div>

                    {/* Guest line */}
                    <div
                      style={{
                        fontSize: "0.85rem",
                        color: "var(--ba-muted)",
                        marginTop: 2,
                        marginBottom: 10,
                      }}
                    >
                      {g.guestName}
                      {g.guestPhone ? ` · ${g.guestPhone}` : ""}
                      {g.playerCount ? ` · ${g.playerCount}p` : ""} · {centerLabel(g.centerCode)}
                    </div>

                    {/* Itinerary / schedule */}
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      {steps.map((step, i) => {
                        const isBowling = /bowl/i.test(step);
                        const isRace = /race/i.test(step);
                        const icon = isBowling ? "🎳" : isRace ? "🏁" : "•";
                        const loc = isBowling
                          ? `HeadPinz ${centerLabel(g.centerCode)}`
                          : isRace
                            ? "FastTrax"
                            : "";
                        return (
                          <div
                            key={i}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 8,
                              fontSize: "0.85rem",
                              color: "var(--ba-fg)",
                            }}
                          >
                            <span style={{ width: 18, textAlign: "center" }}>{icon}</span>
                            <span style={{ flex: 1 }}>{step}</span>
                            {isBowling && bowlingTime && (
                              <span style={{ fontWeight: 700, color: accent }}>
                                {bowlingTime}
                                {g.lane ? ` · Lane ${g.lane}` : ""}
                              </span>
                            )}
                            {loc && (
                              <span style={{ color: "var(--ba-muted)", fontSize: "0.75rem" }}>
                                {loc}
                              </span>
                            )}
                          </div>
                        );
                      })}
                    </div>

                    {/* Per-leg status + actions */}
                    <div
                      style={{
                        display: "flex",
                        flexWrap: "wrap",
                        gap: 8,
                        marginTop: 12,
                        paddingTop: 10,
                        borderTop: "1px solid var(--ba-input-border)",
                      }}
                    >
                      {g.legs.map((leg) => (
                        <div
                          key={leg.id}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 6,
                            fontSize: "0.72rem",
                            color: "var(--ba-muted)",
                            border: "1px solid var(--ba-input-border)",
                            borderRadius: 8,
                            padding: "3px 8px",
                          }}
                        >
                          <span
                            style={{
                              fontWeight: 700,
                              color: KIND_BADGE[leg.productKind]?.color ?? "var(--ba-fg)",
                            }}
                          >
                            {KIND_FULL_LABELS[leg.productKind] ?? leg.productKind}
                          </span>
                          <span
                            style={{
                              width: 8,
                              height: 8,
                              borderRadius: "50%",
                              backgroundColor: STATUS_COLORS[leg.status] ?? "#6b7280",
                              display: "inline-block",
                            }}
                          />
                          <span>{STATUS_LABELS[leg.status] ?? leg.status}</span>
                          {leg.qamfReservationId && <span>· QAMF {leg.qamfReservationId}</span>}
                          {leg.dayofOrderLane && <span>· Lane {leg.dayofOrderLane}</span>}
                        </div>
                      ))}
                      {g.anchor.squareDayofOrderId && (
                        <button
                          type="button"
                          onClick={() =>
                            setOrderTarget({
                              guestName: g.guestName,
                              squareDayofOrderId: g.anchor.squareDayofOrderId ?? null,
                              rewardDiscountCents: g.anchor.rewardDiscountCents ?? 0,
                              squareLoyaltyRewardId: g.anchor.squareLoyaltyRewardId,
                            })
                          }
                          style={{
                            ...NAV_BTN,
                            fontSize: "0.72rem",
                            fontWeight: 600,
                            marginLeft: "auto",
                          }}
                        >
                          View order
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )
        ) : filtered.length === 0 && visibleGroupEvents.length === 0 ? (
          <div style={{ textAlign: "center", padding: "3rem", color: "var(--ba-muted)" }}>
            {search ? "No matching reservations." : "No reservations for this date."}
          </div>
        ) : (
          <>
            {/* ── Group Function Events ────────────────────────── */}
            {visibleGroupEvents.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 700,
                    textTransform: "uppercase",
                    letterSpacing: 1,
                    color: "#22d3ee",
                    marginBottom: 8,
                  }}
                >
                  Group Events ({visibleGroupEvents.length})
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {visibleGroupEvents.map((ge) => {
                    const statusColors: Record<string, string> = {
                      contract_sent: "#f59e0b",
                      deposit_paid: "#22c55e",
                      balance_charged: "#22d3ee",
                      completed: "#22d3ee",
                      resign_required: "#ef4444",
                      cancelled: "#ef4444",
                    };
                    const sColor = statusColors[ge.status] || "#94a3b8";
                    const fmtD = (c: number) => `$${(c / 100).toFixed(2)}`;
                    return (
                      <div
                        key={ge.id}
                        style={{
                          borderRadius: 8,
                          border: `1px solid ${sColor}33`,
                          backgroundColor: "var(--ba-bg2)",
                          padding: "10px 12px",
                        }}
                      >
                        {/* Row 1: identity (name · #num · date · guest · phone · guests · planner)
                            + status, on a single wrapping line to stay compact on desktop. */}
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "baseline",
                            gap: 8,
                            flexWrap: "wrap",
                          }}
                        >
                          <div
                            style={{
                              display: "flex",
                              alignItems: "baseline",
                              flexWrap: "wrap",
                              gap: "2px 10px",
                              minWidth: 0,
                              fontSize: 12,
                              color: "var(--ba-muted)",
                            }}
                          >
                            <span style={{ fontWeight: 700, fontSize: 14, color: "var(--ba-fg)" }}>
                              {ge.eventName}
                            </span>
                            <span style={{ fontSize: 11 }}>#{ge.eventNumber}</span>
                            <span>{ge.eventDateDisplay}</span>
                            <span>{ge.guestName}</span>
                            {ge.guestPhone && <span>{ge.guestPhone}</span>}
                            {ge.guestCount && <span>{ge.guestCount} guests</span>}
                            {ge.plannerName && <span>Planner: {ge.plannerName}</span>}
                          </div>
                          <span
                            style={{
                              fontSize: 11,
                              fontWeight: 600,
                              color: sColor,
                              textTransform: "uppercase",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {ge.status.replace(/_/g, " ")}
                          </span>
                        </div>
                        {/* Row 2: money · GAN · card · status badges, with the
                            contract/order actions pushed to the right edge. */}
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            flexWrap: "wrap",
                            gap: "4px 12px",
                            fontSize: 12,
                            marginTop: 4,
                          }}
                        >
                          <span
                            style={{
                              color: ge.depositPaidAt ? "#22c55e" : "#94a3b8",
                              fontWeight: 600,
                            }}
                          >
                            Deposit: {fmtD(ge.depositDueCents)}
                            {ge.depositPaidAt ? " ✓ Paid" : ""}
                          </span>
                          <span
                            style={{
                              color:
                                ge.balanceCents > 0 && !ge.balancePaidAt
                                  ? "#f59e0b"
                                  : ge.balancePaidAt
                                    ? "#22c55e"
                                    : undefined,
                            }}
                          >
                            Balance{!ge.balancePaidAt && ge.balanceCents > 0 ? " Due" : ""}:{" "}
                            {fmtD(ge.balanceCents)}
                            {ge.balancePaidAt ? " ✓ Paid" : ""}
                          </span>
                          <span style={{ fontWeight: 700 }}>Total: {fmtD(ge.totalCents)}</span>
                          {ge.squareGiftCardGan && (
                            <span style={{ fontSize: 11, color: "var(--ba-muted)" }}>
                              GAN:{" "}
                              {(() => {
                                try {
                                  const g = JSON.parse(ge.squareGiftCardGan);
                                  return Array.isArray(g) ? g.join(", ") : ge.squareGiftCardGan;
                                } catch {
                                  return ge.squareGiftCardGan;
                                }
                              })()}
                            </span>
                          )}
                          {ge.savedCardId && (
                            <span style={{ fontSize: 11, color: "#22c55e" }}>Card on file</span>
                          )}
                          {!ge.savedCardId && ge.depositPaidAt && (
                            <span style={{ fontSize: 11, color: "#f59e0b" }}>No card saved</span>
                          )}
                          {ge.depositPaidAt && (
                            <span
                              style={{
                                display: "inline-block",
                                padding: "0 4px",
                                borderRadius: 3,
                                fontSize: 10,
                                fontWeight: 600,
                                backgroundColor: "rgba(34,197,94,0.15)",
                                color: "#22c55e",
                                border: "1px solid rgba(34,197,94,0.3)",
                              }}
                            >
                              Deposit Paid
                            </span>
                          )}
                          {ge.balancePaidAt && (
                            <span
                              style={{
                                display: "inline-block",
                                padding: "0 4px",
                                borderRadius: 3,
                                fontSize: 10,
                                fontWeight: 600,
                                backgroundColor: "rgba(34,211,238,0.15)",
                                color: "#22d3ee",
                                border: "1px solid rgba(34,211,238,0.3)",
                              }}
                            >
                              Balance Paid
                            </span>
                          )}
                          {ge.squareDayofOrderId && !ge.balancePaidAt && (
                            <span
                              style={{
                                display: "inline-block",
                                padding: "0 4px",
                                borderRadius: 3,
                                fontSize: 10,
                                fontWeight: 600,
                                backgroundColor: "rgba(245,158,11,0.15)",
                                color: "#f59e0b",
                                border: "1px solid rgba(245,158,11,0.3)",
                              }}
                            >
                              Balance Pending
                            </span>
                          )}
                          {(ge.contractShortId || ge.squareDayofOrderId) && (
                            <span style={{ marginLeft: "auto", display: "flex", gap: 12 }}>
                              {ge.contractShortId && (
                                <a
                                  href={`/contract/${ge.contractShortId}`}
                                  target="_blank"
                                  rel="noopener"
                                  style={{
                                    fontSize: 11,
                                    color: "#22d3ee",
                                    textDecoration: "none",
                                    fontWeight: 600,
                                  }}
                                >
                                  View Contract
                                </a>
                              )}
                              {ge.squareDayofOrderId && (
                                <button
                                  type="button"
                                  onClick={() =>
                                    setOrderTarget({
                                      guestName: ge.eventName,
                                      squareDayofOrderId: ge.squareDayofOrderId,
                                      rewardDiscountCents: 0,
                                    })
                                  }
                                  style={{
                                    background: "none",
                                    border: "none",
                                    cursor: "pointer",
                                    padding: 0,
                                    fontSize: 11,
                                    color: "#22d3ee",
                                    fontWeight: 600,
                                    textDecoration: "underline",
                                    textDecorationColor: "rgba(34,211,238,0.3)",
                                  }}
                                >
                                  View Square Order
                                </button>
                              )}
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* ── Mobile card list (<md) ────────────────────────── */}
            <div className="md:hidden flex flex-col gap-1.5">
              {filtered.map((r) => {
                const isCancelled = r.status === "cancelled";
                const centerShort = CENTERS[r.centerCode] === "Fort Myers" ? "FM" : "NAP";
                const hasAttr = (r.attractionBookings?.length ?? 0) > 0;
                const cPath = confirmPath(r);
                return (
                  <div
                    key={r.id}
                    style={{
                      borderRadius: 8,
                      border: "1px solid var(--ba-border)",
                      backgroundColor: "var(--ba-bg2)",
                      opacity: isCancelled ? 0.45 : 1,
                      padding: "8px 10px",
                    }}
                  >
                    {/* Row 1: time · name · center ——— badges */}
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                          minWidth: 0,
                          flex: 1,
                        }}
                      >
                        <span
                          style={{
                            fontSize: "0.7rem",
                            fontWeight: 600,
                            color: "var(--ba-fg)",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {fmtTime(r.bookedAt)}
                        </span>
                        <span
                          style={{
                            fontWeight: 700,
                            fontSize: "0.8rem",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {r.guestName ||
                            (r.bookingSource && r.bookingSource !== "web" ? (
                              <span
                                style={{
                                  color: SOURCE_COLORS[r.bookingSource] ?? "var(--ba-muted)",
                                }}
                              >
                                {SOURCE_LABELS[r.bookingSource] ?? r.bookingSource}
                              </span>
                            ) : (
                              "—"
                            ))}
                        </span>
                        <span
                          style={{
                            fontSize: "0.55rem",
                            color: "var(--ba-muted)",
                            fontWeight: 500,
                            whiteSpace: "nowrap",
                          }}
                        >
                          {centerShort}
                        </span>
                      </div>
                      <div
                        style={{
                          display: "flex",
                          gap: 3,
                          alignItems: "center",
                          flexShrink: 0,
                          marginLeft: 6,
                        }}
                      >
                        <span
                          style={{
                            padding: "1px 5px",
                            borderRadius: 4,
                            fontSize: "0.6rem",
                            fontWeight: 600,
                            backgroundColor: `${STATUS_COLORS[r.status] ?? "#6b7280"}20`,
                            color: STATUS_COLORS[r.status] ?? "#6b7280",
                            border: `1px solid ${STATUS_COLORS[r.status] ?? "#6b7280"}40`,
                          }}
                        >
                          {STATUS_LABELS[r.status] ?? r.status}
                        </span>
                        <SurveyChip survey={r.survey} />
                        {r.checkinMethod === "self" ? (
                          <span
                            style={{
                              padding: "1px 4px",
                              borderRadius: 4,
                              fontSize: "0.55rem",
                              fontWeight: 600,
                              backgroundColor: "rgba(168,85,247,0.15)",
                              color: "#a855f7",
                              border: "1px solid rgba(168,85,247,0.3)",
                            }}
                          >
                            Self
                          </span>
                        ) : r.checkinMethod === "desk" ? (
                          <span
                            style={{
                              padding: "1px 4px",
                              borderRadius: 4,
                              fontSize: "0.55rem",
                              fontWeight: 600,
                              backgroundColor: "rgba(20,184,166,0.15)",
                              color: "#14b8a6",
                              border: "1px solid rgba(20,184,166,0.3)",
                            }}
                          >
                            Admin
                          </span>
                        ) : r.checkinMethod ? (
                          <span
                            style={{
                              padding: "1px 4px",
                              borderRadius: 4,
                              fontSize: "0.55rem",
                              fontWeight: 600,
                              backgroundColor: "rgba(107,114,128,0.15)",
                              color: "#9ca3af",
                              border: "1px solid rgba(107,114,128,0.3)",
                            }}
                          >
                            {r.checkinMethod}
                          </span>
                        ) : r.preArrivalSentAt ? (
                          <span
                            style={{
                              padding: "1px 4px",
                              borderRadius: 4,
                              fontSize: "0.55rem",
                              fontWeight: 600,
                              backgroundColor: "rgba(59,130,246,0.15)",
                              color: "#60a5fa",
                              border: "1px solid rgba(59,130,246,0.3)",
                            }}
                          >
                            SMS
                          </span>
                        ) : null}
                      </div>
                    </div>

                    {/* Row 2: phone · type · players · source · lane · payment */}
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        marginTop: 4,
                        flexWrap: "wrap",
                        fontSize: "0.68rem",
                      }}
                    >
                      {r.guestPhone && (
                        <span style={{ color: "var(--ba-muted)" }}>{r.guestPhone}</span>
                      )}
                      <span
                        style={{
                          padding: "0px 4px",
                          borderRadius: 3,
                          fontSize: "0.6rem",
                          fontWeight: 600,
                          textTransform: "uppercase",
                          letterSpacing: "0.02em",
                          backgroundColor: KIND_BADGE[r.productKind]?.bg ?? "rgba(59,130,246,0.15)",
                          color: KIND_BADGE[r.productKind]?.color ?? "#3b82f6",
                          border: `1px solid ${KIND_BADGE[r.productKind]?.border ?? "rgba(59,130,246,0.3)"}`,
                        }}
                      >
                        {KIND_BADGE[r.productKind]?.label ?? r.productKind}
                      </span>
                      {r.comboSpecialId && (
                        <span
                          style={{
                            padding: "0px 4px",
                            borderRadius: 3,
                            fontSize: "0.6rem",
                            fontWeight: 700,
                            textTransform: "uppercase",
                            letterSpacing: "0.02em",
                            backgroundColor: KIND_BADGE.vip.bg,
                            color: KIND_BADGE.vip.color,
                            border: `1px solid ${KIND_BADGE.vip.border}`,
                          }}
                          title="Part of an Ultimate VIP combo"
                        >
                          ★ VIP
                        </span>
                      )}
                      <span style={{ color: "var(--ba-muted)", fontSize: "0.65rem" }}>
                        {r.playerCount ?? "—"}p
                      </span>
                      {r.bookingSource && r.bookingSource !== "web" && (
                        <span
                          style={{
                            padding: "0px 3px",
                            borderRadius: 3,
                            fontSize: "0.5rem",
                            fontWeight: 600,
                            textTransform: "uppercase",
                            backgroundColor: `${SOURCE_COLORS[r.bookingSource] ?? "#6b7280"}20`,
                            color: SOURCE_COLORS[r.bookingSource] ?? "#6b7280",
                            border: `1px solid ${SOURCE_COLORS[r.bookingSource] ?? "#6b7280"}40`,
                          }}
                        >
                          {SOURCE_LABELS[r.bookingSource] ?? r.bookingSource}
                        </span>
                      )}
                      {r.dayofOrderLane && (
                        <span style={{ color: "#22c55e", fontWeight: 700, fontSize: "0.7rem" }}>
                          L{r.dayofOrderLane}
                        </span>
                      )}
                      <span style={{ marginLeft: "auto" }}>
                        {r.depositCents > 0 ? (
                          <>
                            <span style={{ color: "#22c55e", fontWeight: 600, fontSize: "0.7rem" }}>
                              {dollars(r.depositCents)}
                            </span>
                            <span
                              style={{
                                color: "var(--ba-muted)",
                                margin: "0 1px",
                                fontSize: "0.6rem",
                              }}
                            >
                              /
                            </span>
                            <span style={{ color: "var(--ba-muted)", fontSize: "0.6rem" }}>
                              {dollars(r.totalCents)}
                            </span>
                          </>
                        ) : r.bookingSource && r.bookingSource !== "web" ? (
                          <span style={{ color: "var(--ba-muted)", fontSize: "0.6rem" }}>
                            Walk-in
                          </span>
                        ) : (
                          <span style={{ color: "var(--ba-muted)", fontSize: "0.6rem" }}>Free</span>
                        )}
                        {r.refundCents > 0 && (
                          <span
                            style={{
                              color: "#ef4444",
                              fontSize: "0.6rem",
                              fontWeight: 600,
                              marginLeft: 4,
                            }}
                          >
                            -{dollars(r.refundCents)}
                          </span>
                        )}
                      </span>
                    </div>

                    {/* Row 3 (optional): rewards + square */}
                    {(r.loyaltyAction || r.rewardDiscountCents > 0 || r.squareDayofOrderId) && (
                      <div style={{ display: "flex", gap: 4, alignItems: "center", marginTop: 4 }}>
                        {r.loyaltyAction === "signup" && (
                          <span
                            style={{
                              padding: "0px 3px",
                              borderRadius: 3,
                              fontSize: "0.5rem",
                              fontWeight: 600,
                              backgroundColor: "rgba(34,197,94,0.15)",
                              color: "#22c55e",
                              border: "1px solid rgba(34,197,94,0.3)",
                            }}
                          >
                            New
                          </span>
                        )}
                        {r.loyaltyAction === "existing" && (
                          <span
                            style={{
                              padding: "0px 3px",
                              borderRadius: 3,
                              fontSize: "0.5rem",
                              fontWeight: 600,
                              backgroundColor: "rgba(59,130,246,0.15)",
                              color: "#60a5fa",
                              border: "1px solid rgba(59,130,246,0.3)",
                            }}
                          >
                            Member
                          </span>
                        )}
                        {r.rewardDiscountCents > 0 && (
                          <span
                            style={{
                              padding: "0px 3px",
                              borderRadius: 3,
                              fontSize: "0.5rem",
                              fontWeight: 600,
                              backgroundColor: "rgba(245,158,11,0.15)",
                              color: "#f59e0b",
                              border: "1px solid rgba(245,158,11,0.3)",
                            }}
                          >
                            −${(r.rewardDiscountCents / 100).toFixed(0)}
                          </span>
                        )}
                        {r.squareDayofOrderId && (
                          <button
                            type="button"
                            onClick={() =>
                              setOrderTarget({
                                guestName: r.guestName || "Guest",
                                squareDayofOrderId: r.squareDayofOrderId ?? null,
                                rewardDiscountCents: r.rewardDiscountCents,
                                squareLoyaltyRewardId: r.squareLoyaltyRewardId,
                              })
                            }
                            style={{
                              background: "none",
                              border: "none",
                              cursor: "pointer",
                              padding: 0,
                              marginLeft: "auto",
                            }}
                          >
                            <span
                              style={{
                                padding: "0px 4px",
                                borderRadius: 3,
                                fontSize: "0.5rem",
                                fontWeight: 600,
                                backgroundColor: r.dayofOrderError
                                  ? "rgba(239,68,68,0.15)"
                                  : r.dayofOrderSentAt
                                    ? "rgba(34,197,94,0.15)"
                                    : "rgba(107,114,128,0.1)",
                                color: r.dayofOrderError
                                  ? "#ef4444"
                                  : r.dayofOrderSentAt
                                    ? "#22c55e"
                                    : "var(--ba-muted)",
                                border: `1px solid ${r.dayofOrderError ? "rgba(239,68,68,0.3)" : r.dayofOrderSentAt ? "rgba(34,197,94,0.3)" : "var(--ba-border)"}`,
                              }}
                            >
                              {r.dayofOrderError
                                ? "SQ ERR"
                                : r.dayofOrderSentAt
                                  ? "SQ Sent"
                                  : "SQ Pending"}
                            </span>
                          </button>
                        )}
                      </div>
                    )}

                    {/* Row 4: action buttons */}
                    {!isCancelled && r.status !== "completed" && (
                      <div style={{ display: "flex", gap: 4, marginTop: 6 }}>
                        {r.status !== "arrived" && !r.checkinMethod && (
                          <button
                            type="button"
                            onClick={() => setCheckinTarget(r)}
                            style={{
                              flex: 1,
                              background: "none",
                              borderRadius: 4,
                              cursor: "pointer",
                              border: `1px solid ${r.dayofOrderLane ? "rgba(34,197,94,0.3)" : "rgba(245,158,11,0.3)"}`,
                              color: r.dayofOrderLane ? "#22c55e" : "#f59e0b",
                              fontSize: "0.6rem",
                              fontWeight: 600,
                              padding: "3px 0",
                              textTransform: "uppercase",
                              letterSpacing: "0.02em",
                            }}
                          >
                            Check In
                          </button>
                        )}
                        {r.status !== "arrived" && r.qamfReservationId && (
                          <button
                            type="button"
                            onClick={hasAttr ? undefined : () => setRescheduleTarget(r)}
                            disabled={hasAttr}
                            style={{
                              flex: 1,
                              background: "none",
                              borderRadius: 4,
                              border: `1px solid ${hasAttr ? "var(--ba-border)" : "rgba(0,226,229,0.3)"}`,
                              color: hasAttr ? "var(--ba-muted)" : "#00E2E5",
                              cursor: hasAttr ? "not-allowed" : "pointer",
                              fontSize: "0.6rem",
                              fontWeight: 600,
                              padding: "3px 0",
                              textTransform: "uppercase",
                              letterSpacing: "0.02em",
                            }}
                          >
                            Resched
                          </button>
                        )}
                        {cPath && (
                          <a
                            href={cPath}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{
                              flex: 1,
                              display: "inline-flex",
                              alignItems: "center",
                              justifyContent: "center",
                              background: "none",
                              borderRadius: 4,
                              border: "1px solid rgba(96,165,250,0.3)",
                              color: "#60a5fa",
                              fontSize: "0.6rem",
                              fontWeight: 600,
                              padding: "3px 0",
                              textTransform: "uppercase",
                              letterSpacing: "0.02em",
                              textDecoration: "none",
                            }}
                          >
                            View
                          </a>
                        )}
                        {r.status !== "arrived" && (r.guestEmail || r.guestPhone) && (
                          <button
                            type="button"
                            onClick={() => setResendTarget(r)}
                            style={{
                              flex: 1,
                              background: "none",
                              borderRadius: 4,
                              cursor: "pointer",
                              border: "1px solid rgba(96,165,250,0.3)",
                              color: "#60a5fa",
                              fontSize: "0.6rem",
                              fontWeight: 600,
                              padding: "3px 0",
                              textTransform: "uppercase",
                              letterSpacing: "0.02em",
                            }}
                          >
                            Resend
                          </button>
                        )}
                        {r.status !== "arrived" && (
                          <button
                            type="button"
                            onClick={() => setCancelTarget(r)}
                            style={{
                              flex: 1,
                              background: "none",
                              borderRadius: 4,
                              cursor: "pointer",
                              border: "1px solid rgba(239,68,68,0.3)",
                              color: "#ef4444",
                              fontSize: "0.6rem",
                              fontWeight: 600,
                              padding: "3px 0",
                              textTransform: "uppercase",
                              letterSpacing: "0.02em",
                            }}
                          >
                            Cancel
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* ── Desktop table (md+) ───────────────────────────── */}
            <div className="hidden md:block" style={{ overflowX: "auto" }}>
              <table
                style={{
                  width: "100%",
                  borderCollapse: "collapse",
                  fontSize: "0.78rem",
                }}
              >
                <thead>
                  <tr
                    style={{
                      borderBottom: "1px solid var(--ba-border)",
                      textAlign: "left",
                    }}
                  >
                    {[
                      "Time",
                      "Guest",
                      "Type",
                      "Status",
                      "Check-in",
                      "Rewards",
                      "Lane",
                      "Order",
                      "Square",
                      "Payment",
                      "Ref",
                      "Actions",
                    ].map((h) => (
                      <th
                        key={h}
                        style={{
                          padding: "0.5rem 0.4rem",
                          color: "var(--ba-muted)",
                          fontWeight: 600,
                          fontSize: "0.65rem",
                          textTransform: "uppercase",
                          letterSpacing: "0.05em",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((r) => {
                    const isCancelled = r.status === "cancelled";
                    const rowOpacity = isCancelled ? 0.45 : 1;
                    const centerShort = CENTERS[r.centerCode] === "Fort Myers" ? "FM" : "NAP";
                    return (
                      <tr
                        key={r.id}
                        style={{
                          borderBottom: "1px solid var(--ba-border)",
                          opacity: rowOpacity,
                        }}
                      >
                        {/* Time */}
                        <td style={{ padding: "0.5rem 0.4rem", whiteSpace: "nowrap" }}>
                          {fmtTime(r.bookedAt)}
                        </td>

                        {/* Guest — name, phone, center tag */}
                        <td style={{ padding: "0.5rem 0.4rem" }}>
                          <div
                            style={{
                              fontWeight: 600,
                              display: "flex",
                              alignItems: "center",
                              gap: 6,
                            }}
                          >
                            {r.guestName ||
                              (r.bookingSource && r.bookingSource !== "web" ? (
                                <span
                                  style={{
                                    color: SOURCE_COLORS[r.bookingSource] ?? "var(--ba-muted)",
                                  }}
                                >
                                  {SOURCE_LABELS[r.bookingSource] ?? r.bookingSource}
                                </span>
                              ) : (
                                "—"
                              ))}
                            <span
                              style={{
                                fontSize: "0.6rem",
                                color: "var(--ba-muted)",
                                fontWeight: 500,
                              }}
                            >
                              {centerShort}
                            </span>
                          </div>
                          {r.guestPhone && (
                            <div style={{ color: "var(--ba-muted)", fontSize: "0.68rem" }}>
                              {r.guestPhone}
                            </div>
                          )}
                          {r.survey && (
                            <div style={{ marginTop: 3 }}>
                              <SurveyChip survey={r.survey} />
                            </div>
                          )}
                        </td>

                        {/* Type — badge + player count + source */}
                        <td style={{ padding: "0.5rem 0.4rem", whiteSpace: "nowrap" }}>
                          <span
                            style={{
                              display: "inline-block",
                              padding: "0.1rem 0.4rem",
                              borderRadius: 5,
                              fontSize: "0.65rem",
                              fontWeight: 600,
                              textTransform: "uppercase",
                              letterSpacing: "0.03em",
                              backgroundColor:
                                r.productKind === "kbf"
                                  ? "rgba(168,85,247,0.15)"
                                  : "rgba(59,130,246,0.15)",
                              color: r.productKind === "kbf" ? "#a855f7" : "#3b82f6",
                              border: `1px solid ${
                                r.productKind === "kbf"
                                  ? "rgba(168,85,247,0.3)"
                                  : "rgba(59,130,246,0.3)"
                              }`,
                            }}
                          >
                            {r.productKind === "kbf" ? "KBF" : "Open"}
                          </span>
                          {r.comboSpecialId && (
                            <span
                              style={{
                                marginLeft: 5,
                                padding: "1px 5px",
                                borderRadius: 4,
                                fontSize: "0.62rem",
                                fontWeight: 700,
                                textTransform: "uppercase",
                                backgroundColor: KIND_BADGE.vip.bg,
                                color: KIND_BADGE.vip.color,
                                border: `1px solid ${KIND_BADGE.vip.border}`,
                              }}
                              title="Part of an Ultimate VIP combo"
                            >
                              ★ VIP
                            </span>
                          )}
                          <span
                            style={{ marginLeft: 5, color: "var(--ba-muted)", fontSize: "0.68rem" }}
                          >
                            {r.playerCount ?? "—"}p
                          </span>
                          {r.bookingSource && r.bookingSource !== "web" && (
                            <span
                              style={{
                                display: "inline-block",
                                marginLeft: 5,
                                padding: "0.05rem 0.3rem",
                                borderRadius: 4,
                                fontSize: "0.55rem",
                                fontWeight: 600,
                                textTransform: "uppercase",
                                letterSpacing: "0.03em",
                                backgroundColor: `${SOURCE_COLORS[r.bookingSource] ?? "#6b7280"}20`,
                                color: SOURCE_COLORS[r.bookingSource] ?? "#6b7280",
                                border: `1px solid ${SOURCE_COLORS[r.bookingSource] ?? "#6b7280"}40`,
                              }}
                            >
                              {SOURCE_LABELS[r.bookingSource] ?? r.bookingSource}
                            </span>
                          )}
                        </td>

                        {/* Status */}
                        <td style={{ padding: "0.5rem 0.4rem", whiteSpace: "nowrap" }}>
                          <span
                            style={{
                              display: "inline-block",
                              padding: "0.1rem 0.4rem",
                              borderRadius: 5,
                              fontSize: "0.65rem",
                              fontWeight: 600,
                              backgroundColor: `${STATUS_COLORS[r.status] ?? "#6b7280"}20`,
                              color: STATUS_COLORS[r.status] ?? "#6b7280",
                              border: `1px solid ${STATUS_COLORS[r.status] ?? "#6b7280"}40`,
                            }}
                          >
                            {STATUS_LABELS[r.status] ?? r.status}
                          </span>
                        </td>

                        {/* Check-in */}
                        <td style={{ padding: "0.5rem 0.4rem", whiteSpace: "nowrap" }}>
                          {r.checkinMethod === "self" ? (
                            <span
                              style={{
                                display: "inline-block",
                                padding: "0.1rem 0.35rem",
                                borderRadius: 5,
                                fontSize: "0.6rem",
                                fontWeight: 600,
                                backgroundColor: "rgba(168,85,247,0.15)",
                                color: "#a855f7",
                                border: "1px solid rgba(168,85,247,0.3)",
                              }}
                            >
                              Self
                            </span>
                          ) : r.checkinMethod === "desk" ? (
                            <span
                              style={{
                                display: "inline-block",
                                padding: "0.1rem 0.35rem",
                                borderRadius: 5,
                                fontSize: "0.6rem",
                                fontWeight: 600,
                                backgroundColor: "rgba(20,184,166,0.15)",
                                color: "#14b8a6",
                                border: "1px solid rgba(20,184,166,0.3)",
                              }}
                            >
                              Admin
                            </span>
                          ) : r.checkinMethod ? (
                            <span
                              style={{
                                display: "inline-block",
                                padding: "0.1rem 0.35rem",
                                borderRadius: 5,
                                fontSize: "0.6rem",
                                fontWeight: 600,
                                backgroundColor: "rgba(107,114,128,0.15)",
                                color: "#9ca3af",
                                border: "1px solid rgba(107,114,128,0.3)",
                              }}
                            >
                              {r.checkinMethod}
                            </span>
                          ) : r.preArrivalSentAt ? (
                            <span
                              style={{
                                display: "inline-block",
                                padding: "0.1rem 0.35rem",
                                borderRadius: 5,
                                fontSize: "0.6rem",
                                fontWeight: 600,
                                backgroundColor: "rgba(59,130,246,0.15)",
                                color: "#60a5fa",
                                border: "1px solid rgba(59,130,246,0.3)",
                              }}
                            >
                              SMS Sent
                            </span>
                          ) : (
                            <span style={{ color: "var(--ba-muted2)", fontSize: "0.6rem" }}>—</span>
                          )}
                        </td>

                        {/* Rewards */}
                        <td style={{ padding: "0.5rem 0.4rem", whiteSpace: "nowrap" }}>
                          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                            {r.loyaltyAction === "signup" && (
                              <span
                                style={{
                                  display: "inline-block",
                                  padding: "0.1rem 0.3rem",
                                  borderRadius: 4,
                                  fontSize: "0.55rem",
                                  fontWeight: 600,
                                  backgroundColor: "rgba(34,197,94,0.15)",
                                  color: "#22c55e",
                                  border: "1px solid rgba(34,197,94,0.3)",
                                }}
                              >
                                New
                              </span>
                            )}
                            {r.loyaltyAction === "existing" && (
                              <span
                                style={{
                                  display: "inline-block",
                                  padding: "0.1rem 0.3rem",
                                  borderRadius: 4,
                                  fontSize: "0.55rem",
                                  fontWeight: 600,
                                  backgroundColor: "rgba(59,130,246,0.15)",
                                  color: "#60a5fa",
                                  border: "1px solid rgba(59,130,246,0.3)",
                                }}
                              >
                                Member
                              </span>
                            )}
                            {r.rewardDiscountCents > 0 && (
                              <span
                                style={{
                                  display: "inline-block",
                                  padding: "0.1rem 0.3rem",
                                  borderRadius: 4,
                                  fontSize: "0.55rem",
                                  fontWeight: 600,
                                  backgroundColor: "rgba(245,158,11,0.15)",
                                  color: "#f59e0b",
                                  border: "1px solid rgba(245,158,11,0.3)",
                                }}
                              >
                                −${(r.rewardDiscountCents / 100).toFixed(0)}
                              </span>
                            )}
                            {!r.loyaltyAction && r.rewardDiscountCents === 0 && (
                              <span style={{ color: "var(--ba-muted2)", fontSize: "0.6rem" }}>
                                —
                              </span>
                            )}
                          </div>
                        </td>

                        {/* Lane */}
                        <td
                          style={{
                            padding: "0.5rem 0.4rem",
                            textAlign: "center",
                            fontWeight: r.dayofOrderLane ? 700 : 400,
                            color: r.dayofOrderLane ? "#22c55e" : "var(--ba-muted2)",
                            fontSize: "0.75rem",
                          }}
                        >
                          {r.dayofOrderLane ?? "—"}
                        </td>

                        {/* Order — food items from lines */}
                        <td style={{ padding: "0.5rem 0.4rem" }}>
                          {(() => {
                            const food = r.lines.filter((l) => FOOD_RE.test(l.label));
                            if (!food.length)
                              return <span style={{ color: "var(--ba-muted2)" }}>—</span>;
                            return food.map((f, i) => {
                              const short = f.label
                                .replace(/^VIP\s+/i, "")
                                .replace(/Pizza Bowl /i, "PB ")
                                .replace(/Soda Pitcher/i, "Soda")
                                .replace(/Chips & Salsa/i, "C&S");
                              return (
                                <div
                                  key={i}
                                  style={{
                                    fontSize: "0.62rem",
                                    color: "var(--ba-muted)",
                                    whiteSpace: "nowrap",
                                  }}
                                >
                                  {short}
                                  {f.quantity > 1 ? ` ×${f.quantity}` : ""}
                                </div>
                              );
                            });
                          })()}
                        </td>

                        {/* Square — order sent status (clickable to view line items) */}
                        <td style={{ padding: "0.5rem 0.4rem", whiteSpace: "nowrap" }}>
                          {r.squareDayofOrderId ? (
                            <button
                              type="button"
                              onClick={() =>
                                setOrderTarget({
                                  guestName: r.guestName || "Guest",
                                  squareDayofOrderId: r.squareDayofOrderId ?? null,
                                  rewardDiscountCents: r.rewardDiscountCents,
                                  squareLoyaltyRewardId: r.squareLoyaltyRewardId,
                                })
                              }
                              style={{
                                background: "none",
                                border: "none",
                                cursor: "pointer",
                                padding: 0,
                                textAlign: "left",
                              }}
                              title="View Square order items"
                            >
                              {r.dayofOrderSentAt ? (
                                <div>
                                  <span
                                    style={{
                                      display: "inline-block",
                                      padding: "0.1rem 0.35rem",
                                      borderRadius: 5,
                                      fontSize: "0.6rem",
                                      fontWeight: 600,
                                      backgroundColor: r.dayofOrderError
                                        ? "rgba(239,68,68,0.15)"
                                        : "rgba(34,197,94,0.15)",
                                      color: r.dayofOrderError ? "#ef4444" : "#22c55e",
                                      border: `1px solid ${r.dayofOrderError ? "rgba(239,68,68,0.3)" : "rgba(34,197,94,0.3)"}`,
                                    }}
                                  >
                                    {r.dayofOrderError ? "ERR" : "Sent"}
                                  </span>
                                  {r.dayofOrderSource && (
                                    <span
                                      style={{
                                        display: "inline-block",
                                        marginLeft: 3,
                                        padding: "0.05rem 0.25rem",
                                        borderRadius: 3,
                                        fontSize: "0.5rem",
                                        fontWeight: 500,
                                        backgroundColor:
                                          r.dayofOrderSource === "webhook"
                                            ? "rgba(99,102,241,0.15)"
                                            : "var(--ba-input-bg)",
                                        color:
                                          r.dayofOrderSource === "webhook"
                                            ? "#818cf8"
                                            : "var(--ba-muted)",
                                        border: `1px solid ${r.dayofOrderSource === "webhook" ? "rgba(99,102,241,0.3)" : "var(--ba-border)"}`,
                                        textTransform: "uppercase",
                                        letterSpacing: "0.5px",
                                      }}
                                      title={r.dayofOrderSource}
                                    >
                                      {dayofSourceLabel(r.dayofOrderSource)}
                                    </span>
                                  )}
                                  {r.dayofPaymentId && (
                                    <div
                                      style={{
                                        fontSize: "0.55rem",
                                        color: "var(--ba-muted)",
                                        marginTop: 1,
                                      }}
                                    >
                                      {r.dayofPaymentId.slice(-8)}
                                    </div>
                                  )}
                                  {r.dayofOrderError && (
                                    <div
                                      style={{
                                        fontSize: "0.55rem",
                                        color: "#ef4444",
                                        marginTop: 1,
                                        maxWidth: 90,
                                        overflow: "hidden",
                                        textOverflow: "ellipsis",
                                      }}
                                      title={r.dayofOrderError}
                                    >
                                      {r.dayofOrderError}
                                    </div>
                                  )}
                                </div>
                              ) : (
                                <span
                                  style={{
                                    color: "var(--ba-muted)",
                                    fontSize: "0.6rem",
                                    textDecoration: "underline",
                                    textDecorationColor: "var(--ba-border)",
                                  }}
                                >
                                  Pending
                                </span>
                              )}
                            </button>
                          ) : (
                            <span style={{ color: "var(--ba-muted2)" }}>—</span>
                          )}
                        </td>

                        {/* Payment — deposit / total merged */}
                        <td style={{ padding: "0.5rem 0.4rem", whiteSpace: "nowrap" }}>
                          {r.depositCents > 0 ? (
                            <>
                              <span style={{ color: "#22c55e", fontWeight: 600 }}>
                                {dollars(r.depositCents)}
                              </span>
                              <span style={{ color: "var(--ba-muted)", margin: "0 2px" }}>/</span>
                              <span style={{ color: "var(--ba-muted)" }}>
                                {dollars(r.totalCents)}
                              </span>
                            </>
                          ) : r.bookingSource && r.bookingSource !== "web" ? (
                            <span
                              style={{
                                display: "inline-block",
                                padding: "0.1rem 0.35rem",
                                borderRadius: 5,
                                fontSize: "0.6rem",
                                fontWeight: 600,
                                backgroundColor: `${SOURCE_COLORS[r.bookingSource] ?? "#6b7280"}20`,
                                color: SOURCE_COLORS[r.bookingSource] ?? "#6b7280",
                                border: `1px solid ${SOURCE_COLORS[r.bookingSource] ?? "#6b7280"}40`,
                              }}
                            >
                              {SOURCE_LABELS[r.bookingSource] ?? r.bookingSource}
                            </span>
                          ) : (
                            <span style={{ color: "var(--ba-muted)" }}>Free</span>
                          )}
                          {r.refundCents > 0 && (
                            <div style={{ color: "#ef4444", fontSize: "0.6rem" }}>
                              -{dollars(r.refundCents)}
                            </div>
                          )}
                        </td>

                        {/* Ref — QAMF ID */}
                        <td style={{ padding: "0.5rem 0.4rem", whiteSpace: "nowrap" }}>
                          <span
                            style={{
                              fontFamily: "monospace",
                              fontSize: "0.65rem",
                              color: "var(--ba-muted)",
                            }}
                          >
                            {r.qamfReservationId ?? `#${r.id}`}
                          </span>
                        </td>

                        {/* Actions — check-in, resched, view, resend, cancel */}
                        <td style={{ padding: "0.5rem 0.4rem", whiteSpace: "nowrap" }}>
                          <div style={{ display: "flex", gap: 4 }}>
                            {/* Check In — hidden once arrived or already checked in */}
                            {!isCancelled &&
                              r.status !== "completed" &&
                              r.status !== "arrived" &&
                              !r.checkinMethod && (
                                <button
                                  type="button"
                                  onClick={() => setCheckinTarget(r)}
                                  style={{
                                    background: "none",
                                    border: `1px solid ${r.dayofOrderLane ? "rgba(34,197,94,0.3)" : "rgba(245,158,11,0.3)"}`,
                                    borderRadius: 5,
                                    color: r.dayofOrderLane ? "#22c55e" : "#f59e0b",
                                    cursor: "pointer",
                                    fontSize: "0.6rem",
                                    fontWeight: 600,
                                    padding: "2px 6px",
                                    textTransform: "uppercase",
                                    letterSpacing: "0.03em",
                                  }}
                                >
                                  Check In
                                </button>
                              )}
                            {/* Reschedule (was "Time") */}
                            {!isCancelled &&
                              r.status !== "completed" &&
                              r.status !== "arrived" &&
                              r.qamfReservationId &&
                              (() => {
                                const hasAttr = (r.attractionBookings?.length ?? 0) > 0;
                                return (
                                  <button
                                    type="button"
                                    onClick={hasAttr ? undefined : () => setRescheduleTarget(r)}
                                    disabled={hasAttr}
                                    title={
                                      hasAttr
                                        ? "Rescheduling not available for bookings with attractions"
                                        : "Reschedule bowling time"
                                    }
                                    style={{
                                      background: "none",
                                      border: `1px solid ${hasAttr ? "var(--ba-border)" : "rgba(0,226,229,0.3)"}`,
                                      borderRadius: 5,
                                      color: hasAttr ? "var(--ba-muted)" : "#00E2E5",
                                      cursor: hasAttr ? "not-allowed" : "pointer",
                                      fontSize: "0.6rem",
                                      fontWeight: 600,
                                      padding: "2px 6px",
                                      textTransform: "uppercase",
                                      letterSpacing: "0.03em",
                                    }}
                                  >
                                    Resched
                                  </button>
                                );
                              })()}
                            {/* View — opens confirmation page */}
                            {confirmPath(r) && (
                              <a
                                href={confirmPath(r)!}
                                target="_blank"
                                rel="noopener noreferrer"
                                style={{
                                  display: "inline-block",
                                  background: "none",
                                  border: "1px solid rgba(96,165,250,0.3)",
                                  borderRadius: 5,
                                  color: "#60a5fa",
                                  fontSize: "0.6rem",
                                  fontWeight: 600,
                                  padding: "2px 6px",
                                  textTransform: "uppercase",
                                  letterSpacing: "0.03em",
                                  textDecoration: "none",
                                }}
                              >
                                View
                              </a>
                            )}
                            {/* Resend */}
                            {!isCancelled &&
                              r.status !== "arrived" &&
                              r.status !== "completed" &&
                              (r.guestEmail || r.guestPhone) && (
                                <button
                                  type="button"
                                  onClick={() => setResendTarget(r)}
                                  style={{
                                    background: "none",
                                    border: "1px solid rgba(96,165,250,0.3)",
                                    borderRadius: 5,
                                    color: "#60a5fa",
                                    cursor: "pointer",
                                    fontSize: "0.6rem",
                                    fontWeight: 600,
                                    padding: "2px 6px",
                                    textTransform: "uppercase",
                                    letterSpacing: "0.03em",
                                  }}
                                >
                                  Resend
                                </button>
                              )}
                            {/* Cancel */}
                            {!isCancelled && r.status !== "arrived" && r.status !== "completed" && (
                              <button
                                type="button"
                                onClick={() => setCancelTarget(r)}
                                style={{
                                  background: "none",
                                  border: "1px solid rgba(239,68,68,0.3)",
                                  borderRadius: 5,
                                  color: "#ef4444",
                                  cursor: "pointer",
                                  fontSize: "0.6rem",
                                  fontWeight: 600,
                                  padding: "2px 6px",
                                  textTransform: "uppercase",
                                  letterSpacing: "0.03em",
                                }}
                              >
                                Cancel
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
