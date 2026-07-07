"use client";

/**
 * Desktop (md+) 12-column table for the admin reservations board. Extracted
 * verbatim from app/admin/[token]/reservations/ReservationsClient.tsx; the
 * Actions cell now comes from the shared ActionButtons (layout="table").
 */
import type { ComboScheduleEntry } from "~/features/reservations-admin/combo-board";
import {
  FOOD_RE,
  KIND_BADGE,
  SOURCE_COLORS,
  SOURCE_LABELS,
  STATUS_COLORS,
  STATUS_LABELS,
} from "~/features/reservations-admin/constants";
import { clickableDivProps } from "@/lib/a11y";
import {
  centerShortOf,
  dayofSourceLabel,
  dollars,
  fmtClock,
  ganDisplay,
} from "~/features/reservations-admin/format";
import type { ComboMergeInfo, Reservation } from "~/features/reservations-admin/types";
import ActionButtons from "./ActionButtons";
import { SurveyChip } from "./chips";
import type { ContactTarget } from "./modals/ContactModal";
import type { ScheduleTarget } from "./modals/ComboScheduleModal";
import type { OrderTarget } from "./modals/SquareOrderModal";

type Row = Reservation & { comboMerge?: ComboMergeInfo };

export default function BoardTable({
  rows,
  comboScheduleFor,
  actionMode = "full",
  onCheckIn,
  onReschedule,
  onResend,
  onCancel,
  onViewOrder,
  onViewSchedule,
  onOpenContact,
  onOpenReservation,
}: {
  rows: Row[];
  comboScheduleFor: (r: Reservation) => ComboScheduleEntry | undefined;
  actionMode?: "full" | "checkin-only";
  onCheckIn: (r: Row) => void;
  onReschedule: (r: Row) => void;
  onResend: (r: Row) => void;
  onCancel: (r: Row) => void;
  onViewOrder: (target: OrderTarget) => void;
  onViewSchedule: (target: ScheduleTarget) => void;
  onOpenContact: (target: ContactTarget) => void;
  /** Row click (anywhere except inner buttons/links) opens the manage modal. */
  onOpenReservation?: (r: Row) => void;
}) {
  return (
    <div className="hidden md:block" style={{ overflowX: "auto" }}>
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          fontSize: "0.78rem",
        }}
      >
        <thead>
          <tr
            style={{
              borderBottom: "1px solid var(--ba-border)",
              textAlign: "left",
            }}
          >
            {[
              "Time",
              "Guest",
              "Type",
              "Status",
              "Check-in",
              "Rewards",
              "Lane",
              "Order",
              "Square",
              "Payment",
              "Ref",
              "Actions",
            ].map((h) => (
              <th
                key={h}
                style={{
                  padding: "0.5rem 0.4rem",
                  color: "var(--ba-muted)",
                  fontWeight: 600,
                  fontSize: "0.65rem",
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                  whiteSpace: "nowrap",
                }}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const isCancelled = r.status === "cancelled";
            const rowOpacity = isCancelled ? 0.45 : 1;
            const centerShort = centerShortOf(r.centerCode);
            return (
              <tr
                key={r.id}
                {...(onOpenReservation
                  ? clickableDivProps(
                      (e) => {
                        // Inner buttons/links keep their own behavior.
                        if ((e.target as HTMLElement).closest("button, a, input")) return;
                        onOpenReservation(r);
                      },
                      `Manage reservation for ${r.guestName ?? "guest"}`,
                    )
                  : {})}
                style={{
                  borderBottom: "1px solid var(--ba-border)",
                  opacity: rowOpacity,
                  backgroundColor: r.comboSpecialId ? KIND_BADGE.vip.bg : undefined,
                  boxShadow: r.comboSpecialId ? `inset 3px 0 0 ${KIND_BADGE.vip.color}` : undefined,
                  ...(onOpenReservation ? { cursor: "pointer" } : {}),
                }}
              >
                {/* Time */}
                <td style={{ padding: "0.5rem 0.4rem", whiteSpace: "nowrap" }}>
                  {fmtClock(r.eventAt ?? r.bookedAt)}
                </td>

                {/* Guest — name, phone, center tag */}
                <td style={{ padding: "0.5rem 0.4rem" }}>
                  <div
                    style={{
                      fontWeight: 600,
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                    }}
                  >
                    {r.guestName ? (
                      <button
                        type="button"
                        onClick={() =>
                          onOpenContact({
                            name: r.guestName!,
                            phone: r.guestPhone,
                            email: r.guestEmail,
                          })
                        }
                        style={{
                          background: "none",
                          border: "none",
                          padding: 0,
                          cursor: "pointer",
                          fontWeight: 600,
                          color: "var(--ba-fg)",
                          textAlign: "left",
                          textDecoration: "underline",
                          textDecorationColor: "var(--ba-border)",
                          textUnderlineOffset: 2,
                        }}
                        title="View phone / email"
                      >
                        {r.guestName}
                      </button>
                    ) : r.bookingSource && r.bookingSource !== "web" ? (
                      <span
                        style={{
                          color: SOURCE_COLORS[r.bookingSource] ?? "var(--ba-muted)",
                        }}
                      >
                        {SOURCE_LABELS[r.bookingSource] ?? r.bookingSource}
                      </span>
                    ) : (
                      "—"
                    )}
                    <span
                      style={{
                        fontSize: "0.6rem",
                        color: "var(--ba-muted)",
                        fontWeight: 500,
                      }}
                    >
                      {centerShort}
                    </span>
                  </div>
                  {r.survey && (
                    <div style={{ marginTop: 3 }}>
                      <SurveyChip survey={r.survey} />
                    </div>
                  )}
                </td>

                {/* Type — badge + player count + source */}
                <td style={{ padding: "0.5rem 0.4rem", whiteSpace: "nowrap" }}>
                  <span
                    style={{
                      display: "inline-block",
                      padding: "0.1rem 0.4rem",
                      borderRadius: 5,
                      fontSize: "0.65rem",
                      fontWeight: 600,
                      textTransform: "uppercase",
                      letterSpacing: "0.03em",
                      backgroundColor:
                        r.productKind === "kbf" ? "rgba(168,85,247,0.15)" : "rgba(59,130,246,0.15)",
                      color: r.productKind === "kbf" ? "#a855f7" : "#3b82f6",
                      border: `1px solid ${
                        r.productKind === "kbf" ? "rgba(168,85,247,0.3)" : "rgba(59,130,246,0.3)"
                      }`,
                    }}
                  >
                    {r.productKind === "kbf" ? "KBF" : "Open"}
                  </span>
                  {r.comboSpecialId && (
                    <span
                      style={{
                        marginLeft: 5,
                        padding: "1px 5px",
                        borderRadius: 4,
                        fontSize: "0.62rem",
                        fontWeight: 700,
                        textTransform: "uppercase",
                        backgroundColor: KIND_BADGE.vip.bg,
                        color: KIND_BADGE.vip.color,
                        border: `1px solid ${KIND_BADGE.vip.border}`,
                      }}
                      title="Part of an Ultimate VIP combo"
                    >
                      ★ VIP
                    </span>
                  )}
                  {r.comboSpecialId &&
                    (() => {
                      const c = comboScheduleFor(r);
                      return c ? (
                        <button
                          type="button"
                          onClick={() =>
                            onViewSchedule({
                              guestName: r.guestName ?? "Guest",
                              name: c.name,
                              accent: c.accent,
                              centerCode: c.centerCode,
                              schedule: c.schedule,
                            })
                          }
                          style={{
                            marginLeft: 5,
                            padding: "1px 6px",
                            borderRadius: 4,
                            fontSize: "0.62rem",
                            fontWeight: 700,
                            cursor: "pointer",
                            backgroundColor: "transparent",
                            color: KIND_BADGE.vip.color,
                            border: `1px solid ${KIND_BADGE.vip.border}`,
                          }}
                          title="View the VIP itinerary"
                        >
                          📅 Schedule
                        </button>
                      ) : null;
                    })()}
                  <span style={{ marginLeft: 5, color: "var(--ba-muted)", fontSize: "0.68rem" }}>
                    {r.playerCount ?? "—"}p
                  </span>
                  {r.bookingSource && r.bookingSource !== "web" && (
                    <span
                      style={{
                        display: "inline-block",
                        marginLeft: 5,
                        padding: "0.05rem 0.3rem",
                        borderRadius: 4,
                        fontSize: "0.55rem",
                        fontWeight: 600,
                        textTransform: "uppercase",
                        letterSpacing: "0.03em",
                        backgroundColor: `${SOURCE_COLORS[r.bookingSource] ?? "#6b7280"}20`,
                        color: SOURCE_COLORS[r.bookingSource] ?? "#6b7280",
                        border: `1px solid ${SOURCE_COLORS[r.bookingSource] ?? "#6b7280"}40`,
                      }}
                    >
                      {SOURCE_LABELS[r.bookingSource] ?? r.bookingSource}
                    </span>
                  )}
                </td>

                {/* Status */}
                <td style={{ padding: "0.5rem 0.4rem", whiteSpace: "nowrap" }}>
                  <span
                    style={{
                      display: "inline-block",
                      padding: "0.1rem 0.4rem",
                      borderRadius: 5,
                      fontSize: "0.65rem",
                      fontWeight: 600,
                      backgroundColor: `${STATUS_COLORS[r.status] ?? "#6b7280"}20`,
                      color: STATUS_COLORS[r.status] ?? "#6b7280",
                      border: `1px solid ${STATUS_COLORS[r.status] ?? "#6b7280"}40`,
                    }}
                  >
                    {STATUS_LABELS[r.status] ?? r.status}
                  </span>
                </td>

                {/* Check-in */}
                <td style={{ padding: "0.5rem 0.4rem", whiteSpace: "nowrap" }}>
                  {r.checkinMethod === "self" ? (
                    <span
                      style={{
                        display: "inline-block",
                        padding: "0.1rem 0.35rem",
                        borderRadius: 5,
                        fontSize: "0.6rem",
                        fontWeight: 600,
                        backgroundColor: "rgba(168,85,247,0.15)",
                        color: "#a855f7",
                        border: "1px solid rgba(168,85,247,0.3)",
                      }}
                    >
                      Self
                    </span>
                  ) : r.checkinMethod === "desk" ? (
                    <span
                      style={{
                        display: "inline-block",
                        padding: "0.1rem 0.35rem",
                        borderRadius: 5,
                        fontSize: "0.6rem",
                        fontWeight: 600,
                        backgroundColor: "rgba(20,184,166,0.15)",
                        color: "#14b8a6",
                        border: "1px solid rgba(20,184,166,0.3)",
                      }}
                    >
                      Admin
                    </span>
                  ) : r.checkinMethod ? (
                    <span
                      style={{
                        display: "inline-block",
                        padding: "0.1rem 0.35rem",
                        borderRadius: 5,
                        fontSize: "0.6rem",
                        fontWeight: 600,
                        backgroundColor: "rgba(107,114,128,0.15)",
                        color: "#9ca3af",
                        border: "1px solid rgba(107,114,128,0.3)",
                      }}
                    >
                      {r.checkinMethod}
                    </span>
                  ) : r.preArrivalSentAt ? (
                    <span
                      style={{
                        display: "inline-block",
                        padding: "0.1rem 0.35rem",
                        borderRadius: 5,
                        fontSize: "0.6rem",
                        fontWeight: 600,
                        backgroundColor: "rgba(59,130,246,0.15)",
                        color: "#60a5fa",
                        border: "1px solid rgba(59,130,246,0.3)",
                      }}
                    >
                      SMS Sent
                    </span>
                  ) : (
                    <span style={{ color: "var(--ba-muted2)", fontSize: "0.6rem" }}>—</span>
                  )}
                </td>

                {/* Rewards */}
                <td style={{ padding: "0.5rem 0.4rem", whiteSpace: "nowrap" }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                    {r.loyaltyAction === "signup" && (
                      <span
                        style={{
                          display: "inline-block",
                          padding: "0.1rem 0.3rem",
                          borderRadius: 4,
                          fontSize: "0.55rem",
                          fontWeight: 600,
                          backgroundColor: "rgba(34,197,94,0.15)",
                          color: "#22c55e",
                          border: "1px solid rgba(34,197,94,0.3)",
                        }}
                      >
                        New
                      </span>
                    )}
                    {r.loyaltyAction === "existing" && (
                      <span
                        style={{
                          display: "inline-block",
                          padding: "0.1rem 0.3rem",
                          borderRadius: 4,
                          fontSize: "0.55rem",
                          fontWeight: 600,
                          backgroundColor: "rgba(59,130,246,0.15)",
                          color: "#60a5fa",
                          border: "1px solid rgba(59,130,246,0.3)",
                        }}
                      >
                        Member
                      </span>
                    )}
                    {r.rewardDiscountCents > 0 && (
                      <span
                        style={{
                          display: "inline-block",
                          padding: "0.1rem 0.3rem",
                          borderRadius: 4,
                          fontSize: "0.55rem",
                          fontWeight: 600,
                          backgroundColor: "rgba(245,158,11,0.15)",
                          color: "#f59e0b",
                          border: "1px solid rgba(245,158,11,0.3)",
                        }}
                      >
                        −${(r.rewardDiscountCents / 100).toFixed(0)}
                      </span>
                    )}
                    {r.promoCode && r.promoSavingsCents > 0 && (
                      <span
                        title={`Coupon ${r.promoCode} — saved $${(r.promoSavingsCents / 100).toFixed(2)}`}
                        style={{
                          display: "inline-block",
                          padding: "0.1rem 0.3rem",
                          borderRadius: 4,
                          fontSize: "0.55rem",
                          fontWeight: 600,
                          backgroundColor: "rgba(168,85,247,0.15)",
                          color: "#c084fc",
                          border: "1px solid rgba(168,85,247,0.3)",
                        }}
                      >
                        {r.promoCode} −${(r.promoSavingsCents / 100).toFixed(0)}
                      </span>
                    )}
                    {!r.loyaltyAction &&
                      r.rewardDiscountCents === 0 &&
                      r.promoSavingsCents === 0 && (
                        <span style={{ color: "var(--ba-muted2)", fontSize: "0.6rem" }}>—</span>
                      )}
                  </div>
                </td>

                {/* Lane */}
                <td
                  style={{
                    padding: "0.5rem 0.4rem",
                    textAlign: "center",
                    fontWeight: r.dayofOrderLane ? 700 : 400,
                    color: r.dayofOrderLane ? "#22c55e" : "var(--ba-muted2)",
                    fontSize: "0.75rem",
                  }}
                >
                  {r.dayofOrderLane ?? "—"}
                </td>

                {/* Order — food items from lines */}
                <td style={{ padding: "0.5rem 0.4rem" }}>
                  {(() => {
                    const food = r.lines.filter((l) => FOOD_RE.test(l.label));
                    if (!food.length) return <span style={{ color: "var(--ba-muted2)" }}>—</span>;
                    return food.map((f, i) => {
                      const short = f.label
                        .replace(/^VIP\s+/i, "")
                        .replace(/Pizza Bowl /i, "PB ")
                        .replace(/Soda Pitcher/i, "Soda")
                        .replace(/Chips & Salsa/i, "C&S");
                      return (
                        <div
                          key={i}
                          style={{
                            fontSize: "0.62rem",
                            color: "var(--ba-muted)",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {short}
                          {f.quantity > 1 ? ` ×${f.quantity}` : ""}
                        </div>
                      );
                    });
                  })()}
                </td>

                {/* Square — order sent status (clickable to view line items) */}
                <td style={{ padding: "0.5rem 0.4rem", whiteSpace: "nowrap" }}>
                  {r.comboMerge ? (
                    // A combo has two day-of orders — one button each so both
                    // are reachable from the main list (not just the VIP filter).
                    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                      {r.comboMerge.orders.map((o) => (
                        <button
                          key={o.orderId}
                          type="button"
                          onClick={() =>
                            onViewOrder({
                              guestName: r.guestName || "Guest",
                              squareDayofOrderId: o.orderId,
                              rewardDiscountCents: o.leg.rewardDiscountCents,
                              squareLoyaltyRewardId: o.leg.squareLoyaltyRewardId,
                              promoCode: o.leg.promoCode ?? null,
                              promoSavingsCents: o.leg.promoSavingsCents,
                            })
                          }
                          style={{
                            background: "none",
                            border: "1px solid var(--ba-border)",
                            borderRadius: 5,
                            cursor: "pointer",
                            padding: "1px 6px",
                            fontSize: "0.6rem",
                            fontWeight: 600,
                            color: KIND_BADGE.vip.color,
                            textAlign: "left",
                          }}
                          title={`View ${o.kind} order`}
                        >
                          {o.kind}
                        </button>
                      ))}
                    </div>
                  ) : r.squareDayofOrderId ? (
                    <button
                      type="button"
                      onClick={() =>
                        onViewOrder({
                          guestName: r.guestName || "Guest",
                          squareDayofOrderId: r.squareDayofOrderId ?? null,
                          rewardDiscountCents: r.rewardDiscountCents,
                          squareLoyaltyRewardId: r.squareLoyaltyRewardId,
                          promoCode: r.promoCode ?? null,
                          promoSavingsCents: r.promoSavingsCents,
                        })
                      }
                      style={{
                        background: "none",
                        border: "none",
                        cursor: "pointer",
                        padding: 0,
                        textAlign: "left",
                      }}
                      title="View Square order items"
                    >
                      {r.dayofOrderSentAt ? (
                        <div>
                          <span
                            style={{
                              display: "inline-block",
                              padding: "0.1rem 0.35rem",
                              borderRadius: 5,
                              fontSize: "0.6rem",
                              fontWeight: 600,
                              backgroundColor: r.dayofOrderError
                                ? "rgba(239,68,68,0.15)"
                                : "rgba(34,197,94,0.15)",
                              color: r.dayofOrderError ? "#ef4444" : "#22c55e",
                              border: `1px solid ${r.dayofOrderError ? "rgba(239,68,68,0.3)" : "rgba(34,197,94,0.3)"}`,
                            }}
                          >
                            {r.dayofOrderError ? "ERR" : "Sent"}
                          </span>
                          {r.dayofOrderSource && (
                            <span
                              style={{
                                display: "inline-block",
                                marginLeft: 3,
                                padding: "0.05rem 0.25rem",
                                borderRadius: 3,
                                fontSize: "0.5rem",
                                fontWeight: 500,
                                backgroundColor:
                                  r.dayofOrderSource === "webhook"
                                    ? "rgba(99,102,241,0.15)"
                                    : "var(--ba-input-bg)",
                                color:
                                  r.dayofOrderSource === "webhook" ? "#818cf8" : "var(--ba-muted)",
                                border: `1px solid ${r.dayofOrderSource === "webhook" ? "rgba(99,102,241,0.3)" : "var(--ba-border)"}`,
                                textTransform: "uppercase",
                                letterSpacing: "0.5px",
                              }}
                              title={r.dayofOrderSource}
                            >
                              {dayofSourceLabel(r.dayofOrderSource)}
                            </span>
                          )}
                          {r.dayofOrderError && (
                            <div
                              style={{
                                fontSize: "0.55rem",
                                color: "#ef4444",
                                marginTop: 1,
                                maxWidth: 90,
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                              }}
                              title={r.dayofOrderError}
                            >
                              {r.dayofOrderError}
                            </div>
                          )}
                        </div>
                      ) : (
                        <span
                          style={{
                            color: "var(--ba-muted)",
                            fontSize: "0.6rem",
                            textDecoration: "underline",
                            textDecorationColor: "var(--ba-border)",
                          }}
                        >
                          Pending
                        </span>
                      )}
                    </button>
                  ) : (
                    <span style={{ color: "var(--ba-muted2)" }}>—</span>
                  )}
                </td>

                {/* Payment — deposit / total merged */}
                <td style={{ padding: "0.5rem 0.4rem", whiteSpace: "nowrap" }}>
                  {r.depositCents > 0 ? (
                    <>
                      <span style={{ color: "#22c55e", fontWeight: 600 }}>
                        {dollars(r.comboMerge?.totalCents ?? r.depositCents)}
                      </span>
                      <span style={{ color: "var(--ba-muted)", margin: "0 2px" }}>/</span>
                      <span style={{ color: "var(--ba-muted)" }}>
                        {dollars(r.comboMerge?.totalCents ?? r.totalCents)}
                      </span>
                    </>
                  ) : r.bookingSource && r.bookingSource !== "web" ? (
                    <span
                      style={{
                        display: "inline-block",
                        padding: "0.1rem 0.35rem",
                        borderRadius: 5,
                        fontSize: "0.6rem",
                        fontWeight: 600,
                        backgroundColor: `${SOURCE_COLORS[r.bookingSource] ?? "#6b7280"}20`,
                        color: SOURCE_COLORS[r.bookingSource] ?? "#6b7280",
                        border: `1px solid ${SOURCE_COLORS[r.bookingSource] ?? "#6b7280"}40`,
                      }}
                    >
                      {SOURCE_LABELS[r.bookingSource] ?? r.bookingSource}
                    </span>
                  ) : (
                    <span style={{ color: "var(--ba-muted)" }}>Free</span>
                  )}
                  {r.refundCents > 0 && (
                    <div
                      style={{ color: "#ef4444", fontSize: "0.6rem" }}
                      title={`Refunded to card${r.cancelledBy ? ` (${r.cancelledBy})` : ""}`}
                    >
                      -{dollars(r.refundCents)}
                    </div>
                  )}
                  {r.storeCreditGiftCardGan && (r.storeCreditCents ?? 0) > 0 && (
                    <div
                      style={{
                        color: "#22c55e",
                        fontSize: "0.6rem",
                        fontFamily: "monospace",
                      }}
                      title={`HeadPinz FastTrax Gift Card issued${r.cancelledBy ? ` (${r.cancelledBy})` : ""} — guest rebooks with it`}
                    >
                      GC {ganDisplay(r.storeCreditGiftCardGan)} ({dollars(r.storeCreditCents ?? 0)})
                    </div>
                  )}
                </td>

                {/* Ref — QAMF ID */}
                <td style={{ padding: "0.5rem 0.4rem", whiteSpace: "nowrap" }}>
                  <span
                    style={{
                      fontFamily: "monospace",
                      fontSize: "0.65rem",
                      color: "var(--ba-muted)",
                    }}
                  >
                    {r.qamfReservationId ?? `#${r.id}`}
                  </span>
                </td>

                {/* Actions — check-in, resched, view, resend, cancel */}
                <td style={{ padding: "0.5rem 0.4rem", whiteSpace: "nowrap" }}>
                  <ActionButtons
                    reservation={r}
                    layout="table"
                    mode={actionMode}
                    onCheckIn={onCheckIn}
                    onReschedule={onReschedule}
                    onResend={onResend}
                    onCancel={onCancel}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
