"use client";

import { PORTAL_DARK } from "~/components/features/admin-skin/theme";
import type { WebSaleRow } from "~/features/web-sales";
import StatusPill from "./StatusPill";
import { buyerLabel, money, recipientLabel, refundChip, whenLabel } from "./format";

/**
 * The phone layout.
 *
 * Not a nicety — the staff sale alert links straight here, so the first time
 * anyone opens this board it is usually on a phone, one-handed, standing on a
 * lane approach (owner 2026-08-03). The single-product board grew this layout
 * for that reason and it must not regress in the generalisation.
 */
export default function SaleCardList({
  rows,
  onSelect,
}: {
  rows: WebSaleRow[];
  onSelect: (id: string) => void;
}) {
  return (
    <div style={{ display: "grid", gap: 10 }}>
      {rows.map((row) => {
        const chip = refundChip(row);
        const recipient = recipientLabel(row);
        return (
          // The whole card is the tap target on a phone — but as a <button>, so
          // it is keyboard-reachable rather than a div with an onClick.
          <button
            key={row.id}
            type="button"
            onClick={() => onSelect(row.id)}
            style={{
              display: "block",
              width: "100%",
              textAlign: "left",
              cursor: "pointer",
              color: "inherit",
              font: "inherit",
              background: PORTAL_DARK.card,
              border: `1px solid ${PORTAL_DARK.border}`,
              borderRadius: 12,
              padding: 14,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600, color: PORTAL_DARK.fg, overflowWrap: "anywhere" }}>
                  {buyerLabel(row)}
                </div>
                {row.buyer.email && (
                  <div style={{ fontSize: 12, color: PORTAL_DARK.muted, overflowWrap: "anywhere" }}>
                    {row.buyer.email}
                  </div>
                )}
                {row.buyer.phone && (
                  <div style={{ fontSize: 12, color: PORTAL_DARK.muted }}>{row.buyer.phone}</div>
                )}
                {recipient && (
                  <div style={{ fontSize: 12, color: PORTAL_DARK.muted }}>&rarr; {recipient}</div>
                )}
              </div>
              <div style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                <div style={{ fontWeight: 700, color: PORTAL_DARK.fg }}>{money(row.money.paidCents)}</div>
                <div style={{ marginTop: 4 }}>
                  <StatusPill
                    label={row.status.label}
                    tone={row.status.tone}
                    strikeThrough={row.refund.kind === "voided"}
                  />
                </div>
                {chip && (
                  <div style={{ marginTop: 4 }}>
                    <StatusPill label={chip.label} tone={chip.tone} />
                  </div>
                )}
              </div>
            </div>

            <div style={{ marginTop: 8, fontSize: 13, color: PORTAL_DARK.fg }}>
              {row.product.label}
              {row.product.qty > 1 && ` × ${row.product.qty}`}
            </div>
            {row.product.sublabel && (
              <div style={{ fontSize: 12, color: PORTAL_DARK.muted }}>{row.product.sublabel}</div>
            )}

            <div style={{ marginTop: 6, fontSize: 11, color: PORTAL_DARK.muted }}>
              {whenLabel(row.soldAt)} · {row.source} · {row.attribution.label}
            </div>

            {row.status.problem && (
              <div style={{ marginTop: 8, fontSize: 12, color: "#fca5a5" }}>{row.status.problem}</div>
            )}
          </button>
        );
      })}
    </div>
  );
}
