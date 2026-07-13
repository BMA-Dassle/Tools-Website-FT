"use client";

/**
 * Daily Events — page header: title + subtitle, TV Dashboard link (points
 * back at the portal's TV events page), location picker (replaces the
 * portal's LocationContext), date nav (replaces DateContext; reservations
 * FilterBar pattern), and the view-type / state-filter selects (portal
 * shadcn Selects translated to native <select>s, same option sets).
 */
import { LOCATIONS, portalTvUrl } from "~/features/daily-events/constants";
import { fmtDateLabelLong, todayET } from "~/features/daily-events/format";
import type { StateFilter, ViewType } from "~/features/daily-events/types";
import { INPUT_STYLE, NAV_BTN } from "~/components/features/reservations-admin/theme";

export default function HeaderBar({
  date,
  onDateChange,
  locationId,
  onLocationChange,
  viewType,
  onViewTypeChange,
  stateFilter,
  onStateFilterChange,
}: {
  date: string;
  onDateChange: (date: string) => void;
  locationId: number;
  onLocationChange: (locationId: number) => void;
  viewType: ViewType;
  onViewTypeChange: (viewType: ViewType) => void;
  stateFilter: StateFilter;
  onStateFilterChange: (stateFilter: StateFilter) => void;
}) {
  const viewLabel = viewType === "group" ? "Group Functions" : "Online Reservations";

  const shiftDate = (delta: number) => {
    const d = new Date(date + "T12:00:00");
    d.setDate(d.getDate() + delta);
    onDateChange(d.toISOString().slice(0, 10));
  };

  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "1rem",
        marginBottom: "1.5rem",
      }}
    >
      <div>
        <h1 style={{ fontSize: "1.5rem", fontWeight: 700, color: "var(--ba-fg)", margin: 0 }}>
          Daily Events
        </h1>
        <p style={{ color: "var(--ba-muted)", fontSize: "0.875rem", margin: "0.25rem 0 0" }}>
          {viewLabel} for {fmtDateLabelLong(date)}
        </p>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
        <a
          href={portalTvUrl(locationId)}
          target="_blank"
          rel="noreferrer"
          title="Open TV Dashboard"
          style={{
            ...NAV_BTN,
            textDecoration: "none",
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          📺 <span className="hidden sm:inline">TV Dashboard</span>
        </a>

        {/* Location picker */}
        <div
          style={{
            display: "inline-flex",
            border: "1px solid var(--ba-input-border)",
            borderRadius: 8,
            overflow: "hidden",
          }}
        >
          {LOCATIONS.map((loc, i) => {
            const active = locationId === loc.id;
            return (
              <button
                key={loc.id}
                type="button"
                onClick={() => onLocationChange(loc.id)}
                title={loc.label}
                style={{
                  padding: "0.5rem 0.75rem",
                  fontSize: "0.75rem",
                  fontWeight: 600,
                  border: "none",
                  borderLeft: i > 0 ? "1px solid var(--ba-input-border)" : undefined,
                  cursor: "pointer",
                  backgroundColor: active ? "rgba(34,197,94,0.15)" : "var(--ba-input-bg)",
                  color: active ? "#22c55e" : "var(--ba-muted)",
                }}
              >
                {loc.short}
              </button>
            );
          })}
        </div>

        {/* Date nav */}
        <button
          type="button"
          onClick={() => onDateChange(todayET())}
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
        <button type="button" onClick={() => shiftDate(-1)} style={NAV_BTN}>
          &larr;
        </button>
        <button type="button" onClick={() => shiftDate(1)} style={NAV_BTN}>
          &rarr;
        </button>
        <input
          type="date"
          value={date}
          onChange={(e) => {
            if (e.target.value) onDateChange(e.target.value);
          }}
          style={INPUT_STYLE}
        />

        {/* View type */}
        <select
          value={viewType}
          onChange={(e) => onViewTypeChange(e.target.value as ViewType)}
          style={{ ...INPUT_STYLE, cursor: "pointer", minWidth: 160 }}
        >
          <option value="group">Group Functions</option>
          <option value="online">Online Reservations</option>
        </select>

        {/* State filter */}
        <select
          value={stateFilter}
          onChange={(e) => onStateFilterChange(e.target.value as StateFilter)}
          style={{ ...INPUT_STYLE, cursor: "pointer", minWidth: 140 }}
        >
          <option value="all">All States</option>
          <option value="confirmed">Confirmed</option>
          {viewType === "group" && (
            <>
              <option value="send_contract">Send Contract</option>
              <option value="pending_signed">Pending Signed Contract</option>
              <option value="deposit_requested">Deposit Requested</option>
            </>
          )}
          <option value="cancelled">Cancelled</option>
        </select>
      </div>
    </div>
  );
}
