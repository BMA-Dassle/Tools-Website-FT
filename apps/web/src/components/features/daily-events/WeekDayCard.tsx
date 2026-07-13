"use client";

/**
 * Daily Events — one day's card in the weekly section: muted header
 * ("Sat, Jul 12 · N events · M persons (K unconfirmed)") + WeekEventRow
 * list. Faithful port of the portal's weekly day Card.
 */
import { isContractStage, isDepositRequested } from "~/features/daily-events/logic";
import type {
  Reservation,
  WaiverThresholds,
  WebsitePaymentInfo,
} from "~/features/daily-events/types";
import { formatDisplayDate } from "~/features/daily-events/week";
import { WeekEventRow } from "./EventRow";

export default function WeekDayCard({
  date,
  reservations,
  websitePayments,
  waiverThresholds,
  onOpen,
}: {
  date: string;
  reservations: Reservation[];
  websitePayments: Map<string, WebsitePaymentInfo>;
  waiverThresholds: WaiverThresholds;
  onOpen: (r: Reservation) => void;
}) {
  const totalPersons = reservations.reduce((sum, r) => sum + (r.persons || 0), 0);
  const depositCount = reservations.filter(
    (r) => isDepositRequested(r.state) || isContractStage(r.state),
  ).length;

  return (
    <div
      style={{
        backgroundColor: "var(--ba-bg2)",
        border: "1px solid var(--ba-border)",
        borderRadius: 12,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0.5rem 1rem",
          backgroundColor: "var(--ba-muted2)",
          borderBottom: "1px solid var(--ba-border)",
        }}
      >
        <span style={{ fontSize: "0.875rem", fontWeight: 600, color: "var(--ba-fg)" }}>
          {formatDisplayDate(date)}
        </span>
        <span style={{ fontSize: "0.75rem", color: "var(--ba-muted)" }}>
          {reservations.length} event{reservations.length !== 1 ? "s" : ""} &middot; {totalPersons}{" "}
          persons
          {depositCount > 0 && (
            <span style={{ color: "#fb923c", marginLeft: 4 }}>({depositCount} unconfirmed)</span>
          )}
        </span>
      </div>
      <div>
        {reservations.map((r, i) => (
          <div key={r.id} style={{ borderTop: i > 0 ? "1px solid var(--ba-border)" : undefined }}>
            <WeekEventRow
              r={r}
              websitePayments={websitePayments}
              waiverThresholds={waiverThresholds}
              onOpen={onOpen}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
