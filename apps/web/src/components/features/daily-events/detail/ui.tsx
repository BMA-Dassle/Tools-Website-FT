"use client";

/**
 * Shared primitives for the tabbed event-detail view — table cells, info
 * rows, product rows, and the action-bar link/button styles (borrowed from
 * the reservations-admin manage modal so both admin surfaces read the same).
 */
import { fmtCurrency } from "~/features/daily-events/format";
import { safe } from "~/features/daily-events/print-html";
import type { Product } from "~/features/daily-events/types";

export const TH: React.CSSProperties = {
  textAlign: "left",
  fontSize: "0.72rem",
  fontWeight: 500,
  color: "var(--ba-muted)",
  padding: "6px 12px",
  borderBottom: "1px solid var(--ba-border)",
  whiteSpace: "nowrap",
};

export const TH_R: React.CSSProperties = { ...TH, textAlign: "right" };

export function td(i: number, extra?: React.CSSProperties): React.CSSProperties {
  return {
    padding: "8px 12px",
    fontSize: "0.875rem",
    color: "var(--ba-fg)",
    verticalAlign: "top",
    borderTop: i > 0 ? "1px solid var(--ba-border)" : undefined,
    ...extra,
  };
}

/** Manage-modal action-bar button/link chrome. Pair with a border + color. */
export const ACTION_BTN: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  background: "none",
  borderRadius: 6,
  fontSize: "0.72rem",
  fontWeight: 700,
  padding: "5px 12px",
  textTransform: "uppercase",
  letterSpacing: "0.03em",
  cursor: "pointer",
  whiteSpace: "nowrap",
  textDecoration: "none",
};

export const BLUE_LINK_BTN: React.CSSProperties = {
  ...ACTION_BTN,
  border: "1px solid rgba(96,165,250,0.4)",
  color: "#60a5fa",
};

export const GREEN_LINK_BTN: React.CSSProperties = {
  ...ACTION_BTN,
  border: "1px solid rgba(52,211,153,0.4)",
  color: "#34d399",
};

export function InfoItem({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ fontSize: "0.875rem" }}>
      <span style={{ color: "var(--ba-muted)" }}>{label}:</span>{" "}
      <span style={{ color: "var(--ba-fg)", fontWeight: 500 }}>{value}</span>
    </div>
  );
}

/** Product rows shared by the Products and Service Charges tables. */
export function ProductRows({ products }: { products: Product[] }) {
  return (
    <tbody>
      {products.map((p, i) => (
        <tr key={safe(p.id) || i}>
          <td style={td(i)}>
            <div>{safe(p.productName) || `Product ${safe(p.productId)}`}</div>
            {safe(p.nameOverride) && (
              <div style={{ fontSize: "0.75rem", color: "var(--ba-muted)", marginTop: 2 }}>
                Override: {safe(p.nameOverride)}
              </div>
            )}
          </td>
          <td style={td(i, { textAlign: "right" })}>{safe(p.quantity)}</td>
          <td style={td(i, { textAlign: "right", fontWeight: 500 })}>
            {fmtCurrency(p.totalPrice || 0)}
          </td>
        </tr>
      ))}
    </tbody>
  );
}
