"use client";

/**
 * Daily Events — desktop day-list row (portal renderDesktopTable) and the
 * weekly-section row variant (portal weekly JSX, lines ~862-957). Faithful
 * port minus the party/labor assignment display + unassign buttons, which
 * were dropped per owner directive.
 */
import { clickableDivProps } from "@/lib/a11y";
import { fmtCurrency, fmtEventTime } from "~/features/daily-events/format";
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
import { DepositPill, DualBadge, PaidPill, paymentPillFor, StateBadge, UnpaidPill } from "./badges";

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
  const totalCents = wp?.totalCents || 0;
  const paidCents = wp ? (wp.isFullyPaid ? wp.totalCents : wp.depositPaidCents) : 0;
  const paidPct = totalCents > 0 ? Math.min(100, Math.round((paidCents / totalCents) * 100)) : 0;

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

      {/* Row 1: Number, Name, Badges, State, Payment pills */}
      <div
        style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.25rem" }}
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
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.375rem",
            marginLeft: "auto",
            flexShrink: 0,
          }}
        >
          {wp && paymentPillFor(wp) === "paid" && <PaidPill />}
          {wp && paymentPillFor(wp) === "deposit" && <DepositPill />}
          {wp && paymentPillFor(wp) === "unpaid" && <UnpaidPill quoteStatus={wp.status} />}
          <StateBadge state={r.state} />
        </div>
      </div>

      {/* Row 2: Contact, Persons, Time, Staff, Payment progress */}
      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
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
        {totalCents > 0 && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.5rem",
              marginLeft: "auto",
              flexShrink: 0,
            }}
          >
            <div
              title={`${fmtCurrency(paidCents / 100)} / ${fmtCurrency(totalCents / 100)}`}
              style={{
                width: 80,
                height: 8,
                backgroundColor: "var(--ba-muted2)",
                borderRadius: 9999,
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  height: "100%",
                  borderRadius: 9999,
                  transition: "width 0.2s",
                  width: `${paidPct}%`,
                  backgroundColor:
                    paidPct >= 100 ? "#22c55e" : paidPct > 0 ? "#10b981" : "var(--ba-muted2)",
                }}
              />
            </div>
            <span
              style={{
                fontSize: "0.75rem",
                fontVariantNumeric: "tabular-nums",
                fontWeight: 500,
                whiteSpace: "nowrap",
              }}
            >
              <span style={{ color: paidCents > 0 ? "#22c55e" : "var(--ba-muted)" }}>
                {fmtCurrency(paidCents / 100)}
              </span>
              <span style={{ color: "var(--ba-muted)", margin: "0 2px" }}>/</span>
              <span style={{ color: "var(--ba-muted)" }}>{fmtCurrency(totalCents / 100)}</span>
            </span>
          </div>
        )}
        {!totalCents && r.balance ? (
          <span
            style={{
              fontSize: "0.75rem",
              color: "var(--ba-muted)",
              marginLeft: "auto",
              flexShrink: 0,
            }}
          >
            {fmtCurrency(r.balance)}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Weekly-section row: contract-stage left border (deposit-requested orange /
 * send-contract indigo / pending-signed purple) takes precedence over the
 * waiver bar; inline payment text from websitePayments.
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
          {wp?.isFullyPaid ? (
            <span style={{ marginLeft: "0.5rem", color: "#4ade80" }}>
              {fmtCurrency(wp.totalCents / 100)} paid
            </span>
          ) : wp && wp.depositPaidCents > 0 ? (
            <span style={{ marginLeft: "0.5rem", color: "#34d399" }}>
              {fmtCurrency(wp.depositPaidCents / 100)} deposit
              {wp.balanceRemainingCents > 0 && (
                <span style={{ color: "var(--ba-muted)" }}>
                  {" "}
                  / {fmtCurrency(wp.balanceRemainingCents / 100)} due
                </span>
              )}
            </span>
          ) : null}
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: "0.375rem", flexShrink: 0 }}>
        {wp && paymentPillFor(wp) === "paid" && <PaidPill />}
        {wp && paymentPillFor(wp) === "deposit" && <DepositPill />}
        {wp && paymentPillFor(wp) === "unpaid" && <UnpaidPill quoteStatus={wp.status} />}
        <StateBadge state={r.state} />
      </div>
    </div>
  );
}
