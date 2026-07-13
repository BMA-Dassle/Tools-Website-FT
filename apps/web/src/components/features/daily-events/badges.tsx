"use client";

/**
 * Daily Events — shared badge/pill atoms, ported faithfully from the
 * employee portal's DailyEventsPage (Tailwind classes translated to inline
 * styles: green-500/20 bg + green-400 text, amber-500/20 + amber-400,
 * emerald-500/20 + emerald-400). Consumed by both the list rows/cards and
 * the detail modal — do NOT rename these exports.
 */
import { fmtCurrency } from "~/features/daily-events/format";
import { getStateBadgePalette } from "~/features/daily-events/logic";
import type { WebsitePaymentInfo } from "~/features/daily-events/types";

/** Reservation state pill (portal Badge + getStateBadgeVariant). */
export function StateBadge({ state }: { state: string }) {
  const palette = getStateBadgePalette(state);
  return (
    <span
      style={{
        display: "inline-block",
        padding: "0.125rem 0.625rem",
        borderRadius: 9999,
        fontSize: "0.75rem",
        fontWeight: 600,
        backgroundColor: palette.bg,
        color: palette.fg,
        whiteSpace: "nowrap",
      }}
    >
      {state || "—"}
    </span>
  );
}

/** Amber "DUAL" pill for multi-location events (portal isMultiLocation). */
export function DualBadge({
  otherLocationName,
  compact,
}: {
  otherLocationName?: string;
  compact?: boolean;
}) {
  return (
    <span
      title={`Multi-location event — also at ${otherLocationName || "another location"}`}
      style={{
        display: "inline-block",
        padding: compact ? "0.125rem 0.25rem" : "0.125rem 0.375rem",
        fontSize: compact ? "9px" : "10px",
        fontWeight: 700,
        borderRadius: 4,
        backgroundColor: "rgba(245,158,11,0.2)",
        color: "#fbbf24",
        border: "1px solid rgba(245,158,11,0.4)",
        whiteSpace: "nowrap",
        flexShrink: 0,
        ...(compact ? { marginLeft: "0.375rem", verticalAlign: "middle" } : {}),
      }}
    >
      DUAL
    </span>
  );
}

/** Green "PAID" pill with check glyph (portal isFullyPaid pill). */
export function PaidPill() {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "0.125rem 0.375rem",
        borderRadius: 9999,
        backgroundColor: "rgba(34,197,94,0.2)",
        color: "#4ade80",
        fontSize: "10px",
        fontWeight: 700,
        whiteSpace: "nowrap",
      }}
    >
      <svg width={12} height={12} fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M9 14l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
        />
      </svg>
      PAID
    </span>
  );
}

/** Emerald "DEPOSIT" pill (portal status === "deposit_paid"). */
export function DepositPill() {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "0.125rem 0.375rem",
        borderRadius: 9999,
        backgroundColor: "rgba(16,185,129,0.2)",
        color: "#34d399",
        fontSize: "10px",
        fontWeight: 700,
        whiteSpace: "nowrap",
      }}
    >
      DEPOSIT
    </span>
  );
}

/** Red "UNPAID" pill — website quote exists but nothing collected yet. */
export function UnpaidPill({ quoteStatus }: { quoteStatus?: string }) {
  return (
    <span
      title={
        quoteStatus
          ? `Website quote is "${quoteStatus.replace(/_/g, " ")}" — nothing collected yet`
          : "Nothing collected yet"
      }
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "0.125rem 0.375rem",
        borderRadius: 9999,
        backgroundColor: "rgba(239,68,68,0.18)",
        color: "#f87171",
        fontSize: "10px",
        fontWeight: 700,
        whiteSpace: "nowrap",
      }}
    >
      UNPAID
    </span>
  );
}

/**
 * Which payment pill a website quote earns. Deposit is judged on money
 * actually collected (depositPaidCents), not the status string — statuses
 * like balance_link_sent are deposit-paid too.
 */
export function paymentPillFor(wp: {
  isFullyPaid: boolean;
  depositPaidCents: number;
  status: string;
}): "paid" | "deposit" | "unpaid" | null {
  if (wp.isFullyPaid) return "paid";
  if (wp.depositPaidCents > 0) return "deposit";
  if (wp.status.includes("cancel")) return null;
  return "unpaid";
}

/**
 * Right-aligned payment block for list rows — ONE consistent cell shared by
 * the day list and the weekly sections: payment pill + state badge on the
 * first line, progress bar + "collected / total" on the second. Fixed bar
 * width and tabular numerals keep rows vertically aligned.
 */
export function PaymentCell({
  wp,
  state,
  fallbackBalance,
}: {
  wp?: WebsitePaymentInfo;
  state: string;
  /** BMI balance shown muted when the event has no website quote. */
  fallbackBalance?: number;
}) {
  const pill = wp ? paymentPillFor(wp) : null;
  const totalCents = wp?.totalCents || 0;
  const paidCents = wp ? (wp.isFullyPaid ? wp.totalCents : wp.depositPaidCents) : 0;
  const paidPct = totalCents > 0 ? Math.min(100, Math.round((paidCents / totalCents) * 100)) : 0;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-end",
        gap: 5,
        flexShrink: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "0.375rem" }}>
        {pill === "paid" && <PaidPill />}
        {pill === "deposit" && <DepositPill />}
        {pill === "unpaid" && <UnpaidPill quoteStatus={wp?.status} />}
        <StateBadge state={state} />
      </div>
      {wp && totalCents > 0 ? (
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <div
            title={`${fmtCurrency(paidCents / 100)} collected of ${fmtCurrency(totalCents / 100)}`}
            style={{
              width: 72,
              height: 6,
              backgroundColor: "var(--ba-muted2)",
              borderRadius: 9999,
              overflow: "hidden",
            }}
          >
            <div
              style={{
                height: "100%",
                borderRadius: 9999,
                width: `${paidPct}%`,
                backgroundColor:
                  paidPct >= 100 ? "#22c55e" : paidPct > 0 ? "#10b981" : "var(--ba-muted2)",
              }}
            />
          </div>
          <span
            style={{
              fontSize: "0.72rem",
              fontVariantNumeric: "tabular-nums",
              whiteSpace: "nowrap",
            }}
          >
            <span style={{ color: paidCents > 0 ? "#22c55e" : "var(--ba-muted)" }}>
              {fmtCurrency(paidCents / 100)}
            </span>
            <span style={{ color: "var(--ba-muted)" }}> / {fmtCurrency(totalCents / 100)}</span>
          </span>
        </div>
      ) : !wp && fallbackBalance ? (
        <span style={{ fontSize: "0.72rem", color: "var(--ba-muted)" }}>
          {fmtCurrency(fallbackBalance)}
        </span>
      ) : null}
    </div>
  );
}

/** Rotating border-circle loading spinner (portal animate-spin). */
export function Spinner({ size = 32 }: { size?: number }) {
  return (
    <div
      className="de-spin"
      style={{
        width: size,
        height: size,
        border: "2px solid transparent",
        borderTopColor: "#22c55e",
        borderBottomColor: "#22c55e",
      }}
    />
  );
}
