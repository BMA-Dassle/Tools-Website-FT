"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

interface Reservation {
  id: number;
  centerCode: string;
  productKind: string;
  qamfReservationId?: string;
  squareDepositOrderId?: string;
  squareDayofOrderId?: string;
  squareGiftCardGan?: string;
  shortCode?: string;
  depositCents: number;
  totalCents: number;
  status: string;
  bookedAt: string;
  playerCount?: number;
  guestName?: string;
  guestEmail?: string;
  guestPhone?: string;
  notes?: string;
  cancelledAt?: string;
  refundCents: number;
  dayofOrderSentAt?: string;
  dayofOrderLane?: string;
  dayofPaymentId?: string;
  dayofOrderError?: string;
  insertedAt: string;
}

const CENTERS: Record<string, string> = {
  TXBSQN0FEKQ11: "Fort Myers",
  PPTR5G2N0QXF7: "Naples",
};

const STATUS_COLORS: Record<string, string> = {
  confirmed: "#22c55e",
  confirm_pending: "#f59e0b",
  confirm_failed: "#ef4444",
  arrived: "#3b82f6",
  completed: "#6b7280",
  cancelled: "#ef4444",
};

const STATUS_LABELS: Record<string, string> = {
  confirmed: "Confirmed",
  confirm_pending: "Pending",
  confirm_failed: "Failed",
  arrived: "Arrived",
  completed: "Completed",
  cancelled: "Cancelled",
};

function todayET(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  } catch {
    return iso;
  }
}

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      timeZone: "America/New_York",
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function confirmPath(r: Reservation): string | null {
  return r.shortCode ? `/s/${r.shortCode}` : null;
}

const INPUT_STYLE: React.CSSProperties = {
  backgroundColor: "rgba(255,255,255,0.08)",
  border: "1px solid rgba(255,255,255,0.15)",
  borderRadius: 8,
  color: "#fff",
  padding: "0.5rem 0.75rem",
  fontSize: "0.875rem",
};

const NAV_BTN: React.CSSProperties = {
  backgroundColor: "rgba(255,255,255,0.08)",
  border: "1px solid rgba(255,255,255,0.15)",
  borderRadius: 8,
  color: "rgba(255,255,255,0.6)",
  padding: "0.5rem 0.75rem",
  fontSize: "0.875rem",
  cursor: "pointer",
};

export default function ReservationsClient({ token }: { token: string }) {
  const [date, setDate] = useState(todayET);
  const [center, setCenter] = useState<string>("");
  const [search, setSearch] = useState("");
  const [hideCancelled, setHideCancelled] = useState(true);
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        token,
        date,
        ...(center ? { center } : {}),
      });
      const res = await fetch(`/api/admin/bowling/reservations?${params}`, {
        cache: "no-store",
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setReservations(data.reservations ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
      setReservations([]);
    } finally {
      setLoading(false);
    }
  }, [token, date, center]);

  useEffect(() => {
    void load();
  }, [load]);

  // Client-side search + cancelled filter
  const filtered = useMemo(() => {
    let list = reservations;
    if (hideCancelled) {
      list = list.filter((r) => r.status !== "cancelled");
    }
    if (search.trim()) {
      const q = search.toLowerCase().trim();
      list = list.filter((r) => {
        const fields = [
          r.guestName,
          r.guestEmail,
          r.guestPhone,
          r.qamfReservationId,
          r.notes,
          r.dayofOrderLane,
          String(r.id),
        ];
        return fields.some((f) => f?.toLowerCase().includes(q));
      });
    }
    return list;
  }, [reservations, search, hideCancelled]);

  // Stats
  const active = filtered.filter((r) => r.status !== "cancelled");
  const cancelled = filtered.filter((r) => r.status === "cancelled");
  const totalCancelledAll = reservations.filter((r) => r.status === "cancelled").length;
  const totalDeposit = active.reduce((s, r) => s + r.depositCents, 0);
  const totalRevenue = active.reduce((s, r) => s + r.totalCents, 0);
  const totalPlayers = active.reduce((s, r) => s + (r.playerCount ?? 0), 0);

  function copyLink(r: Reservation) {
    const path = confirmPath(r);
    if (!path) return;
    const url = `${window.location.origin}${path}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopiedId(r.id);
      setTimeout(() => setCopiedId((prev) => (prev === r.id ? null : prev)), 1500);
    });
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        backgroundColor: "#0a1628",
        color: "#fff",
        fontFamily: "system-ui, -apple-system, sans-serif",
        padding: "1rem",
      }}
    >
      {/* Header */}
      <div style={{ maxWidth: 1200, margin: "0 auto", marginBottom: "1.5rem" }}>
        <h1
          style={{
            fontSize: "1.5rem",
            fontWeight: 800,
            textTransform: "uppercase",
            letterSpacing: "0.05em",
            marginBottom: "1rem",
          }}
        >
          Bowling Reservations
        </h1>

        {/* Filters row */}
        <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", alignItems: "center" }}>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            style={INPUT_STYLE}
          />
          <select
            value={center}
            onChange={(e) => setCenter(e.target.value)}
            style={INPUT_STYLE}
          >
            <option value="">All Centers</option>
            <option value="TXBSQN0FEKQ11">Fort Myers</option>
            <option value="PPTR5G2N0QXF7">Naples</option>
          </select>
          <button
            type="button"
            onClick={() => setHideCancelled((v) => !v)}
            style={{
              ...NAV_BTN,
              fontSize: "0.75rem",
              fontWeight: 600,
              backgroundColor: hideCancelled ? "rgba(34,197,94,0.15)" : "rgba(255,255,255,0.08)",
              borderColor: hideCancelled ? "rgba(34,197,94,0.3)" : "rgba(255,255,255,0.15)",
              color: hideCancelled ? "#22c55e" : "rgba(255,255,255,0.6)",
            }}
          >
            {hideCancelled ? "Active Only" : "All Statuses"}
          </button>
          <button
            type="button"
            onClick={() => setDate(todayET())}
            style={{ ...NAV_BTN, fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 600 }}
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
          <span style={{ color: "rgba(255,255,255,0.4)", fontSize: "0.875rem" }}>
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
        {!loading && filtered.length > 0 && (
          <div
            style={{
              display: "flex",
              gap: "1.5rem",
              marginTop: "0.75rem",
              fontSize: "0.8rem",
              color: "rgba(255,255,255,0.5)",
              flexWrap: "wrap",
            }}
          >
            <span>
              <strong style={{ color: "#fff" }}>{active.length}</strong> active
              {totalCancelledAll > 0 && (
                <span style={{ color: "rgba(239,68,68,0.7)" }}>
                  {" "}+ {totalCancelledAll} cancelled{hideCancelled ? " (hidden)" : ""}
                </span>
              )}
            </span>
            <span>
              <strong style={{ color: "#fff" }}>{totalPlayers}</strong> bowlers
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

      {/* Content */}
      <div style={{ maxWidth: 1200, margin: "0 auto" }}>
        {loading ? (
          <div style={{ textAlign: "center", padding: "3rem", color: "rgba(255,255,255,0.4)" }}>
            Loading...
          </div>
        ) : error ? (
          <div
            style={{
              textAlign: "center",
              padding: "2rem",
              color: "#ef4444",
              backgroundColor: "rgba(239,68,68,0.1)",
              borderRadius: 12,
              border: "1px solid rgba(239,68,68,0.3)",
            }}
          >
            {error}
          </div>
        ) : filtered.length === 0 ? (
          <div style={{ textAlign: "center", padding: "3rem", color: "rgba(255,255,255,0.3)" }}>
            {search ? "No matching reservations." : "No reservations for this date."}
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: "0.8rem",
              }}
            >
              <thead>
                <tr
                  style={{
                    borderBottom: "1px solid rgba(255,255,255,0.1)",
                    textAlign: "left",
                  }}
                >
                  {["Time", "Guest", "Center", "Type", "Players", "Status", "Lane", "Deposit", "Total", "QAMF ID", "Link", "Notes"].map(
                    (h) => (
                      <th
                        key={h}
                        style={{
                          padding: "0.6rem 0.5rem",
                          color: "rgba(255,255,255,0.4)",
                          fontWeight: 600,
                          fontSize: "0.7rem",
                          textTransform: "uppercase",
                          letterSpacing: "0.05em",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {h}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => {
                  const isCancelled = r.status === "cancelled";
                  const rowOpacity = isCancelled ? 0.45 : 1;
                  return (
                    <tr
                      key={r.id}
                      style={{
                        borderBottom: "1px solid rgba(255,255,255,0.05)",
                        opacity: rowOpacity,
                      }}
                    >
                      {/* Time */}
                      <td style={{ padding: "0.6rem 0.5rem", whiteSpace: "nowrap" }}>
                        {fmtTime(r.bookedAt)}
                      </td>

                      {/* Guest */}
                      <td style={{ padding: "0.6rem 0.5rem" }}>
                        <div style={{ fontWeight: 600 }}>{r.guestName || "—"}</div>
                        {r.guestPhone && (
                          <div style={{ color: "rgba(255,255,255,0.35)", fontSize: "0.7rem" }}>
                            {r.guestPhone}
                          </div>
                        )}
                        {r.guestEmail && (
                          <div
                            style={{
                              color: "rgba(255,255,255,0.25)",
                              fontSize: "0.65rem",
                              maxWidth: 180,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {r.guestEmail}
                          </div>
                        )}
                      </td>

                      {/* Center */}
                      <td style={{ padding: "0.6rem 0.5rem", whiteSpace: "nowrap" }}>
                        {CENTERS[r.centerCode] ?? r.centerCode}
                      </td>

                      {/* Type */}
                      <td style={{ padding: "0.6rem 0.5rem", whiteSpace: "nowrap" }}>
                        <span
                          style={{
                            display: "inline-block",
                            padding: "0.15rem 0.5rem",
                            borderRadius: 6,
                            fontSize: "0.7rem",
                            fontWeight: 600,
                            textTransform: "uppercase",
                            letterSpacing: "0.03em",
                            backgroundColor:
                              r.productKind === "kbf"
                                ? "rgba(168,85,247,0.15)"
                                : "rgba(59,130,246,0.15)",
                            color: r.productKind === "kbf" ? "#a855f7" : "#3b82f6",
                            border: `1px solid ${
                              r.productKind === "kbf"
                                ? "rgba(168,85,247,0.3)"
                                : "rgba(59,130,246,0.3)"
                            }`,
                          }}
                        >
                          {r.productKind === "kbf" ? "KBF" : "Open"}
                        </span>
                      </td>

                      {/* Players */}
                      <td style={{ padding: "0.6rem 0.5rem", textAlign: "center" }}>
                        {r.playerCount ?? "—"}
                      </td>

                      {/* Status */}
                      <td style={{ padding: "0.6rem 0.5rem", whiteSpace: "nowrap" }}>
                        <span
                          style={{
                            display: "inline-block",
                            padding: "0.15rem 0.5rem",
                            borderRadius: 6,
                            fontSize: "0.7rem",
                            fontWeight: 600,
                            backgroundColor: `${STATUS_COLORS[r.status] ?? "#6b7280"}20`,
                            color: STATUS_COLORS[r.status] ?? "#6b7280",
                            border: `1px solid ${STATUS_COLORS[r.status] ?? "#6b7280"}40`,
                          }}
                        >
                          {STATUS_LABELS[r.status] ?? r.status}
                        </span>
                        {r.dayofOrderError && (
                          <div style={{ color: "#ef4444", fontSize: "0.65rem", marginTop: 2 }}>
                            {r.dayofOrderError}
                          </div>
                        )}
                      </td>

                      {/* Lane */}
                      <td
                        style={{
                          padding: "0.6rem 0.5rem",
                          textAlign: "center",
                          fontWeight: r.dayofOrderLane ? 700 : 400,
                          color: r.dayofOrderLane ? "#22c55e" : "rgba(255,255,255,0.2)",
                        }}
                      >
                        {r.dayofOrderLane ?? "—"}
                      </td>

                      {/* Deposit */}
                      <td style={{ padding: "0.6rem 0.5rem", whiteSpace: "nowrap" }}>
                        {r.depositCents > 0 ? dollars(r.depositCents) : "Free"}
                        {r.refundCents > 0 && (
                          <div style={{ color: "#ef4444", fontSize: "0.65rem" }}>
                            Refund {dollars(r.refundCents)}
                          </div>
                        )}
                      </td>

                      {/* Total */}
                      <td style={{ padding: "0.6rem 0.5rem", whiteSpace: "nowrap" }}>
                        {r.totalCents > 0 ? dollars(r.totalCents) : "Free"}
                      </td>

                      {/* QAMF ID */}
                      <td
                        style={{
                          padding: "0.6rem 0.5rem",
                          fontFamily: "monospace",
                          fontSize: "0.7rem",
                          color: "rgba(255,255,255,0.4)",
                        }}
                      >
                        {r.qamfReservationId ?? "—"}
                      </td>

                      {/* Confirmation link */}
                      <td style={{ padding: "0.6rem 0.5rem", whiteSpace: "nowrap" }}>
                        {confirmPath(r) ? (
                          <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                            <a
                              href={confirmPath(r)!}
                              target="_blank"
                              rel="noopener noreferrer"
                              style={{
                                color: "#60a5fa",
                                fontSize: "0.7rem",
                                textDecoration: "none",
                              }}
                            >
                              Open
                            </a>
                            <button
                              type="button"
                              onClick={() => copyLink(r)}
                              style={{
                                background: "none",
                                border: "none",
                                color: copiedId === r.id ? "#22c55e" : "rgba(255,255,255,0.3)",
                                cursor: "pointer",
                                fontSize: "0.65rem",
                                padding: "2px 4px",
                              }}
                            >
                              {copiedId === r.id ? "Copied!" : "Copy"}
                            </button>
                          </div>
                        ) : (
                          <span style={{ color: "rgba(255,255,255,0.15)", fontSize: "0.7rem" }}>—</span>
                        )}
                      </td>

                      {/* Notes */}
                      <td
                        style={{
                          padding: "0.6rem 0.5rem",
                          maxWidth: 200,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          color: "rgba(255,255,255,0.35)",
                          fontSize: "0.7rem",
                        }}
                        title={r.notes ?? ""}
                      >
                        {r.notes ?? ""}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
