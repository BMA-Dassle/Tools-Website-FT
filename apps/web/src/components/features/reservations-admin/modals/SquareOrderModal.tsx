"use client";

/**
 * Square day-of order inspector popover — line items, tax, discounts,
 * remaining due, reward + coupon callouts. Owns its own fetch (the parent
 * only holds the target). Extracted verbatim from
 * app/admin/[token]/reservations/ReservationsClient.tsx (the fetch effect
 * moved in from the page body).
 */
import { useEffect, useState } from "react";
import type { SquareLineItem, SquareServiceCharge } from "~/features/reservations-admin/types";
import ModalShell from "../ModalShell";
import { squareOrderTotals } from "./squareOrderTotals";

export interface OrderTarget {
  guestName: string;
  squareDayofOrderId: string | null;
  rewardDiscountCents: number;
  squareLoyaltyRewardId?: string | null;
  promoCode?: string | null;
  promoSavingsCents?: number;
}

interface OrderMeta {
  state: string;
  totalCents: number;
  taxCents: number;
  discountCents: number;
  remainingCents: number;
  /**
   * Pre-tax service charges. A Square order's service charges are NOT line items, so
   * without this the footer showed `Subtotal + Tax` against a larger `Total` and the
   * difference was invisible — group events carry a 12–15% service charge.
   */
  serviceChargeCents: number;
}

export default function SquareOrderModal({
  target,
  token,
  onClose,
}: {
  target: OrderTarget;
  token: string;
  onClose: () => void;
}) {
  const [orderItems, setOrderItems] = useState<SquareLineItem[] | null>(null);
  const [orderCharges, setOrderCharges] = useState<SquareServiceCharge[]>([]);
  const [orderLoading, setOrderLoading] = useState(false);
  const [orderMeta, setOrderMeta] = useState<OrderMeta | null>(null);

  // Fetch Square order details for the target
  useEffect(() => {
    if (!target.squareDayofOrderId) return;
    let alive = true;
    setOrderLoading(true);
    setOrderItems(null);
    setOrderCharges([]);
    setOrderMeta(null);
    const params = new URLSearchParams({ token, orderId: target.squareDayofOrderId });
    fetch(`/api/admin/bowling/square-order?${params}`, { cache: "no-store" })
      .then((res) => res.json())
      .then((data) => {
        if (!alive) return;
        if (data.error) {
          setOrderItems([]);
          return;
        }
        setOrderItems(data.lineItems ?? []);
        setOrderCharges(data.serviceCharges ?? []);
        setOrderMeta({
          state: data.state,
          totalCents: data.totalCents,
          taxCents: data.taxCents ?? 0,
          discountCents: data.discountCents ?? 0,
          remainingCents: data.remainingCents,
          serviceChargeCents: data.serviceChargeCents ?? 0,
        });
      })
      .catch(() => {
        if (alive) setOrderItems([]);
      })
      .finally(() => {
        if (alive) setOrderLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [target, token]);

  return (
    <ModalShell
      onClose={onClose}
      maxWidth={500}
      maxHeight="80vh"
      borderRadius={12}
      padding={24}
      blurBackdrop={false}
    >
      <h3 style={{ margin: "0 0 4px", fontSize: "0.95rem", fontWeight: 700 }}>
        Square Order — {target.guestName}
      </h3>
      <p
        style={{
          margin: "0 0 16px",
          color: "var(--ba-muted)",
          fontSize: "0.68rem",
          fontFamily: "monospace",
        }}
      >
        {target.squareDayofOrderId}
      </p>

      {orderLoading && <p style={{ color: "var(--ba-muted)", fontSize: "0.8rem" }}>Loading…</p>}

      {orderMeta && (
        <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 12 }}>
          <span
            style={{
              padding: "2px 8px",
              borderRadius: 5,
              fontSize: "0.65rem",
              fontWeight: 600,
              background:
                orderMeta.state === "OPEN"
                  ? "rgba(59,130,246,0.15)"
                  : orderMeta.state === "COMPLETED"
                    ? "rgba(34,197,94,0.15)"
                    : "rgba(239,68,68,0.15)",
              color:
                orderMeta.state === "OPEN"
                  ? "#3b82f6"
                  : orderMeta.state === "COMPLETED"
                    ? "#22c55e"
                    : "#ef4444",
              border: `1px solid ${orderMeta.state === "OPEN" ? "rgba(59,130,246,0.3)" : orderMeta.state === "COMPLETED" ? "rgba(34,197,94,0.3)" : "rgba(239,68,68,0.3)"}`,
            }}
          >
            {orderMeta.state}
          </span>
          {orderMeta.remainingCents > 0 && (
            <span style={{ color: "var(--ba-muted)", fontSize: "0.75rem" }}>
              Due:{" "}
              <strong style={{ color: "#f59e0b" }}>
                ${(orderMeta.remainingCents / 100).toFixed(2)}
              </strong>
            </span>
          )}
        </div>
      )}

      {target.rewardDiscountCents > 0 && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 12,
            padding: "6px 10px",
            borderRadius: 6,
            background: "rgba(255,215,0,0.08)",
            border: "1px solid rgba(255,215,0,0.2)",
          }}
        >
          <span style={{ fontSize: "0.85rem" }}>⭐</span>
          <span style={{ color: "#FFD700", fontSize: "0.75rem", fontWeight: 600 }}>
            HeadPinz Reward −${(target.rewardDiscountCents / 100).toFixed(2)}
          </span>
          {target.squareLoyaltyRewardId && (
            <span
              style={{
                color: "var(--ba-muted)",
                fontSize: "0.6rem",
                fontFamily: "monospace",
              }}
            >
              {target.squareLoyaltyRewardId.slice(0, 8)}…
            </span>
          )}
        </div>
      )}

      {target.promoCode && (target.promoSavingsCents ?? 0) > 0 && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 12,
            padding: "6px 10px",
            borderRadius: 6,
            background: "rgba(168,85,247,0.08)",
            border: "1px solid rgba(168,85,247,0.25)",
          }}
        >
          <span style={{ color: "#c084fc", fontSize: "0.75rem", fontWeight: 600 }}>
            Coupon {target.promoCode} −$
            {((target.promoSavingsCents ?? 0) / 100).toFixed(2)}
          </span>
        </div>
      )}

      {orderItems &&
        orderItems.length > 0 &&
        (() => {
          // Footer maths lives in squareOrderTotals (unit-tested) — service charges are
          // their own array on a Square order and are easy to leave out of a sum.
          const { subtotalCents, serviceChargeCents, taxCents, discountCents, totalCents } =
            squareOrderTotals(orderItems, orderCharges, orderMeta);
          return (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.78rem" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--ba-border)" }}>
                  {["Item", "Qty", "Price"].map((h) => (
                    <th
                      key={h}
                      style={{
                        padding: "6px 8px",
                        textAlign: h === "Item" ? "left" : "right",
                        color: "var(--ba-muted)",
                        fontSize: "0.65rem",
                        textTransform: "uppercase",
                        fontWeight: 600,
                      }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {orderItems.map((li) => (
                  <tr key={li.uid} style={{ borderBottom: "1px solid var(--ba-border)" }}>
                    <td style={{ padding: "6px 8px" }}>
                      <div style={{ fontWeight: 600 }}>{li.name}</div>
                      {li.note && (
                        <div
                          style={{
                            color: "var(--ba-muted)",
                            fontSize: "0.68rem",
                            fontStyle: "italic",
                          }}
                        >
                          {li.note}
                        </div>
                      )}
                    </td>
                    <td
                      style={{
                        padding: "6px 8px",
                        textAlign: "right",
                        color: "var(--ba-muted)",
                      }}
                    >
                      {li.quantity}
                    </td>
                    <td
                      style={{
                        padding: "6px 8px",
                        textAlign: "right",
                        fontWeight: 600,
                        color: li.grossCents === 0 ? "var(--ba-muted)" : "var(--ba-fg)",
                      }}
                    >
                      {li.grossCents === 0 ? "$0" : `$${(li.grossCents / 100).toFixed(2)}`}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ borderTop: "1px solid var(--ba-border)" }}>
                  <td
                    colSpan={2}
                    style={{
                      padding: "5px 8px",
                      textAlign: "right",
                      color: "var(--ba-muted)",
                      fontSize: "0.72rem",
                    }}
                  >
                    Subtotal
                  </td>
                  <td
                    style={{
                      padding: "5px 8px",
                      textAlign: "right",
                      color: "var(--ba-fg)",
                      fontSize: "0.72rem",
                    }}
                  >
                    ${(subtotalCents / 100).toFixed(2)}
                  </td>
                </tr>
                {/* Named where Square names it ("GF Service Charge - 15%"), so staff can
                    match the row to the contract; falls back to one combined row. */}
                {orderCharges.length > 0
                  ? orderCharges.map((sc, i) => (
                      <tr key={sc.uid ?? `sc-${i}`}>
                        <td
                          colSpan={2}
                          style={{
                            padding: "2px 8px",
                            textAlign: "right",
                            color: "var(--ba-muted)",
                            fontSize: "0.72rem",
                          }}
                        >
                          {sc.name}
                        </td>
                        <td
                          style={{
                            padding: "2px 8px",
                            textAlign: "right",
                            color: "var(--ba-fg)",
                            fontSize: "0.72rem",
                          }}
                        >
                          ${(sc.amountCents / 100).toFixed(2)}
                        </td>
                      </tr>
                    ))
                  : serviceChargeCents > 0 && (
                      <tr>
                        <td
                          colSpan={2}
                          style={{
                            padding: "2px 8px",
                            textAlign: "right",
                            color: "var(--ba-muted)",
                            fontSize: "0.72rem",
                          }}
                        >
                          Service charge
                        </td>
                        <td
                          style={{
                            padding: "2px 8px",
                            textAlign: "right",
                            color: "var(--ba-fg)",
                            fontSize: "0.72rem",
                          }}
                        >
                          ${(serviceChargeCents / 100).toFixed(2)}
                        </td>
                      </tr>
                    )}
                {taxCents > 0 && (
                  <tr>
                    <td
                      colSpan={2}
                      style={{
                        padding: "2px 8px",
                        textAlign: "right",
                        color: "var(--ba-muted)",
                        fontSize: "0.72rem",
                      }}
                    >
                      Tax
                    </td>
                    <td
                      style={{
                        padding: "2px 8px",
                        textAlign: "right",
                        color: "var(--ba-muted)",
                        fontSize: "0.72rem",
                      }}
                    >
                      ${(taxCents / 100).toFixed(2)}
                    </td>
                  </tr>
                )}
                {discountCents > 0 && (
                  <tr>
                    <td
                      colSpan={2}
                      style={{
                        padding: "2px 8px",
                        textAlign: "right",
                        color: "#f59e0b",
                        fontSize: "0.72rem",
                      }}
                    >
                      Discount
                    </td>
                    <td
                      style={{
                        padding: "2px 8px",
                        textAlign: "right",
                        color: "#f59e0b",
                        fontSize: "0.72rem",
                      }}
                    >
                      −${(discountCents / 100).toFixed(2)}
                    </td>
                  </tr>
                )}
                <tr style={{ borderTop: "1px solid var(--ba-border)" }}>
                  <td
                    colSpan={2}
                    style={{
                      padding: "5px 8px",
                      textAlign: "right",
                      fontWeight: 700,
                      fontSize: "0.78rem",
                    }}
                  >
                    Total
                  </td>
                  <td
                    style={{
                      padding: "5px 8px",
                      textAlign: "right",
                      fontWeight: 700,
                      fontSize: "0.78rem",
                    }}
                  >
                    ${(totalCents / 100).toFixed(2)}
                  </td>
                </tr>
              </tfoot>
            </table>
          );
        })()}

      {orderItems && orderItems.length === 0 && (
        <p style={{ color: "var(--ba-muted)", fontSize: "0.8rem" }}>No line items</p>
      )}

      <div style={{ marginTop: 16, textAlign: "right" }}>
        <button
          type="button"
          onClick={onClose}
          style={{
            padding: "6px 16px",
            borderRadius: 6,
            fontSize: "0.75rem",
            background: "var(--ba-input-bg)",
            border: "1px solid var(--ba-input-border)",
            color: "var(--ba-fg)",
            cursor: "pointer",
            fontWeight: 600,
          }}
        >
          Close
        </button>
      </div>
    </ModalShell>
  );
}
