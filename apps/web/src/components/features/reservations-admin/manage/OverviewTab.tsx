"use client";

/**
 * Manage Reservation — Overview tab: per-kind itinerary (merged across the
 * whole money group for combos/mixed carts), line items, promo/reward,
 * cancellation summary, notes preview.
 */
import { useEffect } from "react";
import { etWallMs, dollars, fmtClock, ganDisplay } from "~/features/reservations-admin/format";
import { KIND_FULL_LABELS } from "~/features/reservations-admin/constants";
import { centerLabel } from "~/features/reservations-admin/format";
import type {
  DetailLeg,
  PaymentTimeline,
  ReservationDetail,
  TimelineNode,
} from "~/features/reservations-admin/service";
import type { Reservation } from "~/features/reservations-admin/types";
import { Card, KindChip, StatusChip } from "./ui";

interface ItineraryStep {
  iso: string | null;
  label: string;
  sub?: string;
  legKind: string;
}

/** Real schedule steps for one leg — liveHeats (BMI truth, board row only)
 *  beat booking_metadata heats; bowling uses the slot; attractions their
 *  timeLabel. Race sources carry one entry per RACER per heat — consolidate
 *  to one row per heat with a racer count (mirrors bowling's "N bowlers"). */
function legSteps(leg: DetailLeg, boardRow: Reservation): ItineraryStep[] {
  if (leg.productKind === "race") {
    const racersSub = (n: number | undefined) =>
      n ? `${n} racer${n === 1 ? "" : "s"}` : undefined;
    const live = leg.id === boardRow.id ? boardRow.liveHeats : undefined;
    if (live?.length) {
      // Server already collapsed the per-racer bill lines and kept the count.
      return live.map((h) => ({
        iso: h.start,
        label: h.name ?? "Race",
        sub: racersSub(h.racers),
        legKind: "race",
      }));
    }
    const heats = (leg.bookingMetadata?.heats ?? []) as Array<{
      heatId?: string | null;
      track?: string;
    }>;
    // booking_metadata stamps one entry per racer per heat — group them.
    const byHeat = new Map<string, { iso: string; label: string; racers: number }>();
    for (const h of heats) {
      if (!h.heatId) continue;
      const key = `${h.heatId}|${h.track ?? ""}`;
      const cur = byHeat.get(key);
      if (cur) cur.racers += 1;
      else
        byHeat.set(key, {
          iso: h.heatId,
          label: h.track ? `Race · ${h.track.replace(/\s*Track$/i, "")}` : "Race",
          racers: 1,
        });
    }
    return [...byHeat.values()].map((g) => ({
      iso: g.iso,
      label: g.label,
      sub: racersSub(g.racers),
      legKind: "race",
    }));
  }
  const steps: ItineraryStep[] = [];
  if (leg.productKind === "open" || leg.productKind === "kbf") {
    steps.push({
      iso: leg.bookedAt,
      label: KIND_FULL_LABELS[leg.productKind] ?? "Bowling",
      sub: [
        leg.playerCount ? `${leg.playerCount} bowlers` : null,
        leg.dayofOrderLane ? `Lane ${leg.dayofOrderLane}` : null,
        leg.qamfReservationId ? `QAMF ${leg.qamfReservationId}` : null,
      ]
        .filter(Boolean)
        .join(" · "),
      legKind: leg.productKind,
    });
  }
  for (const a of leg.attractionBookings ?? []) {
    steps.push({
      iso: null,
      label: `${a.name} ×${a.quantity}`,
      sub: a.timeLabel,
      legKind: "attraction",
    });
  }
  if (leg.productKind === "attraction" && steps.length === 0) {
    steps.push({ iso: leg.bookedAt, label: "Attraction", legKind: "attraction" });
  }
  return steps;
}

/** A day-of Square order node that carries usable line items. */
type DayofOrderNode = TimelineNode & { order: NonNullable<TimelineNode["order"]> };

export default function OverviewTab({
  detail,
  boardRow,
  payments,
  paymentsLoading,
  paymentsError,
  loadPayments,
}: {
  detail: ReservationDetail;
  boardRow: Reservation;
  /** Lazy Square payment timeline (shared with the Payments tab) — carries the
   *  real day-of order line items. Null until loaded. */
  payments: PaymentTimeline | null;
  paymentsLoading: boolean;
  paymentsError: string | null;
  loadPayments: () => Promise<void>;
}) {
  const r = detail.reservation;
  const multi = detail.group.length > 1;
  const steps = detail.group
    .flatMap((leg) => legSteps(leg, boardRow))
    .sort(
      (a, b) =>
        (a.iso ? etWallMs(a.iso) : Number.POSITIVE_INFINITY) -
        (b.iso ? etWallMs(b.iso) : Number.POSITIVE_INFINITY),
    );
  const lines = (r.lines ?? []) as Array<{
    label: string;
    quantity: number;
    unitPriceCents: number;
  }>;

  // Line items truth = the day-of Square order (what was actually sold/charged).
  // The stored `lines` are BMI $0-model per-heat shadows and mislead for race
  // bookings, so auto-load the (cached) timeline once and prefer its day-of
  // order(s); fall back to the stored lines only before a day-of order exists.
  useEffect(() => {
    if (payments == null && !paymentsLoading && !paymentsError) void loadPayments();
  }, [payments, paymentsLoading, paymentsError, loadPayments]);

  const dayofNodes = (payments?.nodes ?? []).filter(
    (n): n is DayofOrderNode => n.kind === "dayof_order" && !!n.order?.lineItems,
  );
  const dayofExpected = detail.group.some((leg) => leg.squareDayofOrderId);
  const legKindById = new Map(detail.group.map((leg) => [leg.id, leg.productKind]));

  const lineItemsMode: "dayof" | "loading" | "unavailable" | "none" =
    dayofNodes.length > 0
      ? "dayof"
      : !dayofExpected
        ? "none"
        : !paymentsError && (paymentsLoading || payments == null)
          ? "loading"
          : "unavailable";

  const lineItemsTitle =
    lineItemsMode === "dayof"
      ? multi
        ? "Line items — day-of Square orders"
        : "Line items — day-of Square order"
      : lineItemsMode === "loading"
        ? "Line items"
        : lineItemsMode === "none"
          ? "Line items — booking estimate (day-of order not created yet)"
          : "Line items — booking estimate";

  return (
    <>
      {r.status === "cancelled" && (
        <Card title="Cancellation" style={{ borderColor: "rgba(239,68,68,0.4)" }}>
          <div style={{ fontSize: "0.82rem", lineHeight: 1.7 }}>
            Cancelled{r.cancelledAt ? ` ${fmtClock(r.cancelledAt)}` : ""}
            {r.cancelledBy ? ` by ${r.cancelledBy}` : ""} · outcome:{" "}
            {r.cancellationOutcome ?? "unknown"}
            {r.refundCents > 0 && (
              <div style={{ color: "#ef4444" }}>Refunded {dollars(r.refundCents)}</div>
            )}
            {r.storeCreditGiftCardGan && (r.storeCreditCents ?? 0) > 0 && (
              <div style={{ color: "#22c55e", fontFamily: "ui-monospace, monospace" }}>
                HeadPinz FastTrax Gift Card {ganDisplay(r.storeCreditGiftCardGan)} (
                {dollars(r.storeCreditCents ?? 0)})
              </div>
            )}
          </div>
        </Card>
      )}

      <Card title={multi ? "Itinerary — whole booking, all parts" : "Itinerary"}>
        {steps.length === 0 ? (
          <div style={{ color: "var(--ba-muted)", fontSize: "0.82rem" }}>No schedule details</div>
        ) : (
          steps.map((s, i) => (
            <div
              key={i}
              style={{
                display: "flex",
                gap: 12,
                alignItems: "baseline",
                padding: "6px 0",
                borderBottom: i < steps.length - 1 ? "1px dashed var(--ba-border)" : undefined,
                fontSize: "0.85rem",
              }}
            >
              <span
                style={{
                  minWidth: 76,
                  fontWeight: 700,
                  fontVariantNumeric: "tabular-nums",
                  color: s.iso ? "var(--ba-fg)" : "var(--ba-muted)",
                }}
              >
                {s.iso ? fmtClock(s.iso) : "TBD"}
              </span>
              {multi && <KindChip kind={s.legKind} />}
              <span style={{ flex: 1, fontWeight: 600 }}>{s.label}</span>
              {s.sub && (
                <span style={{ color: "var(--ba-muted)", fontSize: "0.75rem" }}>{s.sub}</span>
              )}
            </div>
          ))
        )}
      </Card>

      {multi && (
        <Card title="Parts of this booking">
          {detail.group.map((leg) => (
            <div
              key={leg.id}
              style={{
                display: "flex",
                gap: 8,
                alignItems: "center",
                padding: "5px 0",
                fontSize: "0.8rem",
              }}
            >
              <KindChip kind={leg.productKind} />
              <StatusChip status={leg.status} />
              <span style={{ color: "var(--ba-muted)" }}>
                #{leg.id} · {centerLabel(leg.centerCode)}
              </span>
              {leg.bmiBillId && (
                <span
                  style={{
                    color: "var(--ba-muted)",
                    fontFamily: "ui-monospace, monospace",
                    fontSize: "0.68rem",
                  }}
                >
                  BMI {leg.bmiBillId}
                </span>
              )}
            </div>
          ))}
        </Card>
      )}

      <Card title={lineItemsTitle}>
        {lineItemsMode === "dayof" ? (
          dayofNodes.map((node) => (
            <DayofOrderSection
              key={node.order.id}
              node={node}
              kindLabel={
                KIND_FULL_LABELS[legKindById.get(node.legId ?? -1) ?? ""] ?? "Day-of order"
              }
              showHeader={dayofNodes.length > 1}
            />
          ))
        ) : lineItemsMode === "loading" ? (
          // A day-of order exists but the Square read is still in flight — show a
          // placeholder, never the stored BMI shadows (they'd flash the very
          // "2 × Starter Race Red" data this card exists to replace).
          <div style={{ color: "var(--ba-muted)", fontSize: "0.82rem", padding: "4px 0" }}>
            Loading the day-of Square order…
          </div>
        ) : (
          <>
            <StoredLinesTable lines={lines} />
            {lineItemsMode === "unavailable" && (
              <div style={{ marginTop: 8, fontSize: "0.72rem", color: "var(--ba-muted)" }}>
                Couldn&rsquo;t load the day-of Square order — showing the booking estimate.
              </div>
            )}
          </>
        )}
        {(r.promoCode || r.rewardDiscountCents > 0) && (
          <div style={{ marginTop: 8, display: "flex", gap: 10, fontSize: "0.75rem" }}>
            {r.promoCode && (
              <span style={{ color: "#c084fc" }}>
                Coupon {r.promoCode} −{dollars(r.promoSavingsCents)}
              </span>
            )}
            {r.rewardDiscountCents > 0 && (
              <span style={{ color: "#f59e0b" }}>
                HeadPinz Reward −{dollars(r.rewardDiscountCents)}
              </span>
            )}
          </div>
        )}
      </Card>

      <Card title="Notes">
        <div style={{ fontSize: "0.82rem", whiteSpace: "pre-wrap" }}>
          {r.notes || <span style={{ color: "var(--ba-muted)" }}>No notes</span>}
        </div>
        <div style={{ marginTop: 6, fontSize: "0.72rem", color: "var(--ba-muted)" }}>
          Edit in the Notes tab
        </div>
      </Card>
    </>
  );
}

const CELL: React.CSSProperties = { padding: "4px 6px" };
const NUM_CELL: React.CSSProperties = {
  padding: "4px 6px",
  textAlign: "right",
  fontVariantNumeric: "tabular-nums",
};

/** The stored BMI `bowling_reservation_lines` — the booking-estimate fallback. */
function StoredLinesTable({
  lines,
}: {
  lines: Array<{ label: string; quantity: number; unitPriceCents: number }>;
}) {
  if (lines.length === 0) {
    return (
      <div style={{ color: "var(--ba-muted)", fontSize: "0.82rem" }}>No line items stored</div>
    );
  }
  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.82rem" }}>
      <tbody>
        {lines.map((l, i) => (
          <tr key={i} style={{ borderBottom: "1px dashed var(--ba-border)" }}>
            <td style={CELL}>{l.label}</td>
            <td style={{ ...NUM_CELL, color: "var(--ba-muted)" }}>×{l.quantity}</td>
            <td style={NUM_CELL}>{dollars(l.unitPriceCents * l.quantity)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** One day-of Square order's real contents: line items, service charges, total. */
function DayofOrderSection({
  node,
  kindLabel,
  showHeader,
}: {
  node: DayofOrderNode;
  kindLabel: string;
  showHeader: boolean;
}) {
  const { order } = node;
  const items = order.lineItems ?? [];
  const svc = order.serviceCharges ?? [];
  return (
    <div style={{ marginBottom: showHeader ? 12 : 0 }}>
      {showHeader && (
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
            marginBottom: 4,
          }}
        >
          <span style={{ fontSize: "0.75rem", fontWeight: 700 }}>{kindLabel}</span>
          <span
            style={{
              fontSize: "0.68rem",
              color: "var(--ba-muted)",
              fontFamily: "ui-monospace, monospace",
            }}
          >
            {order.state}
          </span>
        </div>
      )}
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.82rem" }}>
        <tbody>
          {items.map((li, i) => (
            <tr key={`li-${i}`} style={{ borderBottom: "1px dashed var(--ba-border)" }}>
              <td style={CELL}>{li.name}</td>
              <td style={{ ...NUM_CELL, color: "var(--ba-muted)" }}>×{li.quantity}</td>
              <td style={NUM_CELL}>{dollars(li.totalCents)}</td>
            </tr>
          ))}
          {svc.map((sc, i) => (
            <tr key={`sc-${i}`} style={{ borderBottom: "1px dashed var(--ba-border)" }}>
              <td colSpan={2} style={{ ...CELL, color: "var(--ba-muted)" }}>
                {sc.name}
              </td>
              <td style={{ ...NUM_CELL, color: "var(--ba-muted)" }}>{dollars(sc.totalCents)}</td>
            </tr>
          ))}
          <tr>
            <td colSpan={2} style={{ ...CELL, paddingTop: 6, fontWeight: 700 }}>
              Total
            </td>
            <td style={{ ...NUM_CELL, paddingTop: 6, fontWeight: 700 }}>
              {dollars(order.totalCents)}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
