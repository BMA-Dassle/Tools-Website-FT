"use client";

/**
 * VIP combo schedule (itinerary) popover — accent-bordered step list.
 * Extracted verbatim from app/admin/[token]/reservations/ReservationsClient.tsx.
 */
import { centerLabel, fmtClock } from "~/features/reservations-admin/format";
import type { ComboScheduleStep } from "~/features/reservations-admin/types";
import ModalShell from "../ModalShell";
import { NAV_BTN } from "../theme";

export interface ScheduleTarget {
  guestName: string;
  name: string;
  accent: string;
  centerCode: string;
  schedule: ComboScheduleStep[];
}

export default function ComboScheduleModal({
  target,
  onClose,
}: {
  target: ScheduleTarget;
  onClose: () => void;
}) {
  return (
    <ModalShell
      onClose={onClose}
      maxWidth={460}
      maxHeight="80vh"
      borderColor={target.accent}
      borderLeft={`4px solid ${target.accent}`}
      borderRadius={12}
      padding={24}
      blurBackdrop={false}
    >
      <h3 style={{ margin: "0 0 2px", fontSize: "0.95rem", fontWeight: 700 }}>
        <span style={{ color: target.accent }}>★</span> {target.name}
      </h3>
      <p style={{ margin: "0 0 16px", color: "var(--ba-muted)", fontSize: "0.8rem" }}>
        {target.guestName} · {centerLabel(target.centerCode)}
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {target.schedule.map((step, i) => (
          <div
            key={i}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              fontSize: "0.85rem",
              color: "var(--ba-fg)",
            }}
          >
            <span style={{ width: 18, textAlign: "center" }}>{step.icon}</span>
            <span
              style={{
                minWidth: 84,
                fontWeight: 800,
                fontSize: "1rem",
                color: step.iso ? target.accent : "var(--ba-muted)",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {step.iso ? fmtClock(step.iso) : step.pending ? "—" : "TBD"}
            </span>
            <span style={{ flex: 1, fontWeight: 600 }}>
              {step.label}
              {step.lane ? (
                <span style={{ color: target.accent, fontWeight: 700 }}> · Lane {step.lane}</span>
              ) : null}
              {step.pending ? (
                <span style={{ color: "var(--ba-muted)", fontWeight: 400 }}> (if qualified)</span>
              ) : null}
            </span>
            <span style={{ color: "var(--ba-muted)", fontSize: "0.75rem" }}>{step.loc}</span>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 18 }}>
        <button
          type="button"
          onClick={onClose}
          style={{ ...NAV_BTN, fontSize: "0.8rem", fontWeight: 600 }}
        >
          Close
        </button>
      </div>
    </ModalShell>
  );
}
