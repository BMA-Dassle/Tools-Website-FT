"use client";

/**
 * Reschedule (Change Time) modal for the admin reservations board —
 * bowling/KBF only, same web offer (price and deposit unchanged). Server
 * guards combos and non-bowling kinds. Extracted verbatim from
 * app/admin/[token]/reservations/ReservationsClient.tsx (only the overlay
 * wrapper moved to ModalShell).
 */
import { useEffect, useState } from "react";
import { CENTERS, KIND_FULL_LABELS } from "~/features/reservations-admin/constants";
import { fmtDate, fmtTime, todayET } from "~/features/reservations-admin/format";
import type { Reservation } from "~/features/reservations-admin/types";
import ModalShell from "../ModalShell";
import { INPUT_STYLE, NAV_BTN } from "../theme";

export type SlotInfo = { bookedAt: string; webOfferId: number };
export type RescheduleInfo = {
  webOfferId: number;
  optionId?: number;
  optionType?: string;
  centerId: number;
  playerCount: number;
};

export default function RescheduleModal({
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
    <ModalShell onClose={onClose} maxWidth={480} borderColor="rgba(0,226,229,0.25)">
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
          Current: {fmtTime(reservation.bookedAt)} &middot; {fmtDate(reservation.bookedAt)} &middot;{" "}
          {CENTERS[reservation.centerCode] ?? reservation.centerCode}
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
    </ModalShell>
  );
}
