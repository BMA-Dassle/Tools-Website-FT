"use client";

/**
 * Manage Reservation — Overview tab: per-kind itinerary (merged across the
 * whole money group for combos/mixed carts), line items, promo/reward,
 * cancellation summary, notes preview.
 */
import { etWallMs, dollars, fmtClock, ganDisplay } from "~/features/reservations-admin/format";
import { KIND_FULL_LABELS } from "~/features/reservations-admin/constants";
import { centerLabel } from "~/features/reservations-admin/format";
import type { DetailLeg, ReservationDetail } from "~/features/reservations-admin/service";
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
 *  timeLabel. */
function legSteps(leg: DetailLeg, boardRow: Reservation): ItineraryStep[] {
  if (leg.productKind === "race") {
    const live = leg.id === boardRow.id ? boardRow.liveHeats : undefined;
    if (live?.length) {
      return live.map((h) => ({
        iso: h.start,
        label: h.name ?? "Race",
        legKind: "race",
      }));
    }
    const heats = (leg.bookingMetadata?.heats ?? []) as Array<{
      heatId?: string | null;
      track?: string;
    }>;
    return heats
      .filter((h) => h.heatId)
      .map((h) => ({
        iso: h.heatId as string,
        label: h.track ? `Race · ${h.track}` : "Race",
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

export default function OverviewTab({
  detail,
  boardRow,
}: {
  detail: ReservationDetail;
  boardRow: Reservation;
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

      <Card title="Line items">
        {lines.length === 0 ? (
          <div style={{ color: "var(--ba-muted)", fontSize: "0.82rem" }}>No line items stored</div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.82rem" }}>
            <tbody>
              {lines.map((l, i) => (
                <tr key={i} style={{ borderBottom: "1px dashed var(--ba-border)" }}>
                  <td style={{ padding: "4px 6px" }}>{l.label}</td>
                  <td
                    style={{
                      padding: "4px 6px",
                      textAlign: "right",
                      color: "var(--ba-muted)",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    ×{l.quantity}
                  </td>
                  <td
                    style={{
                      padding: "4px 6px",
                      textAlign: "right",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {dollars(l.unitPriceCents * l.quantity)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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
