"use client";

import { useCallback, useEffect, useState } from "react";

interface PendingQuote {
  id: number;
  contractShortId: string;
  reservationId: string;
  centerName: string;
  centerCode: string;
  brand: string;
  eventName: string;
  eventNumber: string;
  eventDate: string;
  eventDateDisplay: string;
  guestName: string;
  guestEmail: string;
  guestPhone: string | null;
  plannerName: string | null;
  plannerEmail: string | null;
  plannerPhone: string | null;
  notes: string | null;
  totalCents: number;
  taxCents: number;
  depositDueCents: number;
  balanceCents: number;
  lineItems: Array<{ name: string; qty: number; price: number; total: number }> | null;
  createdAt: string;
  approveUrl: string;
}

function dollars(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export default function GroupApprovalsClient({ token }: { token: string }) {
  const [quotes, setQuotes] = useState<PendingQuote[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionInFlight, setActionInFlight] = useState<number | null>(null);
  const [denyingId, setDenyingId] = useState<number | null>(null);
  const [denyReason, setDenyReason] = useState("");
  const [actionResult, setActionResult] = useState<{ id: number; msg: string; ok: boolean } | null>(
    null,
  );

  const load = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/admin/group-functions/pending-approvals?token=${encodeURIComponent(token)}`,
        { cache: "no-store" },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setQuotes(data.quotes ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const id = setInterval(() => void load(), 30_000);
    return () => clearInterval(id);
  }, [load]);

  async function handleApprove(q: PendingQuote) {
    setActionInFlight(q.id);
    setActionResult(null);
    try {
      const res = await fetch("/api/group-function/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shortId: q.contractShortId,
          action: "approve",
          email: "eric@headpinz.com",
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setActionResult({ id: q.id, msg: "Approved — contract sent to customer", ok: true });
      setQuotes((prev) => prev.filter((x) => x.id !== q.id));
    } catch (err) {
      setActionResult({ id: q.id, msg: err instanceof Error ? err.message : "Failed", ok: false });
    } finally {
      setActionInFlight(null);
    }
  }

  async function handleDeny(q: PendingQuote) {
    if (!denyReason.trim()) return;
    setActionInFlight(q.id);
    setActionResult(null);
    try {
      const res = await fetch("/api/group-function/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shortId: q.contractShortId,
          action: "deny",
          email: "eric@headpinz.com",
          reason: denyReason.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setActionResult({ id: q.id, msg: "Denied — planner notified", ok: true });
      setQuotes((prev) => prev.filter((x) => x.id !== q.id));
      setDenyingId(null);
      setDenyReason("");
    } catch (err) {
      setActionResult({ id: q.id, msg: err instanceof Error ? err.message : "Failed", ok: false });
    } finally {
      setActionInFlight(null);
    }
  }

  return (
    <div
      style={{
        maxWidth: 900,
        margin: "0 auto",
        padding: "1.5rem",
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        color: "#e2e8f0",
        backgroundColor: "#0f172a",
        minHeight: "100vh",
      }}
    >
      <h1 style={{ fontSize: "1.5rem", fontWeight: 700, marginBottom: "0.25rem" }}>
        Pending Approvals
      </h1>
      <p style={{ color: "#94a3b8", fontSize: "0.8rem", marginBottom: "1.5rem" }}>
        Post-paid group events awaiting management approval
      </p>

      {loading && <p style={{ color: "#94a3b8" }}>Loading...</p>}
      {error && <p style={{ color: "#ef4444" }}>Error: {error}</p>}

      {!loading && quotes.length === 0 && (
        <div
          style={{
            textAlign: "center",
            padding: "3rem 1rem",
            color: "#64748b",
          }}
        >
          <p style={{ fontSize: "1.1rem", marginBottom: "0.5rem" }}>No pending approvals</p>
          <p style={{ fontSize: "0.8rem" }}>Post-paid events will appear here when submitted</p>
        </div>
      )}

      {actionResult && (
        <div
          style={{
            padding: "0.75rem 1rem",
            borderRadius: 8,
            marginBottom: "1rem",
            backgroundColor: actionResult.ok ? "rgba(34,197,94,0.1)" : "rgba(239,68,68,0.1)",
            border: `1px solid ${actionResult.ok ? "rgba(34,197,94,0.3)" : "rgba(239,68,68,0.3)"}`,
            color: actionResult.ok ? "#22c55e" : "#ef4444",
            fontSize: "0.85rem",
          }}
        >
          {actionResult.msg}
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
        {quotes.map((q) => (
          <div
            key={q.id}
            style={{
              border: "1px solid rgba(148,163,184,0.2)",
              borderRadius: 10,
              padding: "1.25rem",
              backgroundColor: "rgba(30,41,59,0.5)",
            }}
          >
            {/* Header */}
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "flex-start",
                marginBottom: "1rem",
              }}
            >
              <div>
                <div style={{ fontSize: "1.1rem", fontWeight: 700 }}>{q.eventName}</div>
                <div style={{ color: "#94a3b8", fontSize: "0.8rem", marginTop: 2 }}>
                  #{q.eventNumber} · {q.centerName} · {q.eventDateDisplay || q.eventDate}
                </div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: "1.25rem", fontWeight: 700, color: "#f59e0b" }}>
                  {dollars(q.totalCents)}
                </div>
                <div style={{ color: "#64748b", fontSize: "0.7rem" }}>{timeAgo(q.createdAt)}</div>
              </div>
            </div>

            {/* Guest + Planner */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: "1rem",
                marginBottom: "1rem",
              }}
            >
              <div>
                <div
                  style={{
                    color: "#64748b",
                    fontSize: "0.65rem",
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                    marginBottom: 4,
                  }}
                >
                  Guest
                </div>
                <div style={{ fontWeight: 600 }}>{q.guestName}</div>
                <div style={{ color: "#94a3b8", fontSize: "0.8rem" }}>{q.guestEmail}</div>
                {q.guestPhone && (
                  <div style={{ color: "#94a3b8", fontSize: "0.8rem" }}>{q.guestPhone}</div>
                )}
              </div>
              <div>
                <div
                  style={{
                    color: "#64748b",
                    fontSize: "0.65rem",
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                    marginBottom: 4,
                  }}
                >
                  Planner
                </div>
                <div style={{ fontWeight: 600 }}>{q.plannerName || "—"}</div>
                {q.plannerEmail && (
                  <div style={{ color: "#94a3b8", fontSize: "0.8rem" }}>{q.plannerEmail}</div>
                )}
                {q.plannerPhone && (
                  <div style={{ color: "#94a3b8", fontSize: "0.8rem" }}>{q.plannerPhone}</div>
                )}
              </div>
            </div>

            {/* Line Items */}
            {q.lineItems && q.lineItems.length > 0 && (
              <div style={{ marginBottom: "1rem" }}>
                <div
                  style={{
                    color: "#64748b",
                    fontSize: "0.65rem",
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                    marginBottom: 6,
                  }}
                >
                  Products
                </div>
                <table style={{ width: "100%", fontSize: "0.8rem", borderCollapse: "collapse" }}>
                  <tbody>
                    {q.lineItems.map((item, i) => (
                      <tr key={i} style={{ borderBottom: "1px solid rgba(148,163,184,0.1)" }}>
                        <td style={{ padding: "4px 0" }}>{item.name}</td>
                        <td style={{ padding: "4px 0", textAlign: "center", color: "#94a3b8" }}>
                          x{item.qty}
                        </td>
                        <td
                          style={{ padding: "4px 0", textAlign: "right", fontFamily: "monospace" }}
                        >
                          ${item.total.toFixed(2)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "flex-end",
                    gap: "1.5rem",
                    marginTop: 6,
                    fontSize: "0.75rem",
                    color: "#94a3b8",
                  }}
                >
                  <span>Tax: {dollars(q.taxCents)}</span>
                  <span style={{ fontWeight: 700, color: "#e2e8f0" }}>
                    Total: {dollars(q.totalCents)}
                  </span>
                </div>
              </div>
            )}

            {/* Notes */}
            {q.notes && (
              <div style={{ marginBottom: "1rem" }}>
                <div
                  style={{
                    color: "#64748b",
                    fontSize: "0.65rem",
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                    marginBottom: 4,
                  }}
                >
                  Notes
                </div>
                <div style={{ color: "#94a3b8", fontSize: "0.8rem", whiteSpace: "pre-wrap" }}>
                  {q.notes}
                </div>
              </div>
            )}

            {/* Deny reason input */}
            {denyingId === q.id && (
              <div style={{ marginBottom: "1rem" }}>
                <input
                  type="text"
                  placeholder="Reason for denial..."
                  value={denyReason}
                  onChange={(e) => setDenyReason(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleDeny(q);
                  }}
                  autoFocus
                  style={{
                    width: "100%",
                    padding: "0.5rem 0.75rem",
                    borderRadius: 6,
                    border: "1px solid rgba(239,68,68,0.4)",
                    backgroundColor: "rgba(239,68,68,0.05)",
                    color: "#e2e8f0",
                    fontSize: "0.85rem",
                  }}
                />
              </div>
            )}

            {/* Actions */}
            <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
              {denyingId === q.id ? (
                <>
                  <button
                    onClick={() => {
                      setDenyingId(null);
                      setDenyReason("");
                    }}
                    style={{
                      padding: "0.5rem 1rem",
                      borderRadius: 6,
                      border: "1px solid rgba(148,163,184,0.3)",
                      backgroundColor: "transparent",
                      color: "#94a3b8",
                      fontSize: "0.8rem",
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => void handleDeny(q)}
                    disabled={!denyReason.trim() || actionInFlight === q.id}
                    style={{
                      padding: "0.5rem 1.25rem",
                      borderRadius: 6,
                      border: "none",
                      backgroundColor: !denyReason.trim() ? "rgba(239,68,68,0.2)" : "#ef4444",
                      color: "#fff",
                      fontSize: "0.8rem",
                      fontWeight: 700,
                      cursor: !denyReason.trim() ? "not-allowed" : "pointer",
                      opacity: actionInFlight === q.id ? 0.5 : 1,
                    }}
                  >
                    {actionInFlight === q.id ? "Denying..." : "Confirm Deny"}
                  </button>
                </>
              ) : (
                <>
                  <button
                    onClick={() => setDenyingId(q.id)}
                    disabled={actionInFlight === q.id}
                    style={{
                      padding: "0.5rem 1rem",
                      borderRadius: 6,
                      border: "1px solid rgba(239,68,68,0.4)",
                      backgroundColor: "rgba(239,68,68,0.1)",
                      color: "#ef4444",
                      fontSize: "0.8rem",
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    Deny
                  </button>
                  <button
                    onClick={() => void handleApprove(q)}
                    disabled={actionInFlight === q.id}
                    style={{
                      padding: "0.5rem 1.5rem",
                      borderRadius: 6,
                      border: "none",
                      backgroundColor: "#22c55e",
                      color: "#fff",
                      fontSize: "0.8rem",
                      fontWeight: 700,
                      cursor: "pointer",
                      opacity: actionInFlight === q.id ? 0.5 : 1,
                    }}
                  >
                    {actionInFlight === q.id ? "Approving..." : "Approve"}
                  </button>
                </>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
