"use client";

import { PORTAL_DARK } from "~/components/features/admin-skin/theme";
import type { WebSaleRow } from "~/features/web-sales";
import StatusPill from "./StatusPill";
import { buyerLabel, money, recipientLabel, refundChip, whenLabel, whenLabelLong } from "./format";

const TH: React.CSSProperties = {
  textAlign: "left",
  padding: "8px 12px 8px 0",
  fontSize: 10,
  fontWeight: 600,
  letterSpacing: "0.1em",
  textTransform: "uppercase",
  color: PORTAL_DARK.muted,
  whiteSpace: "nowrap",
};

const TD: React.CSSProperties = {
  padding: "12px 12px 12px 0",
  verticalAlign: "top",
  fontSize: 13,
};

/**
 * The desktop table.
 *
 * Voucher codes are deliberately NOT a column: they were the widest and least
 * scannable thing on the single-product board, and they belong in the detail
 * drawer where there is room to show which legs are still live. The search box
 * still finds a sale by code.
 */
export default function SaleTable({
  rows,
  onSelect,
}: {
  rows: WebSaleRow[];
  onSelect: (id: string) => void;
}) {
  return (
    // Wide content scrolls inside its own container — the page body must never
    // scroll horizontally.
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", minWidth: 880, borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ borderBottom: `1px solid ${PORTAL_DARK.border}` }}>
            <th style={TH}>When</th>
            <th style={TH}>Buyer</th>
            <th style={TH}>Product</th>
            <th style={{ ...TH, textAlign: "right" }}>Qty</th>
            <th style={{ ...TH, textAlign: "right" }}>Paid</th>
            <th style={TH}>Status</th>
            <th style={TH}>Source</th>
            <th style={TH}>
              <span className="sr-only">Open</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const chip = refundChip(row);
            const recipient = recipientLabel(row);
            return (
              <tr key={row.id} style={{ borderBottom: `1px solid ${PORTAL_DARK.border}55` }}>
                <td style={{ ...TD, whiteSpace: "nowrap", color: PORTAL_DARK.muted }} title={whenLabelLong(row.soldAt)}>
                  {whenLabel(row.soldAt)}
                </td>

                <td style={TD}>
                  <div style={{ color: PORTAL_DARK.fg }}>{buyerLabel(row)}</div>
                  {row.buyer.email && (
                    <div style={{ fontSize: 11, color: PORTAL_DARK.muted }}>{row.buyer.email}</div>
                  )}
                  {row.buyer.phone && (
                    <div style={{ fontSize: 11, color: PORTAL_DARK.muted }}>{row.buyer.phone}</div>
                  )}
                  {recipient && (
                    <div style={{ fontSize: 11, color: PORTAL_DARK.muted }}>&rarr; {recipient}</div>
                  )}
                </td>

                <td style={TD}>
                  <div style={{ color: PORTAL_DARK.fg }}>{row.product.label}</div>
                  {row.product.sublabel && (
                    <div style={{ fontSize: 11, color: PORTAL_DARK.muted }}>{row.product.sublabel}</div>
                  )}
                </td>

                <td style={{ ...TD, textAlign: "right", color: PORTAL_DARK.muted }}>{row.product.qty}</td>

                <td style={{ ...TD, textAlign: "right", whiteSpace: "nowrap", color: PORTAL_DARK.fg }}>
                  {money(row.money.paidCents)}
                  {chip && (
                    <div style={{ marginTop: 4 }}>
                      <StatusPill label={chip.label} tone={chip.tone} />
                    </div>
                  )}
                </td>

                <td style={TD}>
                  <StatusPill
                    label={row.status.label}
                    tone={row.status.tone}
                    strikeThrough={row.refund.kind === "voided"}
                  />
                  {row.status.problem && (
                    <div style={{ marginTop: 5, maxWidth: 260, fontSize: 11, color: "#fca5a5" }}>
                      {row.status.problem}
                    </div>
                  )}
                </td>

                <td style={{ ...TD, fontSize: 11, color: PORTAL_DARK.muted }}>
                  <div>{row.source}</div>
                  <div>{row.attribution.label}</div>
                </td>

                {/* A real button rather than a click handler on the <tr>: the
                    row has to be reachable and operable from a keyboard, and
                    the a11y gate enforces it. */}
                <td style={{ ...TD, textAlign: "right", whiteSpace: "nowrap" }}>
                  <button
                    type="button"
                    onClick={() => onSelect(row.id)}
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      padding: "5px 11px",
                      borderRadius: 7,
                      cursor: "pointer",
                      color: PORTAL_DARK.fg,
                      background: "transparent",
                      border: `1px solid ${PORTAL_DARK.border}`,
                    }}
                  >
                    Open
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
