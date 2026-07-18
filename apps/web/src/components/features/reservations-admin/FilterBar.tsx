"use client";

/**
 * Filter bar for the admin reservations board: Active-Only / Web-Only
 * toggles, kind chips (with counts) + the ★VIP special filter, date nav,
 * search, and the stats line. Extracted verbatim from
 * app/admin/[token]/reservations/ReservationsClient.tsx.
 */
import type { Dispatch, SetStateAction } from "react";
import { KIND_BADGE } from "~/features/reservations-admin/constants";
import { dollars, fmtDate, todayET } from "~/features/reservations-admin/format";
import type { Reservation } from "~/features/reservations-admin/types";
import { INPUT_STYLE, NAV_BTN } from "./theme";

export interface BoardStats {
  activeCount: number;
  totalHidden: number;
  totalCancelledAll: number;
  totalCompletedAll: number;
  totalWalkins: number;
  totalPlayers: number;
  totalDeposit: number;
  totalRevenue: number;
}

export default function FilterBar({
  reservations,
  vipReservations,
  hideCancelled,
  setHideCancelled,
  hideWalkins,
  setHideWalkins,
  kioskOnly,
  setKioskOnly,
  kioskCount,
  kindFilter,
  setKindFilter,
  date,
  setDate,
  search,
  setSearch,
  loading,
  filteredCount,
  stats,
}: {
  reservations: Reservation[];
  vipReservations: Reservation[];
  hideCancelled: boolean;
  setHideCancelled: Dispatch<SetStateAction<boolean>>;
  hideWalkins: boolean;
  setHideWalkins: Dispatch<SetStateAction<boolean>>;
  kioskOnly: boolean;
  setKioskOnly: Dispatch<SetStateAction<boolean>>;
  kioskCount: number;
  kindFilter: string | null;
  setKindFilter: Dispatch<SetStateAction<string | null>>;
  date: string;
  setDate: Dispatch<SetStateAction<string>>;
  search: string;
  setSearch: Dispatch<SetStateAction<string>>;
  loading: boolean;
  filteredCount: number;
  stats: BoardStats;
}) {
  const vipActive = kindFilter === "vip";
  const {
    activeCount,
    totalHidden,
    totalCancelledAll,
    totalCompletedAll,
    totalWalkins,
    totalPlayers,
    totalDeposit,
    totalRevenue,
  } = stats;

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto", marginBottom: "1.5rem" }}>
      <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", alignItems: "center" }}>
        <button
          type="button"
          onClick={() => setHideCancelled((v) => !v)}
          style={{
            ...NAV_BTN,
            fontSize: "0.75rem",
            fontWeight: 600,
            backgroundColor: hideCancelled ? "rgba(34,197,94,0.15)" : "var(--ba-input-bg)",
            borderColor: hideCancelled ? "rgba(34,197,94,0.3)" : "var(--ba-input-border)",
            color: hideCancelled ? "#22c55e" : "var(--ba-muted)",
          }}
        >
          {hideCancelled ? "Active Only" : "All Statuses"}
        </button>
        <button
          type="button"
          onClick={() => setHideWalkins((v) => !v)}
          style={{
            ...NAV_BTN,
            fontSize: "0.75rem",
            fontWeight: 600,
            backgroundColor: hideWalkins ? "rgba(34,197,94,0.15)" : "var(--ba-input-bg)",
            borderColor: hideWalkins ? "rgba(34,197,94,0.3)" : "var(--ba-input-border)",
            color: hideWalkins ? "#22c55e" : "var(--ba-muted)",
          }}
        >
          {hideWalkins ? "Web Only" : "All Sources"}
        </button>
        {/* Kiosk-only — self-service kiosk bookings (amber, matches the row badge).
            Orthogonal to the source toggle above. */}
        <button
          type="button"
          onClick={() => setKioskOnly((v) => !v)}
          style={{
            ...NAV_BTN,
            fontSize: "0.7rem",
            fontWeight: 700,
            backgroundColor: kioskOnly ? "rgba(245,158,11,0.15)" : "var(--ba-input-bg)",
            borderColor: kioskOnly ? "rgba(245,158,11,0.4)" : "var(--ba-input-border)",
            color: kioskOnly ? "#f59e0b" : "var(--ba-muted)",
          }}
        >
          Kiosk
          <span style={{ marginLeft: 3, opacity: 0.7, fontSize: "0.6rem" }}>({kioskCount})</span>
        </button>
        {(["kbf", "open", "race", "attraction"] as const).map((k) => {
          const badge = KIND_BADGE[k];
          const isActive = kindFilter === k;
          return (
            <button
              key={k}
              type="button"
              onClick={() => setKindFilter(isActive ? null : k)}
              style={{
                ...NAV_BTN,
                fontSize: "0.7rem",
                fontWeight: 600,
                backgroundColor: isActive ? badge.bg : "var(--ba-input-bg)",
                borderColor: isActive ? badge.border : "var(--ba-input-border)",
                color: isActive ? badge.color : "var(--ba-muted)",
              }}
            >
              {badge.label}
              <span style={{ marginLeft: 3, opacity: 0.7, fontSize: "0.6rem" }}>
                ({reservations.filter((r) => r.productKind === k).length})
              </span>
            </button>
          );
        })}
        {/* VIP combos — special filter (not a productKind). Always shows all
            VIP combos for the date across centers (FastTrax + HeadPinz). */}
        {(() => {
          const badge = KIND_BADGE.vip;
          const count = new Set(
            vipReservations.map((r) => r.squareDayofOrderId || r.bmiBillId || `id-${r.id}`),
          ).size;
          return (
            <button
              type="button"
              onClick={() => setKindFilter(vipActive ? null : "vip")}
              style={{
                ...NAV_BTN,
                fontSize: "0.7rem",
                fontWeight: 700,
                backgroundColor: vipActive ? badge.bg : "var(--ba-input-bg)",
                borderColor: vipActive ? badge.border : "var(--ba-input-border)",
                color: vipActive ? badge.color : "var(--ba-muted)",
              }}
            >
              ★ {badge.label}
              <span style={{ marginLeft: 3, opacity: 0.7, fontSize: "0.6rem" }}>({count})</span>
            </button>
          );
        })()}
        <button
          type="button"
          onClick={() => setDate(todayET())}
          style={{
            ...NAV_BTN,
            fontSize: "0.75rem",
            textTransform: "uppercase",
            letterSpacing: "0.05em",
            fontWeight: 600,
          }}
        >
          Today
        </button>
        <button
          type="button"
          onClick={() => {
            const d = new Date(date + "T12:00:00");
            d.setDate(d.getDate() - 1);
            setDate(d.toISOString().slice(0, 10));
          }}
          style={NAV_BTN}
        >
          &larr;
        </button>
        <button
          type="button"
          onClick={() => {
            const d = new Date(date + "T12:00:00");
            d.setDate(d.getDate() + 1);
            setDate(d.toISOString().slice(0, 10));
          }}
          style={NAV_BTN}
        >
          &rarr;
        </button>
        <span style={{ color: "var(--ba-muted)", fontSize: "0.875rem" }}>
          {fmtDate(date + "T12:00:00")}
        </span>
      </div>

      {/* Search */}
      <div style={{ marginTop: "0.75rem" }}>
        <input
          type="text"
          placeholder="Search name, email, phone, QAMF ID, lane..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{
            ...INPUT_STYLE,
            width: "100%",
            maxWidth: 400,
          }}
        />
      </div>

      {/* Stats bar */}
      {!loading && filteredCount > 0 && (
        <div
          style={{
            display: "flex",
            gap: "1.5rem",
            marginTop: "0.75rem",
            fontSize: "0.8rem",
            color: "var(--ba-muted)",
            flexWrap: "wrap",
          }}
        >
          <span>
            <strong style={{ color: "var(--ba-fg)" }}>{activeCount}</strong> active
            {hideCancelled && totalHidden > 0 && (
              <span style={{ color: "var(--ba-muted)" }}>
                {" "}
                + {totalHidden} hidden
                {totalCancelledAll > 0 && totalCompletedAll > 0
                  ? ` (${totalCancelledAll} cancelled, ${totalCompletedAll} completed)`
                  : totalCancelledAll > 0
                    ? " (cancelled)"
                    : " (completed)"}
              </span>
            )}
            {!hideCancelled && totalCancelledAll > 0 && (
              <span style={{ color: "rgba(239,68,68,0.7)" }}> · {totalCancelledAll} cancelled</span>
            )}
            {hideWalkins && totalWalkins > 0 && (
              <span style={{ color: "var(--ba-muted)" }}> · {totalWalkins} walk-in</span>
            )}
          </span>
          <span>
            <strong style={{ color: "var(--ba-fg)" }}>{totalPlayers}</strong> bowlers
          </span>
          <span>
            Deposits <strong style={{ color: "#22c55e" }}>{dollars(totalDeposit)}</strong>
          </span>
          <span>
            Total <strong style={{ color: "#22c55e" }}>{dollars(totalRevenue)}</strong>
          </span>
        </div>
      )}
    </div>
  );
}
