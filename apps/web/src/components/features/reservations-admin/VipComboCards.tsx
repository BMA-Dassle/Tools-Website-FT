"use client";

/**
 * VIP combo card view — one gold card per combo with the live itinerary
 * (Done / In-progress / countdown / not-arrived / up-next markers), per-leg
 * status chips, Cancel Combo and per-order buttons. Extracted verbatim from
 * app/admin/[token]/reservations/ReservationsClient.tsx.
 *
 * `nowMs` comes from the parent per render (the 10s silent auto-refresh and
 * the 30s heartbeat keep the "left"/"in" countdowns current) — do NOT wrap
 * this component in React.memo or the pills freeze.
 */
import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { clickableDivProps } from "@/lib/a11y";
import { formatVoucherCode } from "~/features/game-cards/vouchers/codes";
import { cancelActionable } from "~/features/reservations-admin/actionable";
import { stepProgress, type ComboGroup } from "~/features/reservations-admin/combo-board";
import { etWallMs } from "~/features/reservations-admin/format";
import {
  KIND_BADGE,
  KIND_FULL_LABELS,
  STATUS_COLORS,
  STATUS_LABELS,
} from "~/features/reservations-admin/constants";
import { centerLabel, dollars, fmtClock, fmtDurShort } from "~/features/reservations-admin/format";
import type { Reservation } from "~/features/reservations-admin/types";
import type { OrderTarget } from "./modals/SquareOrderModal";
import { NAV_BTN } from "./theme";

/** Change-bowl-time cutoff: the shift is allowed until 5 min before the
 *  booked bowling start (owner rule, 7/10). Server enforces the same. */
const TIME_SHIFT_CUTOFF_MS = 5 * 60_000;

/** Ultimate VIP only (owner 7/10): bowling leg still confirmed (lane not
 *  open), QAMF-linked, and not within 5 min of its start. Any race-bowl*
 *  pack (v1 or the 7/31 V2) qualifies — same lane-shift mechanics. */
function timeShiftLeg(g: ComboGroup, nowMs: number): Reservation | null {
  if (!g.comboId.startsWith("race-bowl") || g.inactive) return null;
  const b = g.bowling;
  if (!b || b.status !== "confirmed" || !b.qamfReservationId) return null;
  const startMs = etWallMs(b.bookedAt);
  if (Number.isNaN(startMs) || nowMs >= startMs - TIME_SHIFT_CUTOFF_MS) return null;
  return b;
}

/**
 * The booking's V2 voucher — code + a scannable QR of the /v/{code} URL so a
 * manager can pull up (or scan) a guest's entitlements straight off the board.
 * Same payload as the emailed QR, so kiosks recognise it too. Rendered as a
 * data URI (internal screen — the email's cid constraint doesn't apply).
 */
function VoucherBadge({ code, voided }: { code: string; voided: boolean }) {
  const [qr, setQr] = useState<string | null>(null);
  const url = `${typeof window !== "undefined" ? window.location.origin : ""}/v/${encodeURIComponent(code)}`;
  useEffect(() => {
    let alive = true;
    QRCode.toDataURL(url, { width: 96, margin: 1 })
      .then((d) => {
        if (alive) setQr(d);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [url]);
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        marginBottom: 10,
        padding: "8px 12px",
        borderRadius: 10,
        border: "1px solid rgba(212,175,55,0.4)",
        background: "rgba(212,175,55,0.06)",
        opacity: voided ? 0.5 : 1,
      }}
    >
      {qr && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={qr}
          alt={`Voucher QR ${formatVoucherCode(code)}`}
          width={72}
          height={72}
          style={{ borderRadius: 6, background: "#fff", display: "block" }}
        />
      )}
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            fontSize: "0.62rem",
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            color: "#d4af37",
          }}
        >
          VIP Voucher{voided ? " · VOIDED" : ""}
        </div>
        <a
          href={`/v/${encodeURIComponent(code)}`}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
          style={{
            fontFamily: "monospace",
            fontSize: "1.05rem",
            letterSpacing: "0.08em",
            color: "var(--ba-fg)",
            textDecoration: "underline",
            textDecorationColor: "rgba(212,175,55,0.5)",
          }}
          title="Open the guest's voucher page (per-item used/available state)"
        >
          {formatVoucherCode(code)}
        </a>
      </div>
    </div>
  );
}

export default function VipComboCards({
  groups,
  nowMs,
  vouchers,
  onCancelLeg,
  onViewOrder,
  onOpenReservation,
  onChangeBowlingTime,
}: {
  groups: ComboGroup[];
  nowMs: number;
  /** Booking-minted V2 voucher per BMI billId (route vipVouchers). */
  vouchers?: Record<string, { code: string; voided: boolean }>;
  onCancelLeg: (leg: Reservation) => void;
  onViewOrder: (target: OrderTarget) => void;
  /** Card click (anywhere except inner buttons) opens the manage modal on the anchor leg. */
  onOpenReservation?: (r: Reservation) => void;
  /** Opens the ±1h bowling time-shift modal on the combo's bowling leg. */
  onChangeBowlingTime?: (leg: Reservation) => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div
        style={{
          fontSize: 13,
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: 1,
          color: "#d4af37",
          marginBottom: 4,
        }}
      >
        ★ VIP Combos ({groups.length}) — all centers
      </div>
      {groups.map((g) => {
        const name = g.meta?.name ?? "VIP Combo";
        const accent = g.meta?.accentColor ?? "#d4af37";
        return (
          <div
            key={g.key}
            {...(onOpenReservation
              ? clickableDivProps((e) => {
                  if ((e.target as HTMLElement).closest("button, a, input")) return;
                  onOpenReservation(g.anchor);
                }, `Manage ${g.guestName}'s combo`)
              : {})}
            style={{
              borderRadius: 12,
              border: "1px solid rgba(212,175,55,0.45)",
              borderLeft: `4px solid ${accent}`,
              background: "rgba(212,175,55,0.06)",
              padding: "14px 16px",
              opacity: g.inactive ? 0.55 : 1,
              ...(onOpenReservation ? { cursor: "pointer" } : {}),
            }}
          >
            {/* Header */}
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "baseline",
                gap: 8,
                flexWrap: "wrap",
              }}
            >
              <div style={{ fontWeight: 700, color: "var(--ba-fg)", fontSize: "1rem" }}>
                <span style={{ color: accent }}>★</span> {name}
                {g.meta?.adminShortLabel && (
                  <span
                    style={{
                      marginLeft: 8,
                      padding: "1px 6px",
                      borderRadius: 4,
                      fontSize: "0.62rem",
                      fontWeight: 700,
                      textTransform: "uppercase",
                      letterSpacing: "0.04em",
                      verticalAlign: "middle",
                      color: accent,
                      border: `1px solid ${accent}`,
                    }}
                    title={`${g.meta.adminShortLabel} pack (registry ${g.comboId})`}
                  >
                    {g.meta.adminShortLabel}
                  </span>
                )}
              </div>
              <div style={{ fontWeight: 700, color: "#22c55e" }}>{dollars(g.totalCents)}</div>
            </div>

            {/* Guest line */}
            <div
              style={{
                fontSize: "0.85rem",
                color: "var(--ba-muted)",
                marginTop: 2,
                marginBottom: 10,
              }}
            >
              {g.guestName}
              {g.guestPhone ? ` · ${g.guestPhone}` : ""}
              {g.playerCount ? ` · ${g.playerCount}p` : ""} · {centerLabel(g.centerCode)}
            </div>

            {/* V2 voucher (code + scannable QR) — keyed by the combo's BMI bill */}
            {(() => {
              const billId = g.legs.find((l) => l.bmiBillId)?.bmiBillId;
              const v = billId ? vouchers?.[billId] : undefined;
              return v ? <VoucherBadge code={v.code} voided={v.voided} /> : null;
            })()}

            {/* Schedule — real per-leg times: race heat times (heatId =
                block-start ISO) + the bowling slot, with the lane. */}
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {g.schedule.map((step, i) => {
                // Schedule-based progress marker (booked start + expected
                // length vs now) — hidden on cancelled combos, and the
                // "up next" hint only shows inside a 4h window so a
                // tomorrow board isn't wallpapered with "in 19h".
                const prog = g.inactive ? null : stepProgress(step, nowMs);
                const isBowling = step.icon === "🎳";
                return (
                  <div
                    key={i}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      fontSize: "0.85rem",
                      color: "var(--ba-fg)",
                      opacity: prog?.state === "done" ? 0.6 : 1,
                    }}
                  >
                    <span style={{ width: 18, textAlign: "center" }}>{step.icon}</span>
                    {/* Time — prominent: this is the whole point of the schedule. */}
                    <span
                      style={{
                        minWidth: 84,
                        fontWeight: 800,
                        fontSize: "1rem",
                        color: step.iso ? accent : "var(--ba-muted)",
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {step.iso ? fmtClock(step.iso) : step.pending ? "—" : "TBD"}
                    </span>
                    <span style={{ flex: 1, fontWeight: 600 }}>
                      {step.label}
                      {step.lane ? (
                        <span style={{ color: accent, fontWeight: 700 }}> · Lane {step.lane}</span>
                      ) : null}
                      {step.pending ? (
                        <span style={{ color: "var(--ba-muted)", fontWeight: 400 }}>
                          {" "}
                          (if qualified)
                        </span>
                      ) : null}
                    </span>
                    {prog?.state === "done" && (
                      <span
                        style={{
                          fontSize: "0.7rem",
                          fontWeight: 700,
                          color: "#22c55e",
                          border: "1px solid rgba(34,197,94,0.35)",
                          backgroundColor: "rgba(34,197,94,0.12)",
                          borderRadius: 999,
                          padding: "1px 8px",
                          whiteSpace: "nowrap",
                        }}
                      >
                        ✓ Done
                      </span>
                    )}
                    {prog?.state === "active" &&
                      (() => {
                        // Bowling wording follows QAMF lane truth:
                        // lane open → countdown (or "wrapping up" past
                        // the scheduled end); slot started but nobody
                        // checked in → amber "not arrived" nudge.
                        // Race wording follows live track truth
                        // (raceState): on track / called to grid; a heat
                        // past its scheduled end but still uncalled shows
                        // amber "Delayed" — the race analog of the
                        // bowling nudge. No raceState = clock fallback.
                        const laneOpen = step.legStatus === "arrived";
                        const late = isBowling ? !laneOpen : prog.overdue;
                        const text = isBowling
                          ? laneOpen
                            ? prog.overdue
                              ? "Bowling now · wrapping up"
                              : `Bowling now · ${fmtDurShort(prog.minsLeft)} left`
                            : "Lane due · not arrived"
                          : step.raceState === "on_track"
                            ? "On track now"
                            : step.raceState === "called"
                              ? "Called to grid"
                              : prog.overdue
                                ? "Delayed · not called"
                                : step.raceState === "not_called"
                                  ? "Due · not called yet"
                                  : "In progress";
                        const color = late ? "#f59e0b" : accent;
                        const bg = late ? "rgba(245,158,11,0.15)" : "rgba(212,175,55,0.15)";
                        return (
                          <span
                            style={{
                              fontSize: "0.7rem",
                              fontWeight: 700,
                              color,
                              border: `1px solid ${color}`,
                              backgroundColor: bg,
                              borderRadius: 999,
                              padding: "1px 8px",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {text}
                          </span>
                        );
                      })()}
                    {prog?.state === "upcoming" && prog.minsUntil <= 240 && (
                      <span
                        style={{
                          fontSize: "0.7rem",
                          color: "var(--ba-muted)",
                          whiteSpace: "nowrap",
                        }}
                      >
                        in {fmtDurShort(prog.minsUntil)}
                      </span>
                    )}
                    <span style={{ color: "var(--ba-muted)", fontSize: "0.75rem" }}>
                      {step.loc}
                    </span>
                  </div>
                );
              })}
            </div>

            {/* Per-leg status + actions */}
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 8,
                marginTop: 12,
                paddingTop: 10,
                borderTop: "1px solid var(--ba-input-border)",
              }}
            >
              {g.legs.map((leg) => (
                <div
                  key={leg.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    fontSize: "0.72rem",
                    color: "var(--ba-muted)",
                    border: "1px solid var(--ba-input-border)",
                    borderRadius: 8,
                    padding: "3px 8px",
                  }}
                >
                  <span
                    style={{
                      fontWeight: 700,
                      color: KIND_BADGE[leg.productKind]?.color ?? "var(--ba-fg)",
                    }}
                  >
                    {KIND_FULL_LABELS[leg.productKind] ?? leg.productKind}
                  </span>
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: "50%",
                      backgroundColor: STATUS_COLORS[leg.status] ?? "#6b7280",
                      display: "inline-block",
                    }}
                  />
                  <span>{STATUS_LABELS[leg.status] ?? leg.status}</span>
                  {leg.qamfReservationId && <span>· QAMF {leg.qamfReservationId}</span>}
                  {leg.dayofOrderLane && <span>· Lane {leg.dayofOrderLane}</span>}
                </div>
              ))}
              {/* One button per day-of order — a split combo has two
                  (Racing → FastTrax, Bowling → HeadPinz); pre-split has one. */}
              <div style={{ display: "flex", gap: 6, marginLeft: "auto" }}>
                {onChangeBowlingTime &&
                  (() => {
                    const leg = timeShiftLeg(g, nowMs);
                    return leg ? (
                      <button
                        type="button"
                        onClick={() => onChangeBowlingTime(leg)}
                        title="Move the bowling slot ±1 hour (races stay put) — alerts the movement chat"
                        style={{
                          ...NAV_BTN,
                          fontSize: "0.72rem",
                          fontWeight: 600,
                          color: "#d4af37",
                          border: "1px solid rgba(212,175,55,0.4)",
                        }}
                      >
                        Change bowl time
                      </button>
                    ) : null;
                  })()}
                {g.legs.some((l) => cancelActionable(l)) && (
                  <button
                    type="button"
                    onClick={() => onCancelLeg(g.legs.find((l) => cancelActionable(l)) ?? g.anchor)}
                    title="Cancel BOTH legs — one refund or one HeadPinz FastTrax Gift Card for the full package"
                    style={{
                      ...NAV_BTN,
                      fontSize: "0.72rem",
                      fontWeight: 600,
                      color: "#ef4444",
                      border: "1px solid rgba(239,68,68,0.3)",
                    }}
                  >
                    Cancel Combo
                  </button>
                )}
                {g.dayofOrders.map((o) => (
                  <button
                    key={o.orderId}
                    type="button"
                    onClick={() =>
                      onViewOrder({
                        guestName: g.guestName,
                        squareDayofOrderId: o.orderId,
                        rewardDiscountCents: o.leg.rewardDiscountCents ?? 0,
                        squareLoyaltyRewardId: o.leg.squareLoyaltyRewardId,
                        promoCode: o.leg.promoCode ?? null,
                        promoSavingsCents: o.leg.promoSavingsCents ?? 0,
                      })
                    }
                    style={{ ...NAV_BTN, fontSize: "0.72rem", fontWeight: 600 }}
                  >
                    {g.dayofOrders.length > 1 ? `${o.kind} order` : "View order"}
                  </button>
                ))}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
