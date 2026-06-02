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

function getWarnings(lineItems: PendingQuote["lineItems"]): { key: string; message: string }[] {
  const warnings: { key: string; message: string }[] = [];
  if (!lineItems?.some((item) => item.name.toLowerCase().includes("youth"))) {
    warnings.push({
      key: "no-youth",
      message: "No youth products on this event. Why is this a post-paid account?",
    });
  }
  if (lineItems?.some((item) => item.name.toLowerCase().includes("legacy"))) {
    warnings.push({
      key: "legacy",
      message: "Legacy product detected. This pricing may be outdated.",
    });
  }
  return warnings;
}

export default function GroupApprovalsClient({ token }: { token: string }) {
  const [quotes, setQuotes] = useState<PendingQuote[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionInFlight, setActionInFlight] = useState<number | null>(null);
  const [denyingId, setDenyingId] = useState<number | null>(null);
  const [denyReason, setDenyReason] = useState("");
  const [approvingId, setApprovingId] = useState<number | null>(null);
  const [approvalMemo, setApprovalMemo] = useState("");
  const [actionResult, setActionResult] = useState<{
    id: number;
    msg: string;
    ok: boolean;
  } | null>(null);

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

  async function handleApprove(q: PendingQuote, memo?: string) {
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
          memo: memo || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setActionResult({ id: q.id, msg: "Approved — contract sent to customer", ok: true });
      setQuotes((prev) => prev.filter((x) => x.id !== q.id));
      setApprovingId(null);
      setApprovalMemo("");
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
    <div className="min-h-screen bg-[#0f172a] text-slate-200 px-3 py-4 sm:px-6 sm:py-6">
      <div className="max-w-3xl mx-auto">
        <h1 className="text-xl sm:text-2xl font-bold mb-0.5">Pending Approvals</h1>
        <p className="text-slate-400 text-xs sm:text-sm mb-4">
          Post-paid group events awaiting management approval
        </p>

        {loading && <p className="text-slate-400 text-sm">Loading...</p>}
        {error && <p className="text-red-400 text-sm">Error: {error}</p>}

        {!loading && quotes.length === 0 && (
          <div className="text-center py-12 text-slate-500">
            <p className="text-base mb-1">No pending approvals</p>
            <p className="text-xs">Post-paid events will appear here when submitted</p>
          </div>
        )}

        {actionResult && (
          <div
            className={`rounded-lg px-3 py-2.5 mb-3 text-sm border ${
              actionResult.ok
                ? "bg-green-500/10 border-green-500/30 text-green-400"
                : "bg-red-500/10 border-red-500/30 text-red-400"
            }`}
          >
            {actionResult.msg}
          </div>
        )}

        <div className="space-y-3">
          {quotes.map((q) => (
            <div
              key={q.id}
              className="rounded-xl border border-white/10 bg-slate-800/50 overflow-hidden"
            >
              {/* Header tile — event name + total */}
              <div className="px-4 pt-4 pb-3 sm:flex sm:justify-between sm:items-start">
                <div className="mb-2 sm:mb-0">
                  <div className="text-base sm:text-lg font-bold leading-tight">{q.eventName}</div>
                  <div className="text-slate-400 text-xs mt-1">
                    #{q.eventNumber} · {q.centerName}
                  </div>
                  <div className="text-slate-400 text-xs">{q.eventDateDisplay || q.eventDate}</div>
                </div>
                <div className="flex sm:flex-col items-baseline sm:items-end gap-2 sm:gap-0">
                  <span className="text-xl sm:text-2xl font-bold text-amber-400">
                    {dollars(q.totalCents)}
                  </span>
                  <span className="text-slate-500 text-[10px] sm:text-xs">
                    {timeAgo(q.createdAt)}
                  </span>
                </div>
              </div>

              {/* Guest + Planner — stacks on mobile */}
              <div className="px-4 pb-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <div className="text-slate-500 text-[10px] uppercase tracking-wider font-semibold mb-1">
                    Guest
                  </div>
                  <div className="font-semibold text-sm">{q.guestName}</div>
                  <div className="text-slate-400 text-xs truncate">{q.guestEmail}</div>
                  {q.guestPhone && <div className="text-slate-400 text-xs">{q.guestPhone}</div>}
                </div>
                <div>
                  <div className="text-slate-500 text-[10px] uppercase tracking-wider font-semibold mb-1">
                    Planner
                  </div>
                  <div className="font-semibold text-sm">{q.plannerName || "—"}</div>
                  {q.plannerEmail && (
                    <div className="text-slate-400 text-xs truncate">{q.plannerEmail}</div>
                  )}
                  {q.plannerPhone && <div className="text-slate-400 text-xs">{q.plannerPhone}</div>}
                </div>
              </div>

              {/* Line items */}
              {q.lineItems && q.lineItems.length > 0 && (
                <div className="px-4 pb-3">
                  <div className="text-slate-500 text-[10px] uppercase tracking-wider font-semibold mb-1.5">
                    Products
                  </div>
                  <div className="space-y-1">
                    {q.lineItems.map((item, i) => (
                      <div
                        key={i}
                        className="flex justify-between text-xs border-b border-white/5 pb-1"
                      >
                        <span className="truncate mr-2">{item.name}</span>
                        <span className="flex gap-3 shrink-0 text-slate-400">
                          <span>x{item.qty}</span>
                          <span className="font-mono text-slate-300 w-16 text-right">
                            ${item.total.toFixed(2)}
                          </span>
                        </span>
                      </div>
                    ))}
                  </div>
                  <div className="flex justify-end gap-4 mt-2 text-xs text-slate-400">
                    <span>Tax: {dollars(q.taxCents)}</span>
                    <span className="font-bold text-slate-200">Total: {dollars(q.totalCents)}</span>
                  </div>
                </div>
              )}

              {/* Notes */}
              {q.notes && (
                <div className="px-4 pb-3">
                  <div className="text-slate-500 text-[10px] uppercase tracking-wider font-semibold mb-1">
                    Notes
                  </div>
                  <div className="text-slate-400 text-xs whitespace-pre-wrap leading-relaxed">
                    {q.notes}
                  </div>
                </div>
              )}

              {/* Warnings */}
              {(() => {
                const w = getWarnings(q.lineItems);
                return w.length > 0 ? (
                  <div className="px-4 pb-3 space-y-2">
                    {w.map((warn) => (
                      <div
                        key={warn.key}
                        className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300"
                      >
                        <span className="font-bold text-red-400">Warning: </span>
                        {warn.message}
                      </div>
                    ))}
                  </div>
                ) : null;
              })()}

              {/* Deny reason input */}
              {denyingId === q.id && (
                <div className="px-4 pb-3">
                  <input
                    type="text"
                    placeholder="Reason for denial..."
                    value={denyReason}
                    onChange={(e) => setDenyReason(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void handleDeny(q);
                    }}
                    ref={(el) => el?.focus()}
                    className="w-full px-3 py-2 rounded-lg border border-red-500/40 bg-red-500/5 text-slate-200 text-sm outline-none focus:border-red-400"
                  />
                </div>
              )}

              {/* Approval memo input */}
              {approvingId === q.id && (
                <div className="px-4 pb-3">
                  <textarea
                    placeholder="Acknowledge warnings and explain why this approval is appropriate..."
                    value={approvalMemo}
                    onChange={(e) => setApprovalMemo(e.target.value)}
                    rows={2}
                    ref={(el) => el?.focus()}
                    className="w-full px-3 py-2 rounded-lg border border-amber-500/40 bg-amber-500/5 text-slate-200 text-sm outline-none focus:border-amber-400"
                  />
                </div>
              )}

              {/* Action buttons */}
              <div className="px-4 pb-4 flex gap-2 justify-end">
                {denyingId === q.id ? (
                  <>
                    <button
                      onClick={() => {
                        setDenyingId(null);
                        setDenyReason("");
                      }}
                      className="px-4 py-2 rounded-lg border border-white/15 text-slate-400 text-sm font-semibold hover:bg-white/5 transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={() => void handleDeny(q)}
                      disabled={!denyReason.trim() || actionInFlight === q.id}
                      className="px-5 py-2 rounded-lg bg-red-500 text-white text-sm font-bold disabled:opacity-40 disabled:cursor-not-allowed hover:bg-red-600 transition-colors"
                    >
                      {actionInFlight === q.id ? "Denying..." : "Confirm Deny"}
                    </button>
                  </>
                ) : approvingId === q.id ? (
                  <>
                    <button
                      onClick={() => {
                        setApprovingId(null);
                        setApprovalMemo("");
                      }}
                      className="px-4 py-2 rounded-lg border border-white/15 text-slate-400 text-sm font-semibold hover:bg-white/5 transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={() => void handleApprove(q, approvalMemo)}
                      disabled={!approvalMemo.trim() || actionInFlight === q.id}
                      className="px-5 py-2 rounded-lg bg-green-500 text-white text-sm font-bold disabled:opacity-40 disabled:cursor-not-allowed hover:bg-green-600 transition-colors"
                    >
                      {actionInFlight === q.id ? "Approving..." : "Confirm Approve"}
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      onClick={() => setDenyingId(q.id)}
                      disabled={actionInFlight === q.id}
                      className="px-4 py-2 rounded-lg border border-red-500/40 bg-red-500/10 text-red-400 text-sm font-semibold hover:bg-red-500/20 transition-colors"
                    >
                      Deny
                    </button>
                    <button
                      onClick={() => {
                        const w = getWarnings(q.lineItems);
                        if (w.length > 0) {
                          setApprovingId(q.id);
                        } else {
                          void handleApprove(q);
                        }
                      }}
                      disabled={actionInFlight === q.id}
                      className="px-6 py-2 rounded-lg bg-green-500 text-white text-sm font-bold disabled:opacity-50 hover:bg-green-600 transition-colors"
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
    </div>
  );
}
