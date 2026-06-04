"use client";

import { useCallback, useEffect, useState } from "react";
import { modalBackdropProps } from "@/lib/a11y";

interface GfQuote {
  id: number;
  reservationId: string;
  centerName: string;
  centerCode: string;
  eventName: string;
  eventNumber: string;
  eventDate: string;
  eventDateDisplay: string;
  guestName: string;
  guestEmail: string;
  guestPhone: string | null;
  plannerName: string | null;
  status: string;
  contractShortId: string | null;
  contractStatus: string | null;
  totalCents: number;
  depositDueCents: number;
  balanceCents: number;
  giftCardGan: string | null;
  squareDayofOrderId: string | null;
  depositPaidAt: string | null;
  balancePaidAt: string | null;
  balancePaymentMethod: string | null;
  balancePaymentLinkUrl: string | null;
  createdAt: string;
}

const STATUS_COLORS: Record<string, string> = {
  pending: "#f59e0b",
  contract_sent: "#3b82f6",
  deposit_paid: "#22c55e",
  balance_charged: "#10b981",
  balance_link_sent: "#8b5cf6",
  completed: "#6b7280",
  cancelled: "#ef4444",
  expired: "#9ca3af",
};

const STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  contract_sent: "Contract Sent",
  deposit_paid: "Deposit Paid",
  balance_charged: "Fully Paid",
  balance_link_sent: "Balance Link Sent",
  completed: "Completed",
  cancelled: "Cancelled",
  expired: "Expired",
};

function dollars(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
}

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}

interface VersionEntry {
  versionNumber: number;
  changes: string[];
  trigger: string;
  createdAt: string;
  diffs: Array<{ field: string; label: string; before: string; after: string }>;
}

export default function GroupFunctionsClient({ token }: { token: string }) {
  const [quotes, setQuotes] = useState<GfQuote[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [historyQuoteId, setHistoryQuoteId] = useState<number | null>(null);
  const [versions, setVersions] = useState<VersionEntry[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(false);

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams({ token });
      if (statusFilter !== "all") params.set("status", statusFilter);
      const res = await fetch(`/api/admin/group-functions?${params}`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setQuotes(data.quotes ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
      setQuotes([]);
    } finally {
      setLoading(false);
    }
  }, [token, statusFilter]);

  const loadVersions = useCallback(
    async (quoteId: number) => {
      setHistoryQuoteId(quoteId);
      setVersionsLoading(true);
      try {
        const res = await fetch(
          `/api/admin/group-functions/versions?token=${token}&quoteId=${quoteId}`,
        );
        if (res.ok) {
          const data = await res.json();
          setVersions(data.versions ?? []);
        }
      } catch {
        /* */
      }
      setVersionsLoading(false);
    },
    [token],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const id = setInterval(() => void load(), 30_000);
    return () => clearInterval(id);
  }, [load]);

  const filtered = search
    ? quotes.filter(
        (q) =>
          q.guestName.toLowerCase().includes(search.toLowerCase()) ||
          q.eventName?.toLowerCase().includes(search.toLowerCase()) ||
          q.guestEmail?.toLowerCase().includes(search.toLowerCase()) ||
          q.giftCardGan?.toLowerCase().includes(search.toLowerCase()) ||
          q.reservationId.includes(search),
      )
    : quotes;

  const statusCounts: Record<string, number> = {};
  for (const q of quotes) {
    statusCounts[q.status] = (statusCounts[q.status] || 0) + 1;
  }

  const totalDeposits = filtered
    .filter((q) => q.depositPaidAt)
    .reduce((s, q) => s + q.depositDueCents, 0);
  const totalBalance = filtered.reduce((s, q) => s + q.balanceCents, 0);

  return (
    <div
      style={{
        maxWidth: 1400,
        margin: "0 auto",
        padding: "1.5rem",
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        color: "#e2e8f0",
        backgroundColor: "#0f172a",
        minHeight: "100vh",
      }}
    >
      <h1
        style={{
          fontSize: "1.5rem",
          fontWeight: 700,
          marginBottom: "1rem",
        }}
      >
        Group Functions
      </h1>

      {/* Filters */}
      <div
        style={{
          display: "flex",
          gap: "0.5rem",
          flexWrap: "wrap",
          marginBottom: "1rem",
        }}
      >
        {[
          "all",
          "pending",
          "contract_sent",
          "deposit_paid",
          "balance_charged",
          "balance_link_sent",
          "completed",
        ].map((s) => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            style={{
              padding: "0.25rem 0.75rem",
              borderRadius: 6,
              border: `1px solid ${statusFilter === s ? "rgba(34,197,94,0.5)" : "rgba(148,163,184,0.3)"}`,
              backgroundColor: statusFilter === s ? "rgba(34,197,94,0.15)" : "transparent",
              color: statusFilter === s ? "#22c55e" : "#94a3b8",
              fontSize: "0.75rem",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {s === "all" ? "All" : STATUS_LABELS[s] || s}
            {s === "all" ? ` (${quotes.length})` : statusCounts[s] ? ` (${statusCounts[s]})` : ""}
          </button>
        ))}
      </div>

      {/* Search */}
      <input
        type="text"
        placeholder="Search name, email, event, GAN..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        style={{
          width: "100%",
          maxWidth: 400,
          padding: "0.5rem 0.75rem",
          borderRadius: 6,
          border: "1px solid rgba(148,163,184,0.3)",
          backgroundColor: "rgba(15,23,42,0.8)",
          color: "#e2e8f0",
          fontSize: "0.875rem",
          marginBottom: "1rem",
        }}
      />

      {/* Stats */}
      {!loading && filtered.length > 0 && (
        <div
          style={{
            display: "flex",
            gap: "1.5rem",
            fontSize: "0.8rem",
            color: "#94a3b8",
            marginBottom: "1rem",
          }}
        >
          <span>
            <strong style={{ color: "#e2e8f0" }}>{filtered.length}</strong> quotes
          </span>
          <span>
            Deposits <strong style={{ color: "#22c55e" }}>{dollars(totalDeposits)}</strong>
          </span>
          <span>
            Balance due <strong style={{ color: "#f59e0b" }}>{dollars(totalBalance)}</strong>
          </span>
        </div>
      )}

      {loading && <p style={{ color: "#94a3b8" }}>Loading...</p>}
      {error && <p style={{ color: "#ef4444" }}>Error: {error}</p>}

      {/* Table */}
      {!loading && filtered.length > 0 && (
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
                  borderBottom: "1px solid rgba(148,163,184,0.2)",
                  color: "#94a3b8",
                  textTransform: "uppercase",
                  fontSize: "0.65rem",
                  letterSpacing: "0.05em",
                }}
              >
                <th style={{ padding: "0.5rem", textAlign: "left" }}>Event</th>
                <th style={{ padding: "0.5rem", textAlign: "left" }}>Guest</th>
                <th style={{ padding: "0.5rem", textAlign: "left" }}>Status</th>
                <th style={{ padding: "0.5rem", textAlign: "right" }}>Total</th>
                <th style={{ padding: "0.5rem", textAlign: "right" }}>Deposit</th>
                <th style={{ padding: "0.5rem", textAlign: "right" }}>Balance</th>
                <th style={{ padding: "0.5rem", textAlign: "left" }}>GAN</th>
                <th style={{ padding: "0.5rem", textAlign: "left" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((q) => (
                <tr
                  key={q.id}
                  style={{
                    borderBottom: "1px solid rgba(148,163,184,0.1)",
                  }}
                >
                  <td style={{ padding: "0.5rem" }}>
                    <div style={{ fontWeight: 600 }}>{q.eventName}</div>
                    <div style={{ color: "#94a3b8", fontSize: "0.7rem" }}>
                      {q.eventDateDisplay || fmtDate(q.eventDate)} · {q.centerName}
                    </div>
                    <div style={{ color: "#64748b", fontSize: "0.65rem" }}>#{q.eventNumber}</div>
                  </td>
                  <td style={{ padding: "0.5rem" }}>
                    <div>{q.guestName}</div>
                    <div style={{ color: "#94a3b8", fontSize: "0.7rem" }}>{q.guestEmail}</div>
                  </td>
                  <td style={{ padding: "0.5rem" }}>
                    <span
                      style={{
                        display: "inline-block",
                        padding: "2px 8px",
                        borderRadius: 4,
                        fontSize: "0.65rem",
                        fontWeight: 600,
                        backgroundColor: `${STATUS_COLORS[q.status] || "#6b7280"}20`,
                        color: STATUS_COLORS[q.status] || "#6b7280",
                        border: `1px solid ${STATUS_COLORS[q.status] || "#6b7280"}40`,
                      }}
                    >
                      {STATUS_LABELS[q.status] || q.status}
                    </span>
                    {q.contractStatus && q.contractStatus !== q.status && (
                      <div
                        style={{
                          fontSize: "0.6rem",
                          color: "#64748b",
                          marginTop: 2,
                        }}
                      >
                        Contract: {q.contractStatus}
                      </div>
                    )}
                  </td>
                  <td
                    style={{
                      padding: "0.5rem",
                      textAlign: "right",
                      fontWeight: 600,
                    }}
                  >
                    {dollars(q.totalCents)}
                  </td>
                  <td
                    style={{
                      padding: "0.5rem",
                      textAlign: "right",
                      color: q.depositPaidAt ? "#22c55e" : "#94a3b8",
                    }}
                  >
                    {dollars(q.depositDueCents)}
                  </td>
                  <td
                    style={{
                      padding: "0.5rem",
                      textAlign: "right",
                      color: q.balanceCents > 0 ? "#f59e0b" : "#22c55e",
                    }}
                  >
                    {dollars(q.balanceCents)}
                  </td>
                  <td
                    style={{
                      padding: "0.5rem",
                      fontFamily: "monospace",
                      fontSize: "0.7rem",
                      color: "#00e2e5",
                    }}
                  >
                    {q.giftCardGan || "—"}
                  </td>
                  <td style={{ padding: "0.5rem" }}>
                    <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                      {q.contractShortId && (
                        <a
                          href={`/contract/${q.contractShortId}`}
                          target="_blank"
                          rel="noopener"
                          style={{
                            padding: "2px 8px",
                            borderRadius: 4,
                            fontSize: "0.65rem",
                            fontWeight: 600,
                            backgroundColor: "rgba(59,130,246,0.15)",
                            color: "#3b82f6",
                            border: "1px solid rgba(59,130,246,0.3)",
                            textDecoration: "none",
                          }}
                        >
                          VIEW
                        </a>
                      )}
                      {q.balancePaymentLinkUrl && (
                        <a
                          href={q.balancePaymentLinkUrl}
                          target="_blank"
                          rel="noopener"
                          style={{
                            padding: "2px 8px",
                            borderRadius: 4,
                            fontSize: "0.65rem",
                            fontWeight: 600,
                            backgroundColor: "rgba(139,92,246,0.15)",
                            color: "#8b5cf6",
                            border: "1px solid rgba(139,92,246,0.3)",
                            textDecoration: "none",
                          }}
                        >
                          PAY LINK
                        </a>
                      )}
                      <button
                        onClick={() => loadVersions(q.id)}
                        style={{
                          padding: "2px 8px",
                          borderRadius: 4,
                          fontSize: "0.65rem",
                          fontWeight: 600,
                          backgroundColor: "rgba(245,158,11,0.15)",
                          color: "#f59e0b",
                          border: "1px solid rgba(245,158,11,0.3)",
                          cursor: "pointer",
                        }}
                      >
                        HISTORY
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!loading && filtered.length === 0 && (
        <p style={{ color: "#64748b", textAlign: "center", marginTop: "2rem" }}>
          No group function quotes found.
        </p>
      )}

      {/* Version History Modal */}
      {historyQuoteId !== null && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            backgroundColor: "rgba(0,0,0,0.7)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 50,
          }}
          {...modalBackdropProps(() => setHistoryQuoteId(null))}
        >
          <div
            style={{
              backgroundColor: "#1e293b",
              borderRadius: 12,
              border: "1px solid rgba(148,163,184,0.2)",
              maxWidth: 600,
              width: "90%",
              maxHeight: "80vh",
              overflowY: "auto",
              padding: "1.5rem",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: "1rem",
              }}
            >
              <h2 style={{ fontSize: "1.1rem", fontWeight: 700 }}>
                Contract History — Quote #{historyQuoteId}
              </h2>
              <button
                onClick={() => setHistoryQuoteId(null)}
                style={{
                  color: "#94a3b8",
                  fontSize: "1.2rem",
                  cursor: "pointer",
                  background: "none",
                  border: "none",
                }}
              >
                ✕
              </button>
            </div>

            {versionsLoading && <p style={{ color: "#94a3b8" }}>Loading...</p>}

            {!versionsLoading && versions.length === 0 && (
              <p style={{ color: "#64748b" }}>No version history recorded yet.</p>
            )}

            {!versionsLoading && versions.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
                {versions.map((v) => (
                  <div
                    key={v.versionNumber}
                    style={{
                      padding: "0.75rem",
                      borderRadius: 8,
                      backgroundColor: "rgba(15,23,42,0.6)",
                      border: "1px solid rgba(148,163,184,0.1)",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        marginBottom: "0.5rem",
                      }}
                    >
                      <span style={{ fontWeight: 600, fontSize: "0.85rem" }}>
                        Version {v.versionNumber}
                      </span>
                      <span style={{ fontSize: "0.7rem", color: "#64748b" }}>
                        {new Date(v.createdAt).toLocaleString("en-US", {
                          month: "short",
                          day: "numeric",
                          hour: "numeric",
                          minute: "2-digit",
                        })}
                        {" · "}
                        {v.trigger}
                      </span>
                    </div>

                    {v.diffs.length > 0 && (
                      <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
                        {v.diffs.map((d, i) => (
                          <div key={i} style={{ fontSize: "0.75rem" }}>
                            <span style={{ color: "#94a3b8" }}>{d.label}: </span>
                            <span style={{ color: "#ef4444", textDecoration: "line-through" }}>
                              {d.before}
                            </span>
                            <span style={{ color: "#64748b" }}> → </span>
                            <span style={{ color: "#22c55e" }}>{d.after}</span>
                          </div>
                        ))}
                      </div>
                    )}

                    {v.diffs.length === 0 && v.changes.length > 0 && (
                      <div style={{ fontSize: "0.75rem", color: "#94a3b8" }}>
                        {v.changes.join(", ")}
                      </div>
                    )}

                    {v.diffs.length === 0 && v.changes.length === 0 && (
                      <div style={{ fontSize: "0.75rem", color: "#64748b" }}>Initial version</div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
