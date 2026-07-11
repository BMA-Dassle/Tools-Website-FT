"use client";

/**
 * "Change bowl time" modal for Ultimate VIP combo cards — a compact,
 * same-day variant of RescheduleModal: only slots within ±1 hour of the
 * booked bowling time (native 15-min grid, only QAMF-available starts).
 * Submits the shared admin reschedule route with comboTimeShift: true,
 * which time-shifts ONLY the bowling leg and posts a time-changed card to
 * the VIP movement Teams chat (no guest resend — the party is on-site).
 */
import { useEffect, useState } from "react";
import { fmtTime } from "~/features/reservations-admin/format";
import type { Reservation } from "~/features/reservations-admin/types";
import ModalShell from "../ModalShell";
import { NAV_BTN } from "../theme";
import type { RescheduleInfo } from "./RescheduleModal";

const WINDOW_MS = 60 * 60_000;

export default function ComboTimeShiftModal({
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
  const [info, setInfo] = useState<RescheduleInfo | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [loadingInfo, setLoadingInfo] = useState(true);
  const [slots, setSlots] = useState<string[]>([]);
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [selectedSlot, setSelectedSlot] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const currentMs = Date.parse(reservation.bookedAt);

  // Same web-offer info as the full reschedule modal (route reused as-is).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const qs = new URLSearchParams({ neonId: String(reservation.id), token });
        const res = await fetch(`/api/admin/bowling/reservations/reschedule/info?${qs}`, {
          cache: "no-store",
        });
        const data = await res.json();
        if (!cancelled) {
          if (!res.ok) setInfoError(data.error || `HTTP ${res.status}`);
          else setInfo(data as RescheduleInfo);
        }
      } catch (err) {
        if (!cancelled) setInfoError(err instanceof Error ? err.message : "Failed to load");
      } finally {
        if (!cancelled) setLoadingInfo(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reservation.id, token]);

  // Targeted availability probe around the booked time, ±1h.
  useEffect(() => {
    if (!info) return;
    let cancelled = false;
    (async () => {
      setLoadingSlots(true);
      try {
        // ET wall-clock parts of the booked slot drive the targeted probe.
        const parts = new Intl.DateTimeFormat("en-CA", {
          timeZone: "America/New_York",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }).formatToParts(new Date(currentMs));
        const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
        const qs = new URLSearchParams({
          centerId: String(info.centerId),
          players: String(info.playerCount),
          startDate: `${g("year")}-${g("month")}-${g("day")}`,
          hour: String(parseInt(g("hour") === "24" ? "00" : g("hour"), 10)),
          minute: String(parseInt(g("minute"), 10)),
          windowMinutes: "60",
          webOfferId: String(info.webOfferId),
        });
        const res = await fetch(`/api/bowling/v2/availability?${qs}`, { cache: "no-store" });
        const data = await res.json();
        if (!cancelled && data.Availabilities) {
          const times = (
            data.Availabilities as Array<{ BookedAt: string; WebOffer: { Id: number } }>
          )
            .filter((a) => a.WebOffer.Id === info.webOfferId)
            .map((a) => a.BookedAt)
            .filter((iso) => Math.abs(Date.parse(iso) - currentMs) <= WINDOW_MS)
            .sort((a, b) => Date.parse(a) - Date.parse(b));
          setSlots([...new Set(times)]);
        }
      } catch {
        /* slots stay empty — message below covers it */
      } finally {
        if (!cancelled) setLoadingSlots(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [info, currentMs]);

  async function handleShift() {
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
            comboTimeShift: true,
          }),
        },
      );
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || `HTTP ${res.status}`);
      } else {
        onDone(
          `Bowling moved to ${fmtTime(selectedSlot)}${
            data.chatAlerted
              ? " — movement chat alerted"
              : " — CHAT ALERT FAILED, tell the other center"
          }`,
        );
        onClose();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <ModalShell onClose={onClose} maxWidth={440} borderColor="rgba(212,175,55,0.35)">
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
            color: "#d4af37",
            margin: 0,
            textTransform: "uppercase",
            letterSpacing: "0.05em",
          }}
        >
          Change Bowling Time
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
          {reservation.playerCount ? ` · ${reservation.playerCount}p` : ""}
        </div>
        <div style={{ color: "var(--ba-muted)" }}>
          Current bowling:{" "}
          <strong style={{ color: "#d4af37" }}>{fmtTime(reservation.bookedAt)}</strong>
          {reservation.dayofOrderLane ? ` · Lane ${reservation.dayofOrderLane}` : ""}
        </div>
      </div>

      <div
        style={{
          padding: "0.5rem 0.75rem",
          borderRadius: 8,
          backgroundColor: "rgba(212,175,55,0.06)",
          border: "1px solid rgba(212,175,55,0.2)",
          fontSize: "0.7rem",
          color: "var(--ba-muted)",
          marginBottom: "1rem",
        }}
      >
        Available times within 1 hour of the booked slot. Moves the bowling leg only — races stay
        put. The movement chat is alerted; the guest is NOT re-emailed.
      </div>

      {loadingInfo && (
        <div style={{ textAlign: "center", padding: "2rem", color: "var(--ba-muted)" }}>
          Loading offer info...
        </div>
      )}
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

      {info && !infoError && (
        <div style={{ marginBottom: "1rem" }}>
          <span
            style={{
              fontSize: "0.7rem",
              color: "var(--ba-muted)",
              display: "block",
              marginBottom: 6,
            }}
          >
            Available times (±1 hour)
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
              No available times within an hour of {fmtTime(reservation.bookedAt)}.
            </div>
          ) : (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(90px, 1fr))",
                gap: 6,
                padding: 2,
              }}
            >
              {slots.map((iso) => {
                const isSelected = selectedSlot === iso;
                const isCurrent = Date.parse(iso) === currentMs;
                return (
                  <button
                    key={iso}
                    type="button"
                    onClick={() => setSelectedSlot(iso)}
                    disabled={isCurrent}
                    style={{
                      padding: "0.4rem 0.5rem",
                      borderRadius: 8,
                      fontSize: "0.75rem",
                      fontWeight: 600,
                      cursor: isCurrent ? "not-allowed" : "pointer",
                      border: isSelected ? "1.5px solid #d4af37" : "1px solid var(--ba-border)",
                      backgroundColor: isSelected
                        ? "rgba(212,175,55,0.18)"
                        : isCurrent
                          ? "var(--ba-bg2)"
                          : "var(--ba-input-bg)",
                      color: isSelected
                        ? "#d4af37"
                        : isCurrent
                          ? "var(--ba-muted)"
                          : "var(--ba-fg)",
                    }}
                  >
                    {fmtTime(iso)}
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
      )}

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

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button type="button" onClick={onClose} style={{ ...NAV_BTN, fontSize: "0.8rem" }}>
          Cancel
        </button>
        <button
          type="button"
          onClick={handleShift}
          disabled={submitting || !selectedSlot}
          style={{
            padding: "0.5rem 1.25rem",
            borderRadius: 8,
            fontSize: "0.8rem",
            fontWeight: 700,
            cursor: submitting || !selectedSlot ? "not-allowed" : "pointer",
            border: "none",
            backgroundColor: submitting || !selectedSlot ? "rgba(212,175,55,0.25)" : "#d4af37",
            color: submitting || !selectedSlot ? "rgba(212,175,55,0.6)" : "#000418",
            opacity: submitting ? 0.6 : 1,
          }}
        >
          {submitting
            ? "Moving..."
            : selectedSlot
              ? `Move to ${fmtTime(selectedSlot)}`
              : "Pick a time"}
        </button>
      </div>
    </ModalShell>
  );
}
