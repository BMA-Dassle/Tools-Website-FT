"use client";

/**
 * Daily Events — "Upcoming Group Functions" weekly section: Last/Current/
 * Next week tabs (Wed–Tue pay periods) with date-range sublines, loading
 * spinner, empty text, and a WeekDayCard per day. Faithful port of the
 * portal's week-navigation block.
 */
import type {
  Reservation,
  WaiverThresholds,
  WebsitePaymentInfo,
  WeekTabKey,
} from "~/features/daily-events/types";
import { formatDisplayDate, toDateStr, type WeekTab } from "~/features/daily-events/week";
import { Spinner } from "./badges";
import WeekDayCard from "./WeekDayCard";

export default function WeeklySection({
  tabs,
  activeTab,
  onTabChange,
  days,
  loading,
  websitePayments,
  waiverThresholds,
  onOpen,
}: {
  tabs: WeekTab[];
  activeTab: WeekTabKey;
  onTabChange: (key: WeekTabKey) => void;
  days: { date: string; reservations: Reservation[] }[];
  loading: boolean;
  websitePayments: Map<string, WebsitePaymentInfo>;
  waiverThresholds: WaiverThresholds;
  onOpen: (r: Reservation) => void;
}) {
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
        Upcoming Group Functions
      </h2>
      <p style={{ color: "var(--ba-muted)", fontSize: "0.875rem", margin: "0 0 1rem" }}>
        Confirmed, pending contract &amp; deposit-requested group functions by week
      </p>

      {/* Week navigation tabs */}
      <div
        style={{
          display: "flex",
          borderRadius: 8,
          overflow: "hidden",
          border: "1px solid var(--ba-border)",
          marginBottom: "1rem",
        }}
      >
        {tabs.map((tab, i) => {
          const active = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              type="button"
              aria-label={tab.label}
              onClick={() => onTabChange(tab.key)}
              style={{
                flex: 1,
                padding: "0.625rem 0.75rem",
                fontSize: "0.875rem",
                fontWeight: 500,
                border: "none",
                borderLeft: i > 0 ? "1px solid var(--ba-border)" : undefined,
                cursor: "pointer",
                backgroundColor: active ? "rgba(34,197,94,0.15)" : "var(--ba-bg2)",
                color: active ? "#22c55e" : "var(--ba-muted)",
              }}
            >
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
                <div>{tab.label}</div>
                <div style={{ fontSize: "10px", opacity: 0.7, marginTop: 2 }}>
                  {formatDisplayDate(toDateStr(tab.period.start))} &ndash;{" "}
                  {formatDisplayDate(toDateStr(tab.period.end))}
                </div>
              </div>
            </button>
          );
        })}
      </div>

      {loading ? (
        <div style={{ display: "flex", justifyContent: "center", padding: "2rem 0" }}>
          <Spinner size={24} />
        </div>
      ) : days.length === 0 ? (
        <div style={{ textAlign: "center", padding: "1.5rem 0", color: "var(--ba-muted)" }}>
          No confirmed, pending contract, or deposit-requested group functions this week
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
          {days.map(({ date, reservations }) => (
            <WeekDayCard
              key={date}
              date={date}
              reservations={reservations}
              websitePayments={websitePayments}
              waiverThresholds={waiverThresholds}
              onOpen={onOpen}
            />
          ))}
        </div>
      )}
    </div>
  );
}
