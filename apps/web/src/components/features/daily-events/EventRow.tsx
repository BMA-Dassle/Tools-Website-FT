"use client";

/**
 * Daily Events — desktop day-list row (portal renderDesktopTable) and the
 * weekly-section row variant (portal weekly JSX, lines ~862-957). Faithful
 * port minus the party/labor assignment display + unassign buttons, which
 * were dropped per owner directive.
 *
 * Both variants render the SAME right-aligned PaymentCell (pill + state,
 * bar + collected/total) so the day list and weekly sections read
 * identically.
 */
import { clickableDivProps } from "@/lib/a11y";
import { fmtEventTime } from "~/features/daily-events/format";
import {
  getWaiverBarColor,
  getWaiverStatus,
  isDepositRequested,
  isPendingSignedContract,
  isSendContract,
} from "~/features/daily-events/logic";
import type {
  Reservation,
  WaiverThresholds,
  WebsitePaymentInfo,
} from "~/features/daily-events/types";
import { DualBadge, PaymentCell } from "./badges";

/** Waiver registration text colors — Tailwind *-400 shades (portal text-red-400 etc.). */
export const WAIVER_TEXT_COLORS: Record<"red" | "yellow" | "green", string> = {
  red: "#f87171",
  yellow: "#facc15",
  green: "#4ade80",
};

const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

export default function EventRow({
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
        padding: "0.75rem 1rem",
        position: "relative",
        cursor: isClickable ? "pointer" : undefined,
        borderTop: first ? undefined : "1px solid var(--ba-border)",
        transition: "background-color 0.12s",
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

      <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
        {/* Left: name line + info line */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.5rem",
              marginBottom: "0.25rem",
            }}
          >
            <span
              style={{
                fontFamily: MONO,
                fontSize: "0.75rem",
                fontWeight: 700,
                color: "var(--ba-muted)",
                flexShrink: 0,
              }}
            >
              {r.number || r.id.slice(0, 12)}
            </span>
            {r.isMultiLocation && <DualBadge otherLocationName={r.otherLocationName} />}
            <span
              style={{
                fontSize: "0.875rem",
                fontWeight: 500,
                color: "var(--ba-fg)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {r.name || "—"}
            </span>
          </div>
          <div
            style={{
              fontSize: "0.75rem",
              color: "var(--ba-muted)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {r.personName || "Unknown"}
            <span style={{ margin: "0 0.375rem" }}>&middot;</span>
            {waiver ? (
              <span style={{ color: WAIVER_TEXT_COLORS[waiver.color] }}>
                {waiver.registered}/{r.persons} registered
              </span>
            ) : (
              <>
                {r.persons || 0}
                {r.capacity ? ` / ${r.capacity}` : ""} persons
              </>
            )}
            {r.when && <span style={{ marginLeft: "0.375rem" }}>{fmtEventTime(r.when)}</span>}
            {r.responsible && (
              <>
                <span style={{ margin: "0 0.375rem" }}>&middot;</span>
                {r.responsible}
              </>
            )}
          </div>
        </div>

        {/* Right: payment pill + state, bar + collected/total */}
        <PaymentCell wp={wp} state={r.state} fallbackBalance={r.balance} />
      </div>
    </div>
  );
}

/**
 * Weekly-section row: contract-stage left border (deposit-requested orange /
 * send-contract indigo / pending-signed purple) takes precedence over the
 * waiver bar; same PaymentCell as the day list.
 */
export function WeekEventRow({
  r,
  websitePayments,
  waiverThresholds,
  onOpen,
}: {
  r: Reservation;
  websitePayments: Map<string, WebsitePaymentInfo>;
  waiverThresholds: WaiverThresholds;
  onOpen: (r: Reservation) => void;
}) {
  const waiver = getWaiverStatus(r, waiverThresholds);
  const barColor = getWaiverBarColor(r, waiverThresholds);
  const isDeposit = isDepositRequested(r.state);
  const isSend = isSendContract(r.state);
  const isPending = isPendingSignedContract(r.state);
  const leftBorder = isDeposit ? "#f97316" : isSend ? "#6366f1" : isPending ? "#a855f7" : null;
  const wp = websitePayments.get(r.number || r.id);

  return (
    <div
      {...clickableDivProps(() => onOpen(r), `Open event ${r.number || r.id}`)}
      className="ba-row"
      style={{
        display: "flex",
        alignItems: "center",
        gap: "1rem",
        padding: "0.75rem 1rem",
        cursor: "pointer",
        position: "relative",
        transition: "background-color 0.12s",
        borderLeft: leftBorder ? `2px solid ${leftBorder}` : undefined,
      }}
    >
      {!isDeposit && !isSend && !isPending && barColor && (
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
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: "0.875rem",
            fontWeight: 500,
            color: "var(--ba-fg)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          <span style={{ fontFamily: MONO, fontWeight: 700, marginRight: "0.375rem" }}>
            {r.number || r.id.slice(0, 8)}
          </span>
          {r.name || "—"}
          {r.isMultiLocation && <DualBadge compact otherLocationName={r.otherLocationName} />}
        </div>
        <div style={{ fontSize: "0.75rem", color: "var(--ba-muted)" }}>
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
          {r.when && <span style={{ marginLeft: "0.5rem" }}>{fmtEventTime(r.when)}</span>}
        </div>
      </div>
      <PaymentCell wp={wp} state={r.state} fallbackBalance={r.balance} />
    </div>
  );
}
