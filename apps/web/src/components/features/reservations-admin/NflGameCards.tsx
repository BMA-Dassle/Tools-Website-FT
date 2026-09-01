"use client";

/**
 * NFL Ticket card view — one violet card per GAME, split by lane block.
 *
 * Grouped game-then-block on purpose. A lane number tells staff where a party
 * sits; it does not tell them which screen owes that party which game, and
 * getting that wrong is the one failure this package produces that a guest
 * notices instantly. So the card leads with the matchup and the time the screen
 * has to change, and the lanes hang underneath their block.
 *
 * Mirrors VipComboCards in shape and controls so the two boards read alike.
 */

import { cancelActionable } from "~/features/reservations-admin/actionable";
import type { NflGameGroup, NflPartyRow } from "~/features/reservations-admin/nfl-board";
import { KIND_BADGE, STATUS_COLORS, STATUS_LABELS } from "~/features/reservations-admin/constants";
import { centerLabel, dollars } from "~/features/reservations-admin/format";
import type { Reservation } from "~/features/reservations-admin/types";
import type { OrderTarget } from "./modals/SquareOrderModal";
import { NAV_BTN } from "./theme";

const V = KIND_BADGE.nfl;

const etTime = (iso: string) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));

/** Food picks for this party, off the persisted $0 lines. */
function foodLines(r: Reservation): string[] {
  return (r.lines ?? [])
    .filter((l) => /^game day /i.test(l.label ?? ""))
    .map((l) => l.label as string);
}

export default function NflGameCards({
  games,
  onCancelLeg,
  onViewOrder,
  onOpenReservation,
}: {
  games: NflGameGroup[];
  onCancelLeg: (r: Reservation) => void;
  onViewOrder: (t: OrderTarget) => void;
  onOpenReservation: (r: Reservation) => void;
}) {
  return (
    <div style={{ display: "grid", gap: "1rem" }}>
      {games.map((g) => (
        <div
          key={g.gameId}
          style={{
            border: `1px solid ${g.needsAttention ? "rgba(251,191,36,0.5)" : V.border}`,
            borderRadius: 12,
            background: V.bg,
            padding: "0.9rem 1rem",
          }}
        >
          {/* ── the game, and when the screen changes ── */}
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "baseline",
              gap: "0.5rem 0.9rem",
              marginBottom: "0.7rem",
            }}
          >
            <span style={{ fontSize: "1rem", fontWeight: 800, color: V.color }}>{g.label}</span>
            <span style={{ fontSize: "0.72rem", color: "var(--ba-muted)" }}>
              {etTime(g.kickoffIso)} kickoff · lanes open{" "}
              <strong style={{ color: "var(--ba-fg)" }}>{etTime(g.laneOpenEt)}</strong>
            </span>
            <span style={{ marginLeft: "auto", fontSize: "0.7rem", color: "var(--ba-muted)" }}>
              {g.parties} {g.parties === 1 ? "party" : "parties"} · {g.players} bowlers
            </span>
          </div>

          {g.needsAttention && (
            <div
              style={{
                marginBottom: "0.7rem",
                padding: "0.45rem 0.6rem",
                borderRadius: 8,
                background: "rgba(251,191,36,0.14)",
                color: "#fbbf24",
                fontSize: "0.7rem",
                fontWeight: 600,
              }}
            >
              A party on this game is seated outside its block — reseat it, or the screen will be
              showing the wrong game for them.
            </div>
          )}

          {/* ── blocks ── */}
          <div style={{ display: "grid", gap: "0.6rem" }}>
            {g.blocks.map((b) => (
              <div
                key={b.blockId}
                style={{
                  border: "1px solid var(--ba-input-border)",
                  borderRadius: 10,
                  padding: "0.6rem 0.7rem",
                  background: "var(--ba-input-bg)",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    gap: "0.4rem 0.7rem",
                    alignItems: "baseline",
                    marginBottom: "0.5rem",
                  }}
                >
                  <span style={{ fontSize: "0.75rem", fontWeight: 700, color: "var(--ba-fg)" }}>
                    {b.blockLabel}
                  </span>
                  {b.lanes.length > 0 && (
                    <span style={{ fontSize: "0.7rem", color: V.color, fontWeight: 600 }}>
                      Lane{b.lanes.length > 1 ? "s" : ""} {b.lanes.join(", ")}
                    </span>
                  )}
                  <span style={{ fontSize: "0.66rem", color: "var(--ba-muted)" }}>
                    {b.players} bowlers
                  </span>
                </div>

                <div style={{ display: "grid", gap: "0.45rem" }}>
                  {b.parties.map((p) => (
                    <PartyRow
                      key={p.reservation.id}
                      row={p}
                      onCancelLeg={onCancelLeg}
                      onViewOrder={onViewOrder}
                      onOpenReservation={onOpenReservation}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function PartyRow({
  row,
  onCancelLeg,
  onViewOrder,
  onOpenReservation,
}: {
  row: NflPartyRow;
  onCancelLeg: (r: Reservation) => void;
  onViewOrder: (t: OrderTarget) => void;
  onOpenReservation: (r: Reservation) => void;
}) {
  const r = row.reservation;
  const food = foodLines(r);
  const statusColor = STATUS_COLORS[r.status] ?? "var(--ba-muted)";

  return (
    <div
      style={{
        borderTop: "1px solid var(--ba-input-border)",
        paddingTop: "0.45rem",
        display: "grid",
        gap: "0.3rem",
      }}
    >
      <div
        style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem 0.7rem", alignItems: "baseline" }}
      >
        <button
          type="button"
          onClick={() => onOpenReservation(r)}
          style={{
            ...NAV_BTN,
            padding: 0,
            border: "none",
            background: "none",
            fontSize: "0.78rem",
            fontWeight: 700,
            color: "var(--ba-fg)",
            cursor: "pointer",
          }}
        >
          {r.guestName || "Guest"}
        </button>
        <span style={{ fontSize: "0.68rem", color: "var(--ba-muted)" }}>
          {r.playerCount} bowler{r.playerCount === 1 ? "" : "s"}
          {r.shortCode ? ` · ${r.shortCode}` : ""}
          {r.centerCode ? ` · ${centerLabel(r.centerCode)}` : ""}
        </span>
        <span style={{ fontSize: "0.64rem", fontWeight: 700, color: statusColor }}>
          {STATUS_LABELS[r.status] ?? r.status}
        </span>
        {row.lanes.length > 0 && (
          <span style={{ fontSize: "0.66rem", color: "var(--ba-muted)" }}>
            lane{row.lanes.length > 1 ? "s" : ""} {row.lanes.join(", ")}
          </span>
        )}
        <span
          style={{ marginLeft: "auto", fontSize: "0.7rem", fontWeight: 700, color: "var(--ba-fg)" }}
        >
          {dollars(r.totalCents ?? 0)}
        </span>
      </div>

      {row.needsReseat && (
        <div style={{ fontSize: "0.66rem", color: "#fbbf24", fontWeight: 600 }}>
          Not seated on {r.bookingMetadata?.nfl?.blockLabel ?? "its block"} ({row.reseatReason}) —
          move them, or change what this screen shows.
        </div>
      )}

      {food.length > 0 && (
        <div style={{ fontSize: "0.66rem", color: "var(--ba-muted)", lineHeight: 1.5 }}>
          {food.map((f, i) => (
            <div key={i}>{f}</div>
          ))}
        </div>
      )}

      <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
        {r.squareDayofOrderId && (
          <button
            type="button"
            onClick={() =>
              onViewOrder({
                guestName: r.guestName || "Guest",
                squareDayofOrderId: r.squareDayofOrderId ?? null,
                rewardDiscountCents: r.rewardDiscountCents ?? 0,
                squareLoyaltyRewardId: r.squareLoyaltyRewardId,
                promoCode: r.promoCode,
                promoSavingsCents: r.promoSavingsCents,
              })
            }
            style={{ ...NAV_BTN, fontSize: "0.62rem", padding: "0.2rem 0.45rem" }}
          >
            Order
          </button>
        )}
        {cancelActionable(r) && (
          <button
            type="button"
            onClick={() => onCancelLeg(r)}
            style={{
              ...NAV_BTN,
              fontSize: "0.62rem",
              padding: "0.2rem 0.45rem",
              color: "#f87171",
              borderColor: "rgba(248,113,113,0.4)",
            }}
          >
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}
