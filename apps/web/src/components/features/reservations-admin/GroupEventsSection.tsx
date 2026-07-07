"use client";

/**
 * Group-function event rows on the admin reservations board — horizontal
 * columns (when · event · money · meta · actions). Extracted verbatim from
 * app/admin/[token]/reservations/ReservationsClient.tsx.
 */
import type { GroupEvent } from "~/features/reservations-admin/types";
import type { OrderTarget } from "./modals/SquareOrderModal";

export default function GroupEventsSection({
  events,
  onViewOrder,
}: {
  events: GroupEvent[];
  onViewOrder: (target: OrderTarget) => void;
}) {
  if (events.length === 0) return null;
  return (
    <div style={{ marginBottom: 16 }}>
      <div
        style={{
          fontSize: 13,
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: 1,
          color: "#22d3ee",
          marginBottom: 8,
        }}
      >
        Group Events ({events.length})
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {events.map((ge) => {
          const statusColors: Record<string, string> = {
            contract_sent: "#f59e0b",
            deposit_paid: "#22c55e",
            balance_charged: "#22d3ee",
            completed: "#22d3ee",
            resign_required: "#ef4444",
            cancelled: "#ef4444",
          };
          const sColor = statusColors[ge.status] || "#94a3b8";
          const fmtD = (c: number) => `$${(c / 100).toFixed(2)}`;
          return (
            <div
              key={ge.id}
              style={{
                borderRadius: 8,
                border: `1px solid ${sColor}33`,
                backgroundColor: "var(--ba-bg2)",
                padding: "8px 14px",
                display: "flex",
                alignItems: "center",
                gap: 16,
                flexWrap: "wrap",
              }}
            >
              {/* Horizontal columns — spread across the width instead of
                  stacking vertically: when · event · money · meta · actions. */}

              {/* When + status */}
              <div
                style={{
                  minWidth: 116,
                  display: "flex",
                  flexDirection: "column",
                  gap: 1,
                  fontSize: 12,
                }}
              >
                <span style={{ fontWeight: 700, color: "var(--ba-fg)" }}>
                  {ge.eventDateDisplay}
                </span>
                <span
                  style={{
                    fontSize: 10,
                    fontWeight: 600,
                    color: sColor,
                    textTransform: "uppercase",
                  }}
                >
                  {ge.status.replace(/_/g, " ")}
                </span>
              </div>

              {/* Event identity — name, #num, guest · phone · guests · planner */}
              <div
                style={{
                  flex: "2 1 220px",
                  minWidth: 0,
                  display: "flex",
                  flexDirection: "column",
                  gap: 1,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "baseline",
                    gap: 8,
                    flexWrap: "wrap",
                  }}
                >
                  <span style={{ fontWeight: 700, fontSize: 14 }}>{ge.eventName}</span>
                  <span style={{ fontSize: 11, color: "var(--ba-muted)" }}>#{ge.eventNumber}</span>
                </div>
                <div
                  style={{
                    fontSize: 12,
                    color: "var(--ba-muted)",
                    display: "flex",
                    gap: "2px 10px",
                    flexWrap: "wrap",
                  }}
                >
                  <span>{ge.guestName}</span>
                  {ge.guestPhone && <span>{ge.guestPhone}</span>}
                  {ge.guestCount && <span>{ge.guestCount} guests</span>}
                  {ge.plannerName && <span>· {ge.plannerName}</span>}
                </div>
              </div>

              {/* Money — total prominent, deposit/balance beneath */}
              <div
                style={{
                  flex: "1 1 190px",
                  display: "flex",
                  flexDirection: "column",
                  gap: 1,
                  fontSize: 12,
                }}
              >
                <span style={{ fontWeight: 700 }}>Total: {fmtD(ge.totalCents)}</span>
                <span style={{ display: "flex", gap: "2px 10px", flexWrap: "wrap" }}>
                  <span style={{ color: ge.depositPaidAt ? "#22c55e" : "#94a3b8" }}>
                    Dep {fmtD(ge.depositDueCents)}
                    {ge.depositPaidAt ? " ✓" : ""}
                  </span>
                  <span
                    style={{
                      color:
                        ge.balanceCents > 0 && !ge.balancePaidAt
                          ? "#f59e0b"
                          : ge.balancePaidAt
                            ? "#22c55e"
                            : undefined,
                    }}
                  >
                    Bal {fmtD(ge.balanceCents)}
                    {ge.balancePaidAt ? " ✓" : ge.balanceCents > 0 ? " due" : ""}
                  </span>
                </span>
              </div>

              {/* Meta — GAN, card-on-file */}
              <div
                style={{
                  flex: "1 1 150px",
                  display: "flex",
                  flexDirection: "column",
                  gap: 1,
                  fontSize: 11,
                  color: "var(--ba-muted)",
                }}
              >
                {ge.squareGiftCardGan && (
                  <span>
                    GAN:{" "}
                    {(() => {
                      try {
                        const g = JSON.parse(ge.squareGiftCardGan);
                        return Array.isArray(g) ? g.join(", ") : ge.squareGiftCardGan;
                      } catch {
                        return ge.squareGiftCardGan;
                      }
                    })()}
                  </span>
                )}
                {ge.savedCardId && <span style={{ color: "#22c55e" }}>Card on file</span>}
                {!ge.savedCardId && ge.depositPaidAt && (
                  <span style={{ color: "#f59e0b" }}>No card saved</span>
                )}
              </div>

              {/* Actions — right edge */}
              {(ge.contractShortId || ge.squareDayofOrderId) && (
                <span
                  style={{
                    marginLeft: "auto",
                    display: "flex",
                    gap: 12,
                    flexShrink: 0,
                  }}
                >
                  {ge.contractShortId && (
                    <a
                      href={`/contract/${ge.contractShortId}`}
                      target="_blank"
                      rel="noopener"
                      style={{
                        fontSize: 11,
                        color: "#22d3ee",
                        textDecoration: "none",
                        fontWeight: 600,
                      }}
                    >
                      View Contract
                    </a>
                  )}
                  {ge.squareDayofOrderId && (
                    <button
                      type="button"
                      onClick={() =>
                        onViewOrder({
                          guestName: ge.eventName,
                          squareDayofOrderId: ge.squareDayofOrderId,
                          rewardDiscountCents: 0,
                        })
                      }
                      style={{
                        background: "none",
                        border: "none",
                        cursor: "pointer",
                        padding: 0,
                        fontSize: 11,
                        color: "#22d3ee",
                        fontWeight: 600,
                        textDecoration: "underline",
                        textDecorationColor: "rgba(34,211,238,0.3)",
                      }}
                    >
                      View Square Order
                    </button>
                  )}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
