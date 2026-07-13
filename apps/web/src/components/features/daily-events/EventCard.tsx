"use client";

/**
 * Daily Events — mobile card (portal renderMobileCards). Faithful port
 * minus the party/labor assignment block + unassign buttons, dropped per
 * owner directive. The "DUAL LOCATION" pill keeps the portal's mobile
 * wording (the shared DualBadge atom renders the shorter "DUAL").
 */
import { clickableDivProps } from "@/lib/a11y";
import { fmtCurrency, fmtEventTime } from "~/features/daily-events/format";
import { getWaiverBarColor, getWaiverStatus } from "~/features/daily-events/logic";
import type {
  Reservation,
  WaiverThresholds,
  WebsitePaymentInfo,
} from "~/features/daily-events/types";
import { DepositPill, PaidPill, StateBadge } from "./badges";
import { WAIVER_TEXT_COLORS } from "./EventRow";

const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

export default function EventCard({
  r,
  first,
  websitePayments,
  waiverThresholds,
  onOpen,
}: {
  r: Reservation;
  first: boolean;
  websitePayments: Map<string, WebsitePaymentInfo>;
  waiverThresholds: WaiverThresholds;
  onOpen: (r: Reservation) => void;
}) {
  const isClickable = !r._isDayPlannerBlock;
  const waiver = getWaiverStatus(r, waiverThresholds);
  const barColor = getWaiverBarColor(r, waiverThresholds);
  const wp = websitePayments.get(r.number || r.id);

  return (
    <div
      {...(isClickable ? clickableDivProps(() => onOpen(r), `Open event ${r.number || r.id}`) : {})}
      className={isClickable ? "ba-row" : undefined}
      style={{
        padding: "1rem",
        position: "relative",
        display: "flex",
        flexDirection: "column",
        gap: "0.5rem",
        borderTop: first ? undefined : "1px solid var(--ba-border)",
      }}
    >
      {barColor && (
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            bottom: 0,
            width: 4,
            backgroundColor: barColor,
          }}
        />
      )}
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: "0.5rem",
        }}
      >
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
            <span
              style={{
                fontFamily: MONO,
                fontSize: "0.875rem",
                fontWeight: 700,
                color: "var(--ba-fg)",
              }}
            >
              {r.number || r.id.slice(0, 12)}
            </span>
            {r.isMultiLocation && (
              <span
                title={`Multi-location event — also at ${r.otherLocationName || "another location"}`}
                style={{
                  padding: "0.125rem 0.375rem",
                  fontSize: "10px",
                  fontWeight: 700,
                  borderRadius: 4,
                  backgroundColor: "rgba(245,158,11,0.2)",
                  color: "#fbbf24",
                  border: "1px solid rgba(245,158,11,0.4)",
                  whiteSpace: "nowrap",
                }}
              >
                DUAL LOCATION
              </span>
            )}
          </div>
          {r.name && (
            <div
              style={{
                fontSize: "0.875rem",
                fontWeight: 500,
                color: "var(--ba-fg)",
                marginTop: 2,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {r.name}
            </div>
          )}
          <div style={{ fontSize: "0.75rem", color: "var(--ba-muted)", marginTop: 4 }}>
            {r.personName || "Unknown"} &middot;{" "}
            {waiver ? (
              <span style={{ color: WAIVER_TEXT_COLORS[waiver.color] }}>
                {waiver.registered} / {r.persons} registered
              </span>
            ) : (
              <>
                {r.persons || 0}
                {r.capacity ? ` / ${r.capacity}` : ""} persons
              </>
            )}
          </div>
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-end",
            flexShrink: 0,
          }}
        >
          <StateBadge state={r.state} />
          {wp?.isFullyPaid ? (
            <div style={{ marginTop: 4 }}>
              <PaidPill />
            </div>
          ) : wp?.status === "deposit_paid" ? (
            <div style={{ marginTop: 4 }}>
              <DepositPill />
            </div>
          ) : r.balance ? (
            <span
              style={{
                fontSize: "0.75rem",
                fontWeight: 500,
                color: "var(--ba-muted)",
                marginTop: 4,
              }}
            >
              {fmtCurrency(r.balance)}
            </span>
          ) : null}
        </div>
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.75rem",
          fontSize: "0.75rem",
          color: "var(--ba-muted)",
          borderTop: "1px solid var(--ba-border)",
          paddingTop: "0.5rem",
        }}
      >
        <span>{r.when ? fmtEventTime(r.when) : "—"}</span>
        {r.responsible && <span>&middot; {r.responsible}</span>}
        {isClickable && <span style={{ marginLeft: "auto", color: "#22c55e" }}>View &rarr;</span>}
      </div>
    </div>
  );
}
