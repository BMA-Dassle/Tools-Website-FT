"use client";

/**
 * Daily Events — the 3 summary stat cards (Total Events/Reservations,
 * Confirmed, Total Persons). Faithful port of the portal's Summary Stats
 * grid.
 */
import type { CSSProperties } from "react";
import type { DayStats } from "~/features/daily-events/logic";
import type { ViewType } from "~/features/daily-events/types";

const CARD: CSSProperties = {
  backgroundColor: "var(--ba-bg2)",
  border: "1px solid var(--ba-border)",
  borderRadius: 12,
  padding: "0.75rem",
  textAlign: "center",
};

const NUMBER: CSSProperties = { fontSize: "1.25rem", fontWeight: 700 };

const LABEL: CSSProperties = { fontSize: "0.75rem", color: "var(--ba-muted)" };

export default function StatCards({ stats, viewType }: { stats: DayStats; viewType: ViewType }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "0.75rem" }}>
      <div style={CARD}>
        <div style={{ ...NUMBER, color: "var(--ba-fg)" }}>{stats.total}</div>
        <div style={LABEL}>{viewType === "group" ? "Events" : "Reservations"}</div>
      </div>
      <div style={CARD}>
        <div style={{ ...NUMBER, color: "#4ade80" }}>{stats.confirmed}</div>
        <div style={LABEL}>Confirmed</div>
      </div>
      <div style={CARD}>
        <div style={{ ...NUMBER, color: "var(--ba-muted)" }}>{stats.totalPersons}</div>
        <div style={LABEL}>Total Persons</div>
      </div>
    </div>
  );
}
