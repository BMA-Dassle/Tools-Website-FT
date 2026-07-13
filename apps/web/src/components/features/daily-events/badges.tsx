"use client";

/**
 * Daily Events — shared badge/pill atoms, ported faithfully from the
 * employee portal's DailyEventsPage (Tailwind classes translated to inline
 * styles: green-500/20 bg + green-400 text, amber-500/20 + amber-400,
 * emerald-500/20 + emerald-400). Consumed by both the list rows/cards and
 * the detail modal — do NOT rename these exports.
 */
import { getStateBadgePalette } from "~/features/daily-events/logic";

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
