"use client";

/**
 * Daily Events v2 — banded day section card (owner-approved hybrid,
 * 2026-07-13): v1's day-group structure kept verbatim (band header,
 * two-line rows, contract-stage/waiver left stripes, PaymentCell), with
 * the band gaining a right-side summary: events · persons · risk counts ·
 * collected/expected. Used by BOTH the Day view (one card) and the Week
 * view (seven cards) — one component, two zoom levels.
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
import { ADMIN_MONO, PORTAL_BLUE_SOFT } from "~/components/features/admin-skin/theme";
import { DualBadge, PaymentCell, WAIVER_TEXT_COLORS } from "../daily-events/badges";

export interface DaySummary {
  events: number;
  persons: number;
  collectedCents: number;
  expectedCents: number;
  waiverRisk: number;
  needsContract: number;
}

export function summarizeDay(
  reservations: Reservation[],
  websitePayments: Map<string, WebsitePaymentInfo>,
  thresholds: WaiverThresholds,
): DaySummary {
  const sum: DaySummary = {
    events: reservations.length,
    persons: 0,
    collectedCents: 0,
    expectedCents: 0,
    waiverRisk: 0,
    needsContract: 0,
  };
  for (const r of reservations) {
    sum.persons += r.persons || 0;
    const wp = websitePayments.get(r.number || r.id);
    if (wp) {
      sum.expectedCents += wp.totalCents;
      sum.collectedCents += wp.isFullyPaid ? wp.totalCents : wp.depositPaidCents;
    }
    if (getWaiverStatus(r, thresholds)?.color === "red") sum.waiverRisk++;
    if (isSendContract(r.state) || isPendingSignedContract(r.state)) sum.needsContract++;
  }
  return sum;
}

function fmtUsd(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);
}

export default function DayCard({
  label,
  isToday,
  reservations,
  websitePayments,
  waiverThresholds,
  onOpen,
  onOpenDay,
  posChecks,
  pastDate,
}: {
  /** Band label, e.g. "Wed, Jul 15" or "Tuesday, July 14". */
  label: string;
  isToday: boolean;
  reservations: Reservation[];
  websitePayments: Map<string, WebsitePaymentInfo>;
  waiverThresholds: WaiverThresholds;
  onOpen: (r: Reservation) => void;
  /** Week view: clicking the band zooms into that day. */
  onOpenDay?: () => void;
  /** Quote-less events: POS check totals (cents) or null = checked, none. */
  posChecks?: Map<string, number | null>;
  /** This card's date is in the past — unpaid rows go red (owner 2026-07-13). */
  pastDate?: boolean;
}) {
  const sum = summarizeDay(reservations, websitePayments, waiverThresholds);
  const risks: string[] = [];
  if (sum.needsContract > 0) {
    risks.push(`${sum.needsContract} need${sum.needsContract === 1 ? "s" : ""} contract`);
  }
  if (sum.waiverRisk > 0) risks.push(`${sum.waiverRisk} waiver risk`);

  return (
    <div
      style={{
        backgroundColor: "var(--ba-bg2)",
        border: `1px solid ${isToday ? "rgba(59,130,246,0.55)" : "var(--ba-border)"}`,
        borderRadius: 8,
        overflow: "hidden",
        boxShadow: "0 1px 3px var(--ba-shadow)",
      }}
    >
      {/* Band header */}
      <div
        {...(onOpenDay ? clickableDivProps(onOpenDay, `Open ${label}`) : {})}
        style={{
          backgroundColor: "var(--ba-muted2)",
          padding: "9px 16px",
          display: "flex",
          alignItems: "baseline",
          gap: 12,
          rowGap: 2,
          flexWrap: "wrap",
          cursor: onOpenDay ? "pointer" : undefined,
        }}
      >
        <b style={{ fontSize: "0.9rem", color: isToday ? PORTAL_BLUE_SOFT : "var(--ba-fg)" }}>
          {label}
          {isToday ? " — Today" : ""}
        </b>
        <span
          style={{
            marginLeft: "auto",
            fontSize: "0.75rem",
            color: "var(--ba-muted)",
            fontVariantNumeric: "tabular-nums",
            textAlign: "right",
          }}
        >
          {sum.events === 0 ? (
            "no group functions"
          ) : (
            <>
              {sum.events} event{sum.events === 1 ? "" : "s"} · {sum.persons} persons
              {risks.length > 0 && <span style={{ color: "#f59e0b" }}> ({risks.join(", ")})</span>}
              {sum.expectedCents > 0 && (
                <span style={{ fontFamily: ADMIN_MONO, marginLeft: 12 }}>
                  <span style={{ color: sum.collectedCents > 0 ? "#22c55e" : "var(--ba-muted)" }}>
                    {fmtUsd(sum.collectedCents)}
                  </span>{" "}
                  / {fmtUsd(sum.expectedCents)}
                </span>
              )}
            </>
          )}
        </span>
      </div>

      {/* Rows */}
      {reservations.map((r) => {
        const isClickable = !r._isDayPlannerBlock;
        const waiver = getWaiverStatus(r, waiverThresholds);
        const wp = websitePayments.get(r.number || r.id);
        const key = r.number || r.id;
        const pos: "pending" | "none" | number | undefined = wp
          ? undefined
          : posChecks?.has(key)
            ? (posChecks.get(key) ?? "none")
            : posChecks
              ? "pending"
              : "none";
        const cancelled = (r.state || "").toLowerCase().includes("cancel");
        // Past the event date with money still owed — loud red row (owner
        // 2026-07-13). Quote: not fully paid. Quote-less: BMI balance open
        // and Square CONFIRMED there is no POS check ("pending" stays calm).
        const pastUnpaid =
          !!pastDate &&
          !cancelled &&
          !r._isDayPlannerBlock &&
          (wp
            ? !wp.isFullyPaid && !wp.status.includes("cancel")
            : pos === "none" && (r.balance || 0) > 0);
        const stripe = pastUnpaid
          ? "#ef4444"
          : isDepositRequested(r.state)
            ? "#f97316"
            : isSendContract(r.state)
              ? "#6366f1"
              : isPendingSignedContract(r.state)
                ? "#a855f7"
                : getWaiverBarColor(r, waiverThresholds);
        return (
          <div
            key={r.id}
            {...(isClickable
              ? clickableDivProps(() => onOpen(r), `Open event ${r.number || r.id}`)
              : {})}
            className={isClickable ? "ba-row" : undefined}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              rowGap: 6,
              flexWrap: "wrap",
              padding: "12px 16px",
              borderTop: "1px solid var(--ba-border)",
              cursor: isClickable ? "pointer" : undefined,
              position: "relative",
              transition: "background-color 0.12s",
              ...(pastUnpaid ? { backgroundColor: "rgba(239,68,68,0.09)" } : {}),
            }}
          >
            {stripe && (
              <span
                style={{
                  position: "absolute",
                  left: 0,
                  top: 0,
                  bottom: 0,
                  width: 3,
                  backgroundColor: stripe,
                }}
              />
            )}
            <div style={{ flex: "1 1 240px", minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 9 }}>
                <span
                  style={{
                    fontFamily: ADMIN_MONO,
                    fontSize: "0.72rem",
                    fontWeight: 700,
                    color: "var(--ba-muted)",
                    flexShrink: 0,
                  }}
                >
                  {r.number || r.id.slice(0, 12)}
                </span>
                <span
                  style={{
                    fontWeight: 600,
                    fontSize: "0.9rem",
                    color: "var(--ba-fg)",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {r.name || "—"}
                </span>
                {r.isMultiLocation && <DualBadge compact otherLocationName={r.otherLocationName} />}
              </div>
              <div
                style={{
                  fontSize: "0.78rem",
                  color: "var(--ba-muted)",
                  marginTop: 1,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {r.personName || "Unknown"}
                <span style={{ margin: "0 0.375rem" }}>&middot;</span>
                {waiver ? (
                  <span style={{ color: WAIVER_TEXT_COLORS[waiver.color] }}>
                    {waiver.registered} / {r.persons} registered
                  </span>
                ) : r._provisional && !r.persons ? (
                  // Local seed without a guest count — don't render "0 persons"
                  <>—</>
                ) : (
                  <>
                    {r.persons || 0}
                    {r.capacity ? ` / ${r.capacity}` : ""} persons
                  </>
                )}
                {r.when && (
                  <span
                    style={{ marginLeft: "0.375rem", fontFamily: ADMIN_MONO, fontSize: "0.75rem" }}
                  >
                    {fmtEventTime(r.when)}
                  </span>
                )}
                {r.responsible && (
                  <>
                    <span style={{ margin: "0 0.375rem" }}>&middot;</span>
                    {r.responsible}
                  </>
                )}
              </div>
            </div>
            {/* On narrow screens the cell wraps to its own right-aligned line */}
            <div style={{ marginLeft: "auto" }}>
              <PaymentCell wp={wp} state={r.state} fallbackBalance={r.balance} pos={pos} />
            </div>
            {pastUnpaid && (
              <div
                style={{
                  width: "100%",
                  color: "#f87171",
                  fontSize: "0.74rem",
                  fontWeight: 600,
                }}
              >
                NOT PAID — the event date has passed. If you&rsquo;re seeing this in error, contact
                IT.
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
