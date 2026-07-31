"use client";

/**
 * Mobile (<md) card list for the admin reservations board. Extracted verbatim
 * from app/admin/[token]/reservations/ReservationsClient.tsx; the Row-4
 * action buttons now come from the shared ActionButtons (layout="card").
 */
import type { ComboScheduleEntry } from "~/features/reservations-admin/combo-board";
import {
  KIND_BADGE,
  SOURCE_COLORS,
  SOURCE_LABELS,
  STATUS_COLORS,
  STATUS_LABELS,
} from "~/features/reservations-admin/constants";
import { clickableDivProps } from "@/lib/a11y";
import { centerShortOf, dollars, fmtClock, ganDisplay } from "~/features/reservations-admin/format";
import type { ComboMergeInfo, Reservation } from "~/features/reservations-admin/types";
import { comboAdminLabel } from "~/features/combos/combo-specials";
import ActionButtons from "./ActionButtons";
import { SurveyChip } from "./chips";
import type { ScheduleTarget } from "./modals/ComboScheduleModal";
import type { OrderTarget } from "./modals/SquareOrderModal";

type Row = Reservation & { comboMerge?: ComboMergeInfo };

export default function BoardCardList({
  rows,
  comboScheduleFor,
  actionMode = "full",
  onCheckIn,
  onReschedule,
  onResend,
  onCancel,
  onViewOrder,
  onViewSchedule,
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
  /** Card tap (anywhere except inner buttons/links) opens the manage modal. */
  onOpenReservation?: (r: Row) => void;
}) {
  return (
    <div className="md:hidden flex flex-col gap-1.5">
      {rows.map((r) => {
        const isCancelled = r.status === "cancelled";
        const centerShort = centerShortOf(r.centerCode);
        return (
          <div
            key={r.id}
            {...(onOpenReservation
              ? clickableDivProps(
                  (e) => {
                    if ((e.target as HTMLElement).closest("button, a, input")) return;
                    onOpenReservation(r);
                  },
                  `Manage reservation for ${r.guestName ?? "guest"}`,
                )
              : {})}
            style={{
              borderRadius: 8,
              border: r.comboSpecialId
                ? `1px solid ${KIND_BADGE.vip.border}`
                : "1px solid var(--ba-border)",
              borderLeft: r.comboSpecialId
                ? `4px solid ${KIND_BADGE.vip.color}`
                : "1px solid var(--ba-border)",
              backgroundColor: r.comboSpecialId ? KIND_BADGE.vip.bg : "var(--ba-bg2)",
              opacity: isCancelled ? 0.45 : 1,
              padding: "8px 10px",
              ...(onOpenReservation ? { cursor: "pointer" } : {}),
            }}
          >
            {/* Row 1: time · name · center ——— badges */}
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  minWidth: 0,
                  flex: 1,
                }}
              >
                <span
                  style={{
                    fontSize: "0.7rem",
                    fontWeight: 600,
                    color: "var(--ba-fg)",
                    whiteSpace: "nowrap",
                  }}
                >
                  {fmtClock(r.eventAt ?? r.bookedAt)}
                </span>
                <span
                  style={{
                    fontWeight: 700,
                    fontSize: "0.8rem",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {r.guestName ||
                    (r.bookingSource && r.bookingSource !== "web" ? (
                      <span
                        style={{
                          color: SOURCE_COLORS[r.bookingSource] ?? "var(--ba-muted)",
                        }}
                      >
                        {SOURCE_LABELS[r.bookingSource] ?? r.bookingSource}
                      </span>
                    ) : (
                      "—"
                    ))}
                </span>
                <span
                  style={{
                    fontSize: "0.55rem",
                    color: "var(--ba-muted)",
                    fontWeight: 500,
                    whiteSpace: "nowrap",
                  }}
                >
                  {centerShort}
                </span>
              </div>
              <div
                style={{
                  display: "flex",
                  gap: 3,
                  alignItems: "center",
                  flexShrink: 0,
                  marginLeft: 6,
                }}
              >
                <span
                  style={{
                    padding: "1px 5px",
                    borderRadius: 4,
                    fontSize: "0.6rem",
                    fontWeight: 600,
                    backgroundColor: `${STATUS_COLORS[r.status] ?? "#6b7280"}20`,
                    color: STATUS_COLORS[r.status] ?? "#6b7280",
                    border: `1px solid ${STATUS_COLORS[r.status] ?? "#6b7280"}40`,
                  }}
                >
                  {STATUS_LABELS[r.status] ?? r.status}
                </span>
                <SurveyChip survey={r.survey} />
                {r.checkinMethod === "self" ? (
                  <span
                    style={{
                      padding: "1px 4px",
                      borderRadius: 4,
                      fontSize: "0.55rem",
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
                      padding: "1px 4px",
                      borderRadius: 4,
                      fontSize: "0.55rem",
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
                      padding: "1px 4px",
                      borderRadius: 4,
                      fontSize: "0.55rem",
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
                      padding: "1px 4px",
                      borderRadius: 4,
                      fontSize: "0.55rem",
                      fontWeight: 600,
                      backgroundColor: "rgba(59,130,246,0.15)",
                      color: "#60a5fa",
                      border: "1px solid rgba(59,130,246,0.3)",
                    }}
                  >
                    SMS
                  </span>
                ) : null}
              </div>
            </div>

            {/* Row 2: phone · type · players · source · lane · payment */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                marginTop: 4,
                flexWrap: "wrap",
                fontSize: "0.68rem",
              }}
            >
              {r.guestPhone && <span style={{ color: "var(--ba-muted)" }}>{r.guestPhone}</span>}
              <span
                style={{
                  padding: "0px 4px",
                  borderRadius: 3,
                  fontSize: "0.6rem",
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: "0.02em",
                  backgroundColor: KIND_BADGE[r.productKind]?.bg ?? "rgba(59,130,246,0.15)",
                  color: KIND_BADGE[r.productKind]?.color ?? "#3b82f6",
                  border: `1px solid ${KIND_BADGE[r.productKind]?.border ?? "rgba(59,130,246,0.3)"}`,
                }}
              >
                {KIND_BADGE[r.productKind]?.label ?? r.productKind}
              </span>
              {r.comboSpecialId && (
                <span
                  style={{
                    padding: "0px 4px",
                    borderRadius: 3,
                    fontSize: "0.6rem",
                    fontWeight: 700,
                    textTransform: "uppercase",
                    letterSpacing: "0.02em",
                    backgroundColor: KIND_BADGE.vip.bg,
                    color: KIND_BADGE.vip.color,
                    border: `1px solid ${KIND_BADGE.vip.border}`,
                  }}
                  title={`Part of an Ultimate ${comboAdminLabel(r.comboSpecialId)} combo`}
                >
                  ★ {comboAdminLabel(r.comboSpecialId)}
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
                        padding: "0px 5px",
                        borderRadius: 3,
                        fontSize: "0.6rem",
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
              <span style={{ color: "var(--ba-muted)", fontSize: "0.65rem" }}>
                {r.playerCount ?? "—"}p
              </span>
              {r.bookingSource && r.bookingSource !== "web" && (
                <span
                  style={{
                    padding: "0px 3px",
                    borderRadius: 3,
                    fontSize: "0.5rem",
                    fontWeight: 600,
                    textTransform: "uppercase",
                    backgroundColor: `${SOURCE_COLORS[r.bookingSource] ?? "#6b7280"}20`,
                    color: SOURCE_COLORS[r.bookingSource] ?? "#6b7280",
                    border: `1px solid ${SOURCE_COLORS[r.bookingSource] ?? "#6b7280"}40`,
                  }}
                >
                  {SOURCE_LABELS[r.bookingSource] ?? r.bookingSource}
                </span>
              )}
              {r.dayofOrderLane && (
                <span style={{ color: "#22c55e", fontWeight: 700, fontSize: "0.7rem" }}>
                  L{r.dayofOrderLane}
                </span>
              )}
              <span style={{ marginLeft: "auto" }}>
                {r.depositCents > 0 ? (
                  <>
                    <span style={{ color: "#22c55e", fontWeight: 600, fontSize: "0.7rem" }}>
                      {dollars(r.comboMerge?.totalCents ?? r.depositCents)}
                    </span>
                    <span
                      style={{
                        color: "var(--ba-muted)",
                        margin: "0 1px",
                        fontSize: "0.6rem",
                      }}
                    >
                      /
                    </span>
                    <span style={{ color: "var(--ba-muted)", fontSize: "0.6rem" }}>
                      {dollars(r.comboMerge?.totalCents ?? r.totalCents)}
                    </span>
                  </>
                ) : r.bookingSource && r.bookingSource !== "web" ? (
                  <span style={{ color: "var(--ba-muted)", fontSize: "0.6rem" }}>Walk-in</span>
                ) : (
                  <span style={{ color: "var(--ba-muted)", fontSize: "0.6rem" }}>Free</span>
                )}
                {r.refundCents > 0 && (
                  <span
                    style={{
                      color: "#ef4444",
                      fontSize: "0.6rem",
                      fontWeight: 600,
                      marginLeft: 4,
                    }}
                    title={`Refunded to card${r.cancelledBy ? ` (${r.cancelledBy})` : ""}`}
                  >
                    -{dollars(r.refundCents)}
                  </span>
                )}
                {r.storeCreditGiftCardGan && (r.storeCreditCents ?? 0) > 0 && (
                  <span
                    style={{
                      color: "#22c55e",
                      fontSize: "0.6rem",
                      fontWeight: 600,
                      marginLeft: 4,
                      fontFamily: "monospace",
                    }}
                    title={`HeadPinz FastTrax Gift Card issued${r.cancelledBy ? ` (${r.cancelledBy})` : ""} — guest rebooks with it`}
                  >
                    GC {ganDisplay(r.storeCreditGiftCardGan)} ({dollars(r.storeCreditCents ?? 0)})
                  </span>
                )}
              </span>
            </div>

            {/* Row 3 (optional): rewards + coupon + square */}
            {(r.loyaltyAction ||
              r.rewardDiscountCents > 0 ||
              r.promoSavingsCents > 0 ||
              r.squareDayofOrderId) && (
              <div style={{ display: "flex", gap: 4, alignItems: "center", marginTop: 4 }}>
                {r.loyaltyAction === "signup" && (
                  <span
                    style={{
                      padding: "0px 3px",
                      borderRadius: 3,
                      fontSize: "0.5rem",
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
                      padding: "0px 3px",
                      borderRadius: 3,
                      fontSize: "0.5rem",
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
                      padding: "0px 3px",
                      borderRadius: 3,
                      fontSize: "0.5rem",
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
                      padding: "0px 3px",
                      borderRadius: 3,
                      fontSize: "0.5rem",
                      fontWeight: 600,
                      backgroundColor: "rgba(168,85,247,0.15)",
                      color: "#c084fc",
                      border: "1px solid rgba(168,85,247,0.3)",
                    }}
                  >
                    {r.promoCode} −${(r.promoSavingsCents / 100).toFixed(0)}
                  </span>
                )}
                {r.squareDayofOrderId && (
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
                      marginLeft: "auto",
                    }}
                  >
                    <span
                      style={{
                        padding: "0px 4px",
                        borderRadius: 3,
                        fontSize: "0.5rem",
                        fontWeight: 600,
                        backgroundColor: r.dayofOrderError
                          ? "rgba(239,68,68,0.15)"
                          : r.dayofOrderSentAt
                            ? "rgba(34,197,94,0.15)"
                            : "rgba(107,114,128,0.1)",
                        color: r.dayofOrderError
                          ? "#ef4444"
                          : r.dayofOrderSentAt
                            ? "#22c55e"
                            : "var(--ba-muted)",
                        border: `1px solid ${r.dayofOrderError ? "rgba(239,68,68,0.3)" : r.dayofOrderSentAt ? "rgba(34,197,94,0.3)" : "var(--ba-border)"}`,
                      }}
                    >
                      {r.dayofOrderError ? "SQ ERR" : r.dayofOrderSentAt ? "SQ Sent" : "SQ Pending"}
                    </span>
                  </button>
                )}
              </div>
            )}

            {/* Row 4: action buttons */}
            {!isCancelled && r.status !== "completed" && (
              <ActionButtons
                reservation={r}
                layout="card"
                mode={actionMode}
                onCheckIn={onCheckIn}
                onReschedule={onReschedule}
                onResend={onResend}
                onCancel={onCancel}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
