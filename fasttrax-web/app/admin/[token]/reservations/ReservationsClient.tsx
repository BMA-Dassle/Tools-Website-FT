"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { modalBackdropProps } from "@/lib/a11y";

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
  attractionBookings?: Array<{
    slug: string; name: string; quantity: number;
    totalPriceDollars: number; timeLabel: string;
  }>;
  insertedAt: string;
  lines: ReservationLine[];
}

interface SquareLineItem {
  uid: string;
  name: string;
  quantity: number;
  note: string | null;
  priceCents: number;
  totalCents: number;
  catalogId: string | null;
}

const CENTERS: Record<string, string> = {
  TXBSQN0FEKQ11: "Fort Myers",
  PPTR5G2N0QXF7: "Naples",
};

/** URL-friendly slugs → center codes for ?center= param */
const CENTER_SLUGS: Record<string, string> = {
  fm: "TXBSQN0FEKQ11",
  "fort-myers": "TXBSQN0FEKQ11",
  naples: "PPTR5G2N0QXF7",
};

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
};

const SOURCE_COLORS: Record<string, string> = {
  web: "#22c55e",
  kiosk: "#f59e0b",
  conqueror: "#ec4899",
};

type ShoeCategory = "Toddler" | "Male" | "Female";
const SHOE_SIZES: Record<ShoeCategory, string[]> = {
  Toddler: ["6","7","8","9","10","11","12","13"],
  Male: ["1","1.5","2","2.5","3","3.5","4","4.5","5","5.5","6","6.5","7","7.5","8","8.5","9","9.5","10","10.5","11","11.5","12","12.5","13","13.5","14","14.5","15"],
  Female: ["1","1.5","2","2.5","3","3.5","4","4.5","5","5.5","6","6.5","7","7.5","8","8.5","9","9.5","10","10.5","11","11.5","12"],
};
const SHOE_CATEGORY_LABELS: Record<ShoeCategory, string> = { Toddler: "Toddler", Male: "Men", Female: "Women" };

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
            Guest:{" "}
            <span className="text-white/80">
              {reservation.guestName || "Guest"}
            </span>
          </div>
          {reservation.guestPhone && (
            <div>{reservation.guestPhone}</div>
          )}
          {reservation.guestEmail && (
            <div>{reservation.guestEmail}</div>
          )}
          <div>
            {reservation.productKind === "kbf" ? "KBF" : "Open"} &middot;{" "}
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
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
          <h3 style={{ fontSize: "1rem", fontWeight: 700, color: "#ef4444", margin: 0 }}>
            Cancel Reservation
          </h3>
          <button
            type="button"
            onClick={onClose}
            style={{ background: "none", border: "none", color: "var(--ba-muted)", cursor: "pointer", fontSize: "1.2rem" }}
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
          <div><strong style={{ color: "var(--ba-fg)" }}>{reservation.guestName || "Guest"}</strong></div>
          <div style={{ color: "var(--ba-muted)" }}>
            {fmtTime(reservation.bookedAt)} &middot; {fmtDate(reservation.bookedAt)} &middot; {CENTERS[reservation.centerCode] ?? reservation.centerCode}
          </div>
          <div style={{ color: "var(--ba-muted)" }}>
            {reservation.playerCount ?? 1} bowler{(reservation.playerCount ?? 1) > 1 ? "s" : ""} &middot;{" "}
            {reservation.productKind === "kbf" ? "Kids Bowl Free" : "Open Bowling"}
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
        const res = await fetch(
          `/api/admin/bowling/reservations/reschedule/info?${qs}`,
          { cache: "no-store" },
        );
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
    return () => { cancelled = true; };
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
        const res = await fetch(
          `/api/bowling/v2/availability?${qs}`,
          { cache: "no-store" },
        );
        const data = await res.json();
        if (!cancelled && data.Availabilities) {
          // Filter to matching web offer (QAMF may return others)
          const matching = (data.Availabilities as Array<{ BookedAt: string; WebOffer: { Id: number } }>)
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
    return () => { cancelled = true; };
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
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
          <h3 style={{ fontSize: "1rem", fontWeight: 700, color: "#00E2E5", margin: 0, textTransform: "uppercase", letterSpacing: "0.05em" }}>
            Change Time
          </h3>
          <button
            type="button"
            onClick={onClose}
            style={{ background: "none", border: "none", color: "var(--ba-muted)", cursor: "pointer", fontSize: "1.2rem" }}
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
          <div><strong style={{ color: "var(--ba-fg)" }}>{reservation.guestName || "Guest"}</strong></div>
          <div style={{ color: "var(--ba-muted)" }}>
            Current: {fmtTime(reservation.bookedAt)} &middot; {fmtDate(reservation.bookedAt)} &middot; {CENTERS[reservation.centerCode] ?? reservation.centerCode}
          </div>
          <div style={{ color: "var(--ba-muted)" }}>
            {reservation.playerCount ?? 1} bowler{(reservation.playerCount ?? 1) > 1 ? "s" : ""} &middot;{" "}
            {reservation.productKind === "kbf" ? "Kids Bowl Free" : "Open Bowling"}
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
          Only times within the same experience/web offer are shown. Price and deposit stay the same.
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
              <span style={{ fontSize: "0.7rem", color: "var(--ba-muted)", display: "block", marginBottom: 4 }}>
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
              <span style={{ fontSize: "0.7rem", color: "var(--ba-muted)", display: "block", marginBottom: 6 }}>
                Available times
              </span>

              {loadingSlots ? (
                <div style={{ textAlign: "center", padding: "1.5rem", color: "var(--ba-muted)", fontSize: "0.8rem" }}>
                  Checking availability...
                </div>
              ) : slots.length === 0 ? (
                <div style={{ textAlign: "center", padding: "1.5rem", color: "var(--ba-muted)", fontSize: "0.8rem" }}>
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
                          border: isSelected
                            ? "1.5px solid #00E2E5"
                            : "1px solid var(--ba-border)",
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
                          <span style={{ display: "block", fontSize: "0.55rem", color: "var(--ba-muted)", marginTop: 1 }}>
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
          <button
            type="button"
            onClick={onClose}
            style={{ ...NAV_BTN, fontSize: "0.8rem" }}
          >
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
    () => Array.from({ length: playerCount }, () => ({ category: null, size: null }))
  );
  const [names, setNames] = useState<string[]>(() => Array.from({ length: playerCount }, () => ""));

  // Parse existing shoe size string like "Female 8" into category + size
  function parseShoeSize(raw: string | null): { category: ShoeCategory | null; size: string | null } {
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
          const existing = (plData.players || []) as Array<{ slot: number; name?: string | null; shoeSize?: string | null }>;
          if (existing.length > 0) {
            setShoes(prev => prev.map((_, i) => {
              const player = existing.find(p => p.slot === i + 1);
              return parseShoeSize(player?.shoeSize ?? null);
            }));
            setNames(prev => prev.map((_, i) => {
              const player = existing.find(p => p.slot === i + 1);
              const n = player?.name ?? "";
              return n.startsWith("Bowler ") ? "" : n;
            }));
          }
        }
      } catch {
        if (!cancelled) setPhase("error");
      }
    })();
    return () => { cancelled = true; };
  }, [reservation.id]);

  // Poll phase every 10s while not_ready
  useEffect(() => {
    if (phase !== "not_ready") return;
    const id = setInterval(async () => {
      try {
        const res = await fetch(`/api/bowling/v2/reservations/${reservation.id}/checkin`, { cache: "no-store" });
        if (res.ok) {
          const pd = await res.json();
          setPhase(pd.phase || "not_ready");
          setLaneLabel(pd.laneLabel || "");
        }
      } catch { /* ignore */ }
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
    loading:   { bg: "var(--ba-bg2)", border: "var(--ba-border)", color: "var(--ba-muted)", text: "Loading lane status…" },
    not_ready: { bg: "rgba(245,158,11,0.1)", border: "rgba(245,158,11,0.25)", color: "#f59e0b", text: "Lanes not yet assigned — polling for updates…" },
    ready:     { bg: "rgba(34,197,94,0.1)", border: "rgba(34,197,94,0.25)", color: "#22c55e", text: `${laneLabel || "Lane"} ready` },
    running:   { bg: "rgba(20,184,166,0.1)", border: "rgba(20,184,166,0.25)", color: "#14b8a6", text: `Already open — ${laneLabel || "lanes running"}` },
    completed: { bg: "var(--ba-bg2)", border: "var(--ba-border)", color: "var(--ba-muted)", text: "Session completed" },
    cancelled: { bg: "var(--ba-bg2)", border: "var(--ba-border)", color: "var(--ba-muted)", text: "Reservation cancelled" },
    error:     { bg: "rgba(239,68,68,0.1)", border: "rgba(239,68,68,0.25)", color: "#ef4444", text: "Failed to load lane status" },
  };
  const banner = bannerStyle[phase] || bannerStyle.error;

  return (
    <div
      style={{ position: "fixed", inset: 0, zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center", padding: "1rem", backgroundColor: "var(--ba-overlay)", backdropFilter: "blur(4px)" }}
      {...modalBackdropProps(onClose)}
    >
      <div style={{ width: "100%", maxWidth: 500, backgroundColor: "var(--ba-modal-bg)", border: "1px solid var(--ba-modal-border)", borderRadius: 16, padding: "1.5rem", maxHeight: "calc(100dvh - 2rem)", overflowY: "auto" }}>
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
          <h3 style={{ fontSize: "1rem", fontWeight: 700, color: "#22c55e", margin: 0, textTransform: "uppercase", letterSpacing: "0.05em" }}>Check In</h3>
          <button type="button" onClick={onClose} style={{ background: "none", border: "none", color: "var(--ba-muted)", cursor: "pointer", fontSize: "1.2rem" }}>&times;</button>
        </div>

        {/* Reservation info */}
        <div style={{ padding: "0.75rem", borderRadius: 10, backgroundColor: "var(--ba-bg2)", border: "1px solid var(--ba-border)", marginBottom: "1rem", fontSize: "0.8rem", lineHeight: 1.7 }}>
          <div><strong style={{ color: "var(--ba-fg)" }}>{reservation.guestName || "Guest"}</strong></div>
          <div style={{ color: "var(--ba-muted)" }}>
            {fmtTime(reservation.bookedAt)} &middot; {fmtDate(reservation.bookedAt)} &middot; {CENTERS[reservation.centerCode] ?? reservation.centerCode}
          </div>
          <div style={{ color: "var(--ba-muted)" }}>
            {playerCount} bowler{playerCount > 1 ? "s" : ""} &middot; {reservation.productKind === "kbf" ? "Kids Bowl Free" : "Open Bowling"}
          </div>
        </div>

        {/* Phase banner */}
        <div style={{ padding: "0.6rem 0.75rem", borderRadius: 8, backgroundColor: banner.bg, border: `1px solid ${banner.border}`, fontSize: "0.75rem", fontWeight: 600, color: banner.color, marginBottom: "1rem" }}>
          {banner.text}
        </div>

        {/* Shoe size picker */}
        {phase !== "loading" && phase !== "completed" && phase !== "cancelled" && (
          <div style={{ marginBottom: "1rem" }}>
            <span style={{ fontSize: "0.7rem", color: "var(--ba-muted)", display: "block", marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 600 }}>Shoe Sizes</span>
            {shoes.map((shoe, idx) => (
              <div key={idx} style={{ marginBottom: 10, padding: "0.5rem", borderRadius: 8, backgroundColor: "var(--ba-bg2)", border: "1px solid var(--ba-border)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
                  <span style={{ fontSize: "0.7rem", fontWeight: 600, color: "var(--ba-muted)", whiteSpace: "nowrap" }}>Bowler {idx + 1}</span>
                  <input
                    type="text"
                    placeholder="Name (optional)"
                    value={names[idx] ?? ""}
                    onChange={(e) => setNames(prev => prev.map((n, i) => i === idx ? e.target.value : n))}
                    style={{ ...INPUT_STYLE, padding: "0.2rem 0.5rem", fontSize: "0.68rem", flex: 1 }}
                  />
                </div>
                {/* Category buttons */}
                <div style={{ display: "flex", gap: 4, marginBottom: shoe.category ? 6 : 0 }}>
                  {(["Toddler", "Male", "Female"] as ShoeCategory[]).map((cat) => (
                    <button
                      key={cat}
                      type="button"
                      onClick={() => setShoes(prev => prev.map((s, i) => i === idx ? { category: s.category === cat ? null : cat, size: null } : s))}
                      style={{
                        padding: "0.25rem 0.6rem", borderRadius: 6, fontSize: "0.65rem", fontWeight: 600, cursor: "pointer",
                        border: `1px solid ${shoe.category === cat ? "rgba(0,226,229,0.4)" : "var(--ba-border)"}`,
                        backgroundColor: shoe.category === cat ? "rgba(0,226,229,0.15)" : "var(--ba-input-bg)",
                        color: shoe.category === cat ? "#00E2E5" : "var(--ba-muted)",
                      }}
                    >
                      {SHOE_CATEGORY_LABELS[cat]}
                    </button>
                  ))}
                  {shoe.category && shoe.size && (
                    <span style={{ marginLeft: "auto", fontSize: "0.65rem", fontWeight: 600, color: "#00E2E5" }}>
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
                        onClick={() => setShoes(prev => prev.map((s, i) => i === idx ? { ...s, size: sz } : s))}
                        style={{
                          padding: "0.2rem 0.4rem", borderRadius: 5, fontSize: "0.6rem", fontWeight: 600, cursor: "pointer", minWidth: 28, textAlign: "center",
                          border: `1px solid ${shoe.size === sz ? "#22c55e" : "var(--ba-border)"}`,
                          backgroundColor: shoe.size === sz ? "rgba(34,197,94,0.15)" : "var(--ba-input-bg)",
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
          <div style={{ padding: "0.5rem 0.75rem", borderRadius: 8, fontSize: "0.8rem", fontWeight: 600, marginBottom: "1rem", backgroundColor: "rgba(239,68,68,0.15)", color: "#ef4444", border: "1px solid rgba(239,68,68,0.3)" }}>
            {error}
          </div>
        )}

        {/* Actions */}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button type="button" onClick={onClose} style={{ ...NAV_BTN, fontSize: "0.8rem" }}>Close</button>
          {(phase === "not_ready" || phase === "running" || phase === "error") && (
            <button
              type="button"
              onClick={handleSaveShoesOnly}
              disabled={savingShoes}
              style={{
                padding: "0.5rem 1.25rem", borderRadius: 8, fontSize: "0.8rem", fontWeight: 700,
                cursor: savingShoes ? "not-allowed" : "pointer", border: "none",
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
                padding: "0.5rem 1.25rem", borderRadius: 8, fontSize: "0.8rem", fontWeight: 700,
                cursor: submitting ? "not-allowed" : "pointer", border: "none",
                backgroundColor: submitting ? "rgba(34,197,94,0.3)" : "#22c55e",
                color: "#fff", opacity: submitting ? 0.6 : 1,
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
      if (e.data?.type === "portal.theme" && (e.data.value === "dark" || e.data.value === "light")) {
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
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [resendTarget, setResendTarget] = useState<Reservation | null>(null);
  const [cancelTarget, setCancelTarget] = useState<Reservation | null>(null);
  const [rescheduleTarget, setRescheduleTarget] = useState<Reservation | null>(null);
  const [checkinTarget, setCheckinTarget] = useState<Reservation | null>(null);
  const [orderTarget, setOrderTarget] = useState<Reservation | null>(null);
  const [orderItems, setOrderItems] = useState<SquareLineItem[] | null>(null);
  const [orderLoading, setOrderLoading] = useState(false);
  const [orderMeta, setOrderMeta] = useState<{ state: string; totalCents: number; remainingCents: number } | null>(null);
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
      setReservations(prev =>
        prev.map(r => r.id === neonId ? { ...r, checkinMethod: method ?? undefined } : r),
      );
    } catch {
      setToast("Check-in update failed");
    }
  }

  const load = useCallback(async (opts?: { silent?: boolean }) => {
    const silent = opts?.silent ?? false;
    if (!silent) { setLoading(true); setError(null); }
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
      setError(null);
    } catch (err) {
      if (!silent) {
        setError(err instanceof Error ? err.message : "Failed to load");
        setReservations([]);
      }
    } finally {
      setLoading(false);
    }
  }, [token, date, center]);

  useEffect(() => {
    void load();
  }, [load]);

  // Auto-refresh every 10s — silent so cards update inline without flash
  useEffect(() => {
    const id = setInterval(() => { void load({ silent: true }); }, 10_000);
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
        if (data.error) { setOrderItems([]); return; }
        setOrderItems(data.lineItems ?? []);
        setOrderMeta({ state: data.state, totalCents: data.totalCents, remainingCents: data.remainingCents });
      })
      .catch(() => setOrderItems([]))
      .finally(() => setOrderLoading(false));
  }, [orderTarget, token]);

  // Client-side search + cancelled filter
  const filtered = useMemo(() => {
    let list = reservations;
    if (hideWalkins) {
      list = list.filter((r) => !r.bookingSource || r.bookingSource === "web");
    }
    if (hideCancelled) {
      list = list.filter((r) => r.status !== "cancelled" && r.status !== "completed");
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
  }, [reservations, search, hideCancelled, hideWalkins]);

  // Stats
  const active = filtered.filter((r) => r.status !== "cancelled" && r.status !== "completed");
  const totalCancelledAll = reservations.filter((r) => r.status === "cancelled").length;
  const totalCompletedAll = reservations.filter((r) => r.status === "completed").length;
  const totalWalkins = reservations.filter((r) => r.bookingSource && r.bookingSource !== "web").length;
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
  const themeStyle = theme === "light" ? `
    [data-ba-theme="light"] { --ba-bg: #f8f9fb; --ba-fg: #1a1a2e; --ba-bg2: #ffffff; --ba-border: rgba(0,0,0,0.1); --ba-muted: rgba(0,0,0,0.45); --ba-muted2: rgba(0,0,0,0.08); --ba-hover: rgba(0,0,0,0.04); --ba-input-bg: #ffffff; --ba-input-border: rgba(0,0,0,0.15); --ba-shadow: rgba(0,0,0,0.08); --ba-modal-bg: #ffffff; --ba-modal-border: rgba(0,0,0,0.12); --ba-overlay: rgba(0,0,0,0.4); }
  ` : `
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
          {...modalBackdropProps(() => { setOrderTarget(null); setOrderItems(null); setOrderMeta(null); })}
          style={{
            position: "fixed", inset: 0, zIndex: 50,
            background: "var(--ba-overlay)", display: "flex",
            alignItems: "center", justifyContent: "center", padding: 16,
          }}
        >
          <div
            style={{
              background: "var(--ba-modal-bg)", borderRadius: 12, padding: 24,
              border: "1px solid var(--ba-modal-border)", maxWidth: 500, width: "100%",
              maxHeight: "80vh", overflow: "auto",
            }}
          >
            <h3 style={{ margin: "0 0 4px", fontSize: "0.95rem", fontWeight: 700 }}>
              Square Order — {orderTarget.guestName}
            </h3>
            <p style={{ margin: "0 0 16px", color: "var(--ba-muted)", fontSize: "0.68rem", fontFamily: "monospace" }}>
              {orderTarget.squareDayofOrderId}
            </p>

            {orderLoading && <p style={{ color: "var(--ba-muted)", fontSize: "0.8rem" }}>Loading…</p>}

            {orderMeta && (
              <div style={{ display: "flex", gap: 12, marginBottom: 12 }}>
                <span style={{
                  padding: "2px 8px", borderRadius: 5, fontSize: "0.65rem", fontWeight: 600,
                  background: orderMeta.state === "OPEN" ? "rgba(59,130,246,0.15)" : orderMeta.state === "COMPLETED" ? "rgba(34,197,94,0.15)" : "rgba(239,68,68,0.15)",
                  color: orderMeta.state === "OPEN" ? "#3b82f6" : orderMeta.state === "COMPLETED" ? "#22c55e" : "#ef4444",
                  border: `1px solid ${orderMeta.state === "OPEN" ? "rgba(59,130,246,0.3)" : orderMeta.state === "COMPLETED" ? "rgba(34,197,94,0.3)" : "rgba(239,68,68,0.3)"}`,
                }}>
                  {orderMeta.state}
                </span>
                <span style={{ color: "var(--ba-muted)", fontSize: "0.75rem" }}>
                  Total: <strong style={{ color: "var(--ba-fg)" }}>${(orderMeta.totalCents / 100).toFixed(2)}</strong>
                </span>
                {orderMeta.remainingCents > 0 && (
                  <span style={{ color: "var(--ba-muted)", fontSize: "0.75rem" }}>
                    Due: <strong style={{ color: "#f59e0b" }}>${(orderMeta.remainingCents / 100).toFixed(2)}</strong>
                  </span>
                )}
              </div>
            )}

            {orderTarget.rewardDiscountCents > 0 && (
              <div style={{
                display: "flex", alignItems: "center", gap: 8, marginBottom: 12,
                padding: "6px 10px", borderRadius: 6,
                background: "rgba(255,215,0,0.08)", border: "1px solid rgba(255,215,0,0.2)",
              }}>
                <span style={{ fontSize: "0.85rem" }}>⭐</span>
                <span style={{ color: "#FFD700", fontSize: "0.75rem", fontWeight: 600 }}>
                  HeadPinz Reward −${(orderTarget.rewardDiscountCents / 100).toFixed(2)}
                </span>
                {orderTarget.squareLoyaltyRewardId && (
                  <span style={{ color: "var(--ba-muted)", fontSize: "0.6rem", fontFamily: "monospace" }}>
                    {orderTarget.squareLoyaltyRewardId.slice(0, 8)}…
                  </span>
                )}
              </div>
            )}

            {orderItems && orderItems.length > 0 && (
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.78rem" }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--ba-border)" }}>
                    {["Item", "Qty", "Price"].map((h) => (
                      <th key={h} style={{
                        padding: "6px 8px", textAlign: h === "Item" ? "left" : "right",
                        color: "var(--ba-muted)", fontSize: "0.65rem",
                        textTransform: "uppercase", fontWeight: 600,
                      }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {orderItems.map((li) => (
                    <tr key={li.uid} style={{ borderBottom: "1px solid var(--ba-border)" }}>
                      <td style={{ padding: "6px 8px" }}>
                        <div style={{ fontWeight: 600 }}>{li.name}</div>
                        {li.note && (
                          <div style={{ color: "var(--ba-muted)", fontSize: "0.68rem", fontStyle: "italic" }}>{li.note}</div>
                        )}
                      </td>
                      <td style={{ padding: "6px 8px", textAlign: "right", color: "var(--ba-muted)" }}>{li.quantity}</td>
                      <td style={{ padding: "6px 8px", textAlign: "right", fontWeight: 600, color: li.totalCents === 0 ? "var(--ba-muted)" : "var(--ba-fg)" }}>
                        {li.totalCents === 0 ? "$0" : `$${(li.totalCents / 100).toFixed(2)}`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {orderItems && orderItems.length === 0 && (
              <p style={{ color: "var(--ba-muted)", fontSize: "0.8rem" }}>No line items</p>
            )}

            <div style={{ marginTop: 16, textAlign: "right" }}>
              <button
                type="button"
                onClick={() => { setOrderTarget(null); setOrderItems(null); setOrderMeta(null); }}
                style={{
                  padding: "6px 16px", borderRadius: 6, fontSize: "0.75rem",
                  background: "var(--ba-input-bg)", border: "1px solid var(--ba-input-border)",
                  color: "var(--ba-fg)", cursor: "pointer", fontWeight: 600,
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
          <button
            type="button"
            onClick={() => setDate(todayET())}
            style={{ ...NAV_BTN, fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 600 }}
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
                  {" "}+ {totalHidden} hidden
                  {totalCancelledAll > 0 && totalCompletedAll > 0
                    ? ` (${totalCancelledAll} cancelled, ${totalCompletedAll} completed)`
                    : totalCancelledAll > 0 ? " (cancelled)" : " (completed)"}
                </span>
              )}
              {!hideCancelled && totalCancelledAll > 0 && (
                <span style={{ color: "rgba(239,68,68,0.7)" }}>
                  {" "}· {totalCancelledAll} cancelled
                </span>
              )}
              {hideWalkins && totalWalkins > 0 && (
                <span style={{ color: "var(--ba-muted)" }}>
                  {" "}· {totalWalkins} walk-in
                </span>
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
        ) : filtered.length === 0 ? (
          <div style={{ textAlign: "center", padding: "3rem", color: "var(--ba-muted)" }}>
            {search ? "No matching reservations." : "No reservations for this date."}
          </div>
        ) : (
          <>
          {/* ── Mobile card list (<md) ────────────────────────── */}
          <div className="md:hidden" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
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
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, flex: 1 }}>
                      <span style={{ fontSize: "0.7rem", fontWeight: 600, color: "var(--ba-fg)", whiteSpace: "nowrap" }}>
                        {fmtTime(r.bookedAt)}
                      </span>
                      <span style={{ fontWeight: 700, fontSize: "0.8rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {r.guestName || (
                          r.bookingSource && r.bookingSource !== "web"
                            ? <span style={{ color: SOURCE_COLORS[r.bookingSource] ?? "var(--ba-muted)" }}>
                                {SOURCE_LABELS[r.bookingSource] ?? r.bookingSource}
                              </span>
                            : "—"
                        )}
                      </span>
                      <span style={{ fontSize: "0.55rem", color: "var(--ba-muted)", fontWeight: 500, whiteSpace: "nowrap" }}>
                        {centerShort}
                      </span>
                    </div>
                    <div style={{ display: "flex", gap: 3, alignItems: "center", flexShrink: 0, marginLeft: 6 }}>
                      <span style={{
                        padding: "1px 5px", borderRadius: 4, fontSize: "0.6rem", fontWeight: 600,
                        backgroundColor: `${STATUS_COLORS[r.status] ?? "#6b7280"}20`,
                        color: STATUS_COLORS[r.status] ?? "#6b7280",
                        border: `1px solid ${STATUS_COLORS[r.status] ?? "#6b7280"}40`,
                      }}>
                        {STATUS_LABELS[r.status] ?? r.status}
                      </span>
                      {r.checkinMethod === "self" ? (
                        <span style={{ padding: "1px 4px", borderRadius: 4, fontSize: "0.55rem", fontWeight: 600, backgroundColor: "rgba(168,85,247,0.15)", color: "#a855f7", border: "1px solid rgba(168,85,247,0.3)" }}>Self</span>
                      ) : r.checkinMethod === "desk" ? (
                        <span style={{ padding: "1px 4px", borderRadius: 4, fontSize: "0.55rem", fontWeight: 600, backgroundColor: "rgba(20,184,166,0.15)", color: "#14b8a6", border: "1px solid rgba(20,184,166,0.3)" }}>Admin</span>
                      ) : r.checkinMethod ? (
                        <span style={{ padding: "1px 4px", borderRadius: 4, fontSize: "0.55rem", fontWeight: 600, backgroundColor: "rgba(107,114,128,0.15)", color: "#9ca3af", border: "1px solid rgba(107,114,128,0.3)" }}>{r.checkinMethod}</span>
                      ) : r.preArrivalSentAt ? (
                        <span style={{ padding: "1px 4px", borderRadius: 4, fontSize: "0.55rem", fontWeight: 600, backgroundColor: "rgba(59,130,246,0.15)", color: "#60a5fa", border: "1px solid rgba(59,130,246,0.3)" }}>SMS</span>
                      ) : null}
                    </div>
                  </div>

                  {/* Row 2: phone · type · players · source · lane · payment */}
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4, flexWrap: "wrap", fontSize: "0.68rem" }}>
                    {r.guestPhone && (
                      <span style={{ color: "var(--ba-muted)" }}>{r.guestPhone}</span>
                    )}
                    <span style={{
                      padding: "0px 4px", borderRadius: 3, fontSize: "0.6rem", fontWeight: 600,
                      textTransform: "uppercase", letterSpacing: "0.02em",
                      backgroundColor: r.productKind === "kbf" ? "rgba(168,85,247,0.15)" : "rgba(59,130,246,0.15)",
                      color: r.productKind === "kbf" ? "#a855f7" : "#3b82f6",
                      border: `1px solid ${r.productKind === "kbf" ? "rgba(168,85,247,0.3)" : "rgba(59,130,246,0.3)"}`,
                    }}>
                      {r.productKind === "kbf" ? "KBF" : "Open"}
                    </span>
                    <span style={{ color: "var(--ba-muted)", fontSize: "0.65rem" }}>{r.playerCount ?? "—"}p</span>
                    {r.bookingSource && r.bookingSource !== "web" && (
                      <span style={{
                        padding: "0px 3px", borderRadius: 3, fontSize: "0.5rem", fontWeight: 600,
                        textTransform: "uppercase",
                        backgroundColor: `${SOURCE_COLORS[r.bookingSource] ?? "#6b7280"}20`,
                        color: SOURCE_COLORS[r.bookingSource] ?? "#6b7280",
                        border: `1px solid ${SOURCE_COLORS[r.bookingSource] ?? "#6b7280"}40`,
                      }}>
                        {SOURCE_LABELS[r.bookingSource] ?? r.bookingSource}
                      </span>
                    )}
                    {r.dayofOrderLane && (
                      <span style={{ color: "#22c55e", fontWeight: 700, fontSize: "0.7rem" }}>L{r.dayofOrderLane}</span>
                    )}
                    <span style={{ marginLeft: "auto" }}>
                      {r.depositCents > 0 ? (
                        <>
                          <span style={{ color: "#22c55e", fontWeight: 600, fontSize: "0.7rem" }}>{dollars(r.depositCents)}</span>
                          <span style={{ color: "var(--ba-muted)", margin: "0 1px", fontSize: "0.6rem" }}>/</span>
                          <span style={{ color: "var(--ba-muted)", fontSize: "0.6rem" }}>{dollars(r.totalCents)}</span>
                        </>
                      ) : r.bookingSource && r.bookingSource !== "web" ? (
                        <span style={{ color: "var(--ba-muted)", fontSize: "0.6rem" }}>Walk-in</span>
                      ) : (
                        <span style={{ color: "var(--ba-muted)", fontSize: "0.6rem" }}>Free</span>
                      )}
                      {r.refundCents > 0 && (
                        <span style={{ color: "#ef4444", fontSize: "0.6rem", fontWeight: 600, marginLeft: 4 }}>
                          -{dollars(r.refundCents)}
                        </span>
                      )}
                    </span>
                  </div>

                  {/* Row 3 (optional): rewards + square */}
                  {(r.loyaltyAction || r.rewardDiscountCents > 0 || r.squareDayofOrderId) && (
                    <div style={{ display: "flex", gap: 4, alignItems: "center", marginTop: 4 }}>
                      {r.loyaltyAction === "signup" && (
                        <span style={{ padding: "0px 3px", borderRadius: 3, fontSize: "0.5rem", fontWeight: 600, backgroundColor: "rgba(34,197,94,0.15)", color: "#22c55e", border: "1px solid rgba(34,197,94,0.3)" }}>New</span>
                      )}
                      {r.loyaltyAction === "existing" && (
                        <span style={{ padding: "0px 3px", borderRadius: 3, fontSize: "0.5rem", fontWeight: 600, backgroundColor: "rgba(59,130,246,0.15)", color: "#60a5fa", border: "1px solid rgba(59,130,246,0.3)" }}>Member</span>
                      )}
                      {r.rewardDiscountCents > 0 && (
                        <span style={{ padding: "0px 3px", borderRadius: 3, fontSize: "0.5rem", fontWeight: 600, backgroundColor: "rgba(245,158,11,0.15)", color: "#f59e0b", border: "1px solid rgba(245,158,11,0.3)" }}>−${(r.rewardDiscountCents / 100).toFixed(0)}</span>
                      )}
                      {r.squareDayofOrderId && (
                        <button type="button" onClick={() => setOrderTarget(r)} style={{ background: "none", border: "none", cursor: "pointer", padding: 0, marginLeft: "auto" }}>
                          <span style={{
                            padding: "0px 4px", borderRadius: 3, fontSize: "0.5rem", fontWeight: 600,
                            backgroundColor: r.dayofOrderError ? "rgba(239,68,68,0.15)" : r.dayofOrderSentAt ? "rgba(34,197,94,0.15)" : "rgba(107,114,128,0.1)",
                            color: r.dayofOrderError ? "#ef4444" : r.dayofOrderSentAt ? "#22c55e" : "var(--ba-muted)",
                            border: `1px solid ${r.dayofOrderError ? "rgba(239,68,68,0.3)" : r.dayofOrderSentAt ? "rgba(34,197,94,0.3)" : "var(--ba-border)"}`,
                          }}>
                            {r.dayofOrderError ? "SQ ERR" : r.dayofOrderSentAt ? "SQ Sent" : "SQ Pending"}
                          </span>
                        </button>
                      )}
                    </div>
                  )}

                  {/* Row 4: action buttons */}
                  {!isCancelled && r.status !== "completed" && (
                    <div style={{ display: "flex", gap: 4, marginTop: 6 }}>
                      <button type="button" onClick={() => setCheckinTarget(r)} style={{
                        flex: 1, background: "none", borderRadius: 4, cursor: "pointer",
                        border: `1px solid ${r.dayofOrderLane ? "rgba(34,197,94,0.3)" : "rgba(245,158,11,0.3)"}`,
                        color: r.dayofOrderLane ? "#22c55e" : "#f59e0b",
                        fontSize: "0.6rem", fontWeight: 600, padding: "3px 0",
                        textTransform: "uppercase", letterSpacing: "0.02em",
                      }}>
                        Check In
                      </button>
                      {r.status !== "arrived" && r.qamfReservationId && (
                        <button type="button" onClick={hasAttr ? undefined : () => setRescheduleTarget(r)} disabled={hasAttr} style={{
                          flex: 1, background: "none", borderRadius: 4,
                          border: `1px solid ${hasAttr ? "var(--ba-border)" : "rgba(0,226,229,0.3)"}`,
                          color: hasAttr ? "var(--ba-muted)" : "#00E2E5",
                          cursor: hasAttr ? "not-allowed" : "pointer",
                          fontSize: "0.6rem", fontWeight: 600, padding: "3px 0",
                          textTransform: "uppercase", letterSpacing: "0.02em",
                        }}>
                          Resched
                        </button>
                      )}
                      {cPath && (
                        <a href={cPath} target="_blank" rel="noopener noreferrer" style={{
                          flex: 1, display: "inline-flex", alignItems: "center", justifyContent: "center",
                          background: "none", borderRadius: 4,
                          border: "1px solid rgba(96,165,250,0.3)", color: "#60a5fa",
                          fontSize: "0.6rem", fontWeight: 600, padding: "3px 0",
                          textTransform: "uppercase", letterSpacing: "0.02em", textDecoration: "none",
                        }}>
                          View
                        </a>
                      )}
                      {r.status !== "arrived" && (r.guestEmail || r.guestPhone) && (
                        <button type="button" onClick={() => setResendTarget(r)} style={{
                          flex: 1, background: "none", borderRadius: 4, cursor: "pointer",
                          border: "1px solid rgba(96,165,250,0.3)", color: "#60a5fa",
                          fontSize: "0.6rem", fontWeight: 600, padding: "3px 0",
                          textTransform: "uppercase", letterSpacing: "0.02em",
                        }}>
                          Resend
                        </button>
                      )}
                      {r.status !== "arrived" && (
                        <button type="button" onClick={() => setCancelTarget(r)} style={{
                          flex: 1, background: "none", borderRadius: 4, cursor: "pointer",
                          border: "1px solid rgba(239,68,68,0.3)", color: "#ef4444",
                          fontSize: "0.6rem", fontWeight: 600, padding: "3px 0",
                          textTransform: "uppercase", letterSpacing: "0.02em",
                        }}>
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
                  {["Time", "Guest", "Type", "Status", "Check-in", "Rewards", "Lane", "Order", "Square", "Payment", "Ref", "Actions"].map(
                    (h) => (
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
                    ),
                  )}
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
                        <div style={{ fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}>
                          {r.guestName || (
                            r.bookingSource && r.bookingSource !== "web"
                              ? <span style={{ color: SOURCE_COLORS[r.bookingSource] ?? "var(--ba-muted)" }}>
                                  {SOURCE_LABELS[r.bookingSource] ?? r.bookingSource}
                                </span>
                              : "—"
                          )}
                          <span style={{ fontSize: "0.6rem", color: "var(--ba-muted)", fontWeight: 500 }}>
                            {centerShort}
                          </span>
                        </div>
                        {r.guestPhone && (
                          <div style={{ color: "var(--ba-muted)", fontSize: "0.68rem" }}>
                            {r.guestPhone}
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
                        <span style={{ marginLeft: 5, color: "var(--ba-muted)", fontSize: "0.68rem" }}>
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
                          <span style={{ display: "inline-block", padding: "0.1rem 0.35rem", borderRadius: 5, fontSize: "0.6rem", fontWeight: 600, backgroundColor: "rgba(168,85,247,0.15)", color: "#a855f7", border: "1px solid rgba(168,85,247,0.3)" }}>Self</span>
                        ) : r.checkinMethod === "desk" ? (
                          <span style={{ display: "inline-block", padding: "0.1rem 0.35rem", borderRadius: 5, fontSize: "0.6rem", fontWeight: 600, backgroundColor: "rgba(20,184,166,0.15)", color: "#14b8a6", border: "1px solid rgba(20,184,166,0.3)" }}>Admin</span>
                        ) : r.checkinMethod ? (
                          <span style={{ display: "inline-block", padding: "0.1rem 0.35rem", borderRadius: 5, fontSize: "0.6rem", fontWeight: 600, backgroundColor: "rgba(107,114,128,0.15)", color: "#9ca3af", border: "1px solid rgba(107,114,128,0.3)" }}>{r.checkinMethod}</span>
                        ) : r.preArrivalSentAt ? (
                          <span style={{ display: "inline-block", padding: "0.1rem 0.35rem", borderRadius: 5, fontSize: "0.6rem", fontWeight: 600, backgroundColor: "rgba(59,130,246,0.15)", color: "#60a5fa", border: "1px solid rgba(59,130,246,0.3)" }}>SMS Sent</span>
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
                            <span style={{ color: "var(--ba-muted2)", fontSize: "0.6rem" }}>—</span>
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
                          if (!food.length) return <span style={{ color: "var(--ba-muted2)" }}>—</span>;
                          return food.map((f, i) => {
                            const short = f.label
                              .replace(/^VIP\s+/i, "")
                              .replace(/Pizza Bowl /i, "PB ")
                              .replace(/Soda Pitcher/i, "Soda")
                              .replace(/Chips & Salsa/i, "C&S");
                            return (
                              <div key={i} style={{ fontSize: "0.62rem", color: "var(--ba-muted)", whiteSpace: "nowrap" }}>
                                {short}{f.quantity > 1 ? ` ×${f.quantity}` : ""}
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
                            onClick={() => setOrderTarget(r)}
                            style={{ background: "none", border: "none", cursor: "pointer", padding: 0, textAlign: "left" }}
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
                                      backgroundColor: r.dayofOrderSource === "webhook" ? "rgba(99,102,241,0.15)" : "var(--ba-input-bg)",
                                      color: r.dayofOrderSource === "webhook" ? "#818cf8" : "var(--ba-muted)",
                                      border: `1px solid ${r.dayofOrderSource === "webhook" ? "rgba(99,102,241,0.3)" : "var(--ba-border)"}`,
                                      textTransform: "uppercase",
                                      letterSpacing: "0.5px",
                                    }}
                                  >
                                    {r.dayofOrderSource}
                                  </span>
                                )}
                                {r.dayofPaymentId && (
                                  <div style={{ fontSize: "0.55rem", color: "var(--ba-muted)", marginTop: 1 }}>
                                    {r.dayofPaymentId.slice(-8)}
                                  </div>
                                )}
                                {r.dayofOrderError && (
                                  <div style={{ fontSize: "0.55rem", color: "#ef4444", marginTop: 1, maxWidth: 90, overflow: "hidden", textOverflow: "ellipsis" }}
                                    title={r.dayofOrderError}
                                  >
                                    {r.dayofOrderError}
                                  </div>
                                )}
                              </div>
                            ) : (
                              <span style={{ color: "var(--ba-muted)", fontSize: "0.6rem", textDecoration: "underline", textDecorationColor: "var(--ba-border)" }}>
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
                            <span style={{ color: "#22c55e", fontWeight: 600 }}>{dollars(r.depositCents)}</span>
                            <span style={{ color: "var(--ba-muted)", margin: "0 2px" }}>/</span>
                            <span style={{ color: "var(--ba-muted)" }}>{dollars(r.totalCents)}</span>
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
                        <span style={{ fontFamily: "monospace", fontSize: "0.65rem", color: "var(--ba-muted)" }}>
                          {r.qamfReservationId ?? `#${r.id}`}
                        </span>
                      </td>

                      {/* Actions — check-in, resched, view, resend, cancel */}
                      <td style={{ padding: "0.5rem 0.4rem", whiteSpace: "nowrap" }}>
                        <div style={{ display: "flex", gap: 4 }}>
                          {/* Check In — always visible for actionable reservations */}
                          {!isCancelled && r.status !== "completed" && (
                            <button
                              type="button"
                              onClick={() => setCheckinTarget(r)}
                              style={{
                                background: "none",
                                border: `1px solid ${r.dayofOrderLane ? "rgba(34,197,94,0.3)" : "rgba(245,158,11,0.3)"}`,
                                borderRadius: 5,
                                color: r.dayofOrderLane ? "#22c55e" : "#f59e0b",
                                cursor: "pointer", fontSize: "0.6rem", fontWeight: 600, padding: "2px 6px",
                                textTransform: "uppercase", letterSpacing: "0.03em",
                              }}
                            >
                              Check In
                            </button>
                          )}
                          {/* Reschedule (was "Time") */}
                          {!isCancelled && r.status !== "completed" && r.status !== "arrived" && r.qamfReservationId && (() => {
                            const hasAttr = (r.attractionBookings?.length ?? 0) > 0;
                            return (
                              <button
                                type="button"
                                onClick={hasAttr ? undefined : () => setRescheduleTarget(r)}
                                disabled={hasAttr}
                                title={hasAttr ? "Rescheduling not available for bookings with attractions" : "Reschedule bowling time"}
                                style={{
                                  background: "none",
                                  border: `1px solid ${hasAttr ? "var(--ba-border)" : "rgba(0,226,229,0.3)"}`,
                                  borderRadius: 5,
                                  color: hasAttr ? "var(--ba-muted)" : "#00E2E5",
                                  cursor: hasAttr ? "not-allowed" : "pointer",
                                  fontSize: "0.6rem", fontWeight: 600, padding: "2px 6px",
                                  textTransform: "uppercase", letterSpacing: "0.03em",
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
                                display: "inline-block", background: "none",
                                border: "1px solid rgba(96,165,250,0.3)", borderRadius: 5,
                                color: "#60a5fa", fontSize: "0.6rem", fontWeight: 600, padding: "2px 6px",
                                textTransform: "uppercase", letterSpacing: "0.03em", textDecoration: "none",
                              }}
                            >
                              View
                            </a>
                          )}
                          {/* Resend */}
                          {!isCancelled && r.status !== "arrived" && r.status !== "completed" && (r.guestEmail || r.guestPhone) && (
                            <button
                              type="button"
                              onClick={() => setResendTarget(r)}
                              style={{
                                background: "none", border: "1px solid rgba(96,165,250,0.3)", borderRadius: 5,
                                color: "#60a5fa", cursor: "pointer", fontSize: "0.6rem", fontWeight: 600,
                                padding: "2px 6px", textTransform: "uppercase", letterSpacing: "0.03em",
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
                                background: "none", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 5,
                                color: "#ef4444", cursor: "pointer", fontSize: "0.6rem", fontWeight: 600,
                                padding: "2px 6px", textTransform: "uppercase", letterSpacing: "0.03em",
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
