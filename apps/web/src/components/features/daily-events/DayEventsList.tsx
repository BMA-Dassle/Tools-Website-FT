"use client";

/**
 * Daily Events — the day list: heading, desktop rows (hidden md:block) +
 * mobile cards (md:hidden) inside one card surface, and the count/source
 * footer line. Faithful port of the portal's "Today's Events" section.
 */
import { fmtDateLabelLong } from "~/features/daily-events/format";
import type {
  Reservation,
  ViewType,
  WaiverThresholds,
  WebsitePaymentInfo,
} from "~/features/daily-events/types";
import EventCard from "./EventCard";
import EventRow from "./EventRow";

export default function DayEventsList({
  date,
  viewType,
  items,
  typeFilteredCount,
  dataSource,
  websitePayments,
  waiverThresholds,
  onOpen,
}: {
  date: string;
  viewType: ViewType;
  items: Reservation[];
  typeFilteredCount: number;
  dataSource: string;
  websitePayments: Map<string, WebsitePaymentInfo>;
  waiverThresholds: WaiverThresholds;
  onOpen: (r: Reservation) => void;
}) {
  const viewLabel = viewType === "group" ? "Group Functions" : "Online Reservations";

  return (
    <div>
      <h2
        style={{
          fontSize: "1.125rem",
          fontWeight: 700,
          color: "var(--ba-fg)",
          margin: "0 0 0.25rem",
        }}
      >
        {viewLabel} for {fmtDateLabelLong(date)}
      </h2>
      <div
        style={{
          backgroundColor: "var(--ba-bg2)",
          border: "1px solid var(--ba-border)",
          borderRadius: 12,
          overflow: "hidden",
        }}
      >
        {/* Desktop rows */}
        <div className="hidden md:block">
          {items.map((r, i) => (
            <EventRow
              key={r.id}
              r={r}
              first={i === 0}
              websitePayments={websitePayments}
              waiverThresholds={waiverThresholds}
              onOpen={onOpen}
            />
          ))}
        </div>
        {/* Mobile cards */}
        <div className="md:hidden">
          {items.map((r, i) => (
            <EventCard
              key={r.id}
              r={r}
              first={i === 0}
              websitePayments={websitePayments}
              waiverThresholds={waiverThresholds}
              onOpen={onOpen}
            />
          ))}
        </div>
        <div
          style={{
            backgroundColor: "var(--ba-muted2)",
            borderTop: "1px solid var(--ba-border)",
            padding: "0.5rem 1rem",
            fontSize: "0.75rem",
            color: "var(--ba-muted)",
          }}
        >
          {items.length} of {typeFilteredCount} {viewLabel.toLowerCase()}
          {dataSource && (
            <span style={{ marginLeft: "0.5rem" }}>&middot; Source: {dataSource}</span>
          )}
        </div>
      </div>
    </div>
  );
}
