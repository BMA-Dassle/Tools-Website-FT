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

/**
 * Red "SQUARE CLOSEOUT" pill — this event will be settled at the POS: no
 * website contract in play, no card on file, no funding gift card. Replaces
 * the old UNPAID pill (owner 2026-07-13: unpaid-but-website-handled events
 * were noise — their state badge already says "Pending Signed Contract").
 */
export function CloseoutPill() {
  return (
    <span
      title="Square closeout required — no website contract or card on file. Ring it up at the POS (ticket 'BMI <event #>'); the auto-close sweep then marks it completed."
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
        cursor: "help",
      }}
    >
      SQUARE CLOSEOUT
    </span>
  );
}

/**
 * Legacy-paid quote: money was collected in the old PandaDoc/BMI flow (prior
 * payments / comped deposit) AND the website has no payment rail to finish
 * the job — no funding gift card, no card on file, no Square deposit. Only
 * then must staff close it out directly in Square at the POS.
 *
 * A CONVERTED event (PandaDoc money carried over, deposit comped, but a gift
 * card was funded / a card saved) is NOT legacy — the normal website
 * auto-close rail applies (Florida Painters 3218, 2026-07-13).
 */
export function isLegacyPaidQuote(wp: {
  isFullyPaid: boolean;
  depositPaidCents: number;
  payments?: Array<{ type: string }>;
  priorPayments?: Array<unknown>;
  giftCardGans?: string[];
  savedCardOnFile?: boolean;
}): boolean {
  if (wp.isFullyPaid) return false; // already closed — no action needed
  if ((wp.giftCardGans ?? []).length > 0 || wp.savedCardOnFile) return false; // website rail exists
  const hasSquareDeposit = (wp.payments ?? []).some((p) => p.type === "deposit");
  if (hasSquareDeposit) return false;
  return (wp.priorPayments ?? []).length > 0 || wp.depositPaidCents > 0;
}

/** Purple "LEGACY" pill — old-flow money; close-out happens at the Square POS. */
export function LegacyPill() {
  return (
    <span
      title="Paid via the legacy PandaDoc/BMI flow — no website payment rail. Close this event out directly in Square at the POS (ticket name 'BMI <event #>'); the auto-close sweep will then mark it completed and cancel the unused website day-of order."
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 3,
        padding: "0.125rem 0.375rem",
        borderRadius: 9999,
        backgroundColor: "rgba(168,85,247,0.18)",
        color: "#c084fc",
        fontSize: "10px",
        fontWeight: 700,
        whiteSpace: "nowrap",
        cursor: "help",
      }}
    >
      LEGACY
      <span
        style={{
          fontSize: "9px",
          border: "1px solid rgba(192,132,252,0.6)",
          borderRadius: "50%",
          width: 11,
          height: 11,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          lineHeight: 1,
        }}
      >
        ?
      </span>
    </span>
  );
}

/**
 * Which payment pill a website quote earns. Deposit is judged on money
 * actually collected (depositPaidCents), not the status string — statuses
 * like balance_link_sent are deposit-paid too. "closeout" (the red SQUARE
 * CLOSEOUT pill) only fires when POS settlement is the expected path: no
 * contract dispatched to the guest and no website payment rail — an unpaid
 * event whose contract is out for signature is the website's problem, not
 * the POS's (owner 2026-07-13).
 */
export function paymentPillFor(wp: {
  isFullyPaid: boolean;
  depositPaidCents: number;
  status: string;
  giftCardGans?: string[];
  savedCardOnFile?: boolean;
  contractDispatched?: boolean;
}): "paid" | "deposit" | "closeout" | null {
  if (wp.isFullyPaid) return "paid";
  if (wp.depositPaidCents > 0) return "deposit";
  if (wp.status.includes("cancel")) return null;
  const hasRail = (wp.giftCardGans ?? []).length > 0 || wp.savedCardOnFile;
  if (hasRail || wp.contractDispatched) return null;
  return "closeout";
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
  // Quote-less BMI event carrying a balance: there is nothing on the website
  // side at all, so the POS closeout IS the plan — that's the pill's home.
  const quotelessCloseout =
    !wp && (fallbackBalance || 0) > 0 && !(state || "").toLowerCase().includes("cancel");

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
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.375rem",
          rowGap: 4,
          flexWrap: "wrap",
          justifyContent: "flex-end",
        }}
      >
        {wp && isLegacyPaidQuote(wp) && <LegacyPill />}
        {pill === "paid" && <PaidPill />}
        {pill === "deposit" && <DepositPill />}
        {(pill === "closeout" || quotelessCloseout) && <CloseoutPill />}
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
