"use client";

import { useCallback, useEffect, useState } from "react";

interface FailureRow {
  id: number;
  source: string;
  sourceRef: string;
  locationId: string;
  personId: string;
  depositKindId: string;
  amount: number;
  attempts: number;
  lastAttemptAt: string | null;
  lastError: string | null;
  createdAt: string;
  resolvedAt: string | null;
  resolvedDepositId: string | null;
  notes: string | null;
}

interface Summary {
  unresolvedCount: number;
  unresolvedAmountSum: number;
  oldestUnresolvedAt: string | null;
  bySource: { source: string; count: number }[];
}

interface ListResponse {
  unresolved: FailureRow[];
  resolved: FailureRow[];
  summary: Summary;
}

const KIND_LABEL: Record<string, string> = {
  "12744867": "Race Weekday",
  "12744871": "Race Anytime",
  "11260967": "Race Comp",
  "12754483": "Race Membership",
  "32442585": "License",
  "39228454": "TEST",
};

const SOURCE_LABEL: Record<string, string> = {
  "race-pack-square": "Race pack (Square)",
  "pov-claim": "POV claim",
  "manual": "Manual",
  "sales-log-backfill": "Backfill",
};

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York" });
  } catch {
    return iso;
  }
}

function fmtAmount(n: number, kindId: string): string {
  const sign = n > 0 ? "+" : "";
  const kind = KIND_LABEL[kindId] || `kind ${kindId}`;
  return `${sign}${n} ${kind}`;
}

export default function DepositFailuresClient({ token }: { token: string }) {
  const [data, setData] = useState<ListResponse | null>(null);
  const [includeResolved, setIncludeResolved] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busyIds, setBusyIds] = useState<Set<number>>(new Set());
  const [backfillBusy, setBackfillBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/admin/deposit-failures/list?token=${encodeURIComponent(token)}&include=${includeResolved ? "all" : "unresolved"}`,
        { cache: "no-store" },
      );
      if (!res.ok) {
        setToast(`List failed: HTTP ${res.status}`);
        return;
      }
      const json = (await res.json()) as ListResponse;
      setData(json);
    } catch (err) {
      setToast(err instanceof Error ? err.message : "load failed");
    } finally {
      setLoading(false);
    }
  }, [token, includeResolved]);

  useEffect(() => { load(); }, [load]);

  async function retryOne(id: number) {
    setBusyIds((prev) => new Set(prev).add(id));
    try {
      const res = await fetch(`/api/admin/deposit-failures/retry?token=${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const json = await res.json();
      if (res.ok && json.ok) {
        setToast(`Retry succeeded — depositId ${json.depositId ?? "(unknown)"}`);
      } else if (json.alreadyResolved) {
        setToast("Already resolved");
      } else {
        setToast(`Retry failed: ${json.error ?? "unknown"}`);
      }
      await load();
    } catch (err) {
      setToast(err instanceof Error ? err.message : "retry threw");
    } finally {
      setBusyIds((prev) => {
        const n = new Set(prev);
        n.delete(id);
        return n;
      });
    }
  }

  async function runBackfill() {
    if (!confirm("Import every sales_log row with deposit_credit_pending=TRUE into the retry queue?")) return;
    setBackfillBusy(true);
    try {
      const res = await fetch(`/api/admin/deposit-failures/backfill?token=${encodeURIComponent(token)}`, {
        method: "POST",
      });
      const json = await res.json();
      if (res.ok && json.ok) {
        setToast(`Backfill: scanned ${json.scanned}, enqueued ${json.enqueued}`);
      } else {
        setToast(`Backfill failed: ${json.error ?? "unknown"}`);
      }
      await load();
    } catch (err) {
      setToast(err instanceof Error ? err.message : "backfill threw");
    } finally {
      setBackfillBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#010A20] text-white p-6 sm:p-8">
      <div className="max-w-6xl mx-auto">
        <header className="flex flex-wrap items-baseline justify-between gap-3 mb-6">
          <div>
            <h1 className="text-2xl font-bold">BMI Deposit Failures</h1>
            <p className="text-white/60 text-sm mt-1">
              Race packs charged but no credits, POV claims that issued codes but didn&apos;t deduct.
              Sweep cron retries every 5 min — staff can also retry manually here.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={load}
              className="px-3 py-2 rounded-md bg-white/10 hover:bg-white/15 text-sm border border-white/10"
              disabled={loading}
            >
              {loading ? "Loading…" : "Refresh"}
            </button>
            <button
              type="button"
              onClick={runBackfill}
              className="px-3 py-2 rounded-md bg-purple-500/20 hover:bg-purple-500/30 text-purple-200 text-sm border border-purple-500/30"
              disabled={backfillBusy}
            >
              {backfillBusy ? "Backfilling…" : "Backfill from sales_log"}
            </button>
            <label className="flex items-center gap-2 text-xs text-white/60 ml-2 cursor-pointer">
              <input
                type="checkbox"
                checked={includeResolved}
                onChange={(e) => setIncludeResolved(e.target.checked)}
              />
              Show resolved (last 7d)
            </label>
          </div>
        </header>

        {toast && (
          <div className="mb-4 rounded-md border border-amber-500/30 bg-amber-500/5 px-4 py-2 text-sm text-amber-200 flex items-center justify-between">
            <span>{toast}</span>
            <button onClick={() => setToast(null)} className="text-amber-200/60 hover:text-amber-200">×</button>
          </div>
        )}

        {data && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
            <Stat label="Unresolved" value={data.summary.unresolvedCount} />
            <Stat label="Net amount" value={data.summary.unresolvedAmountSum} />
            <Stat
              label="Oldest"
              value={
                data.summary.oldestUnresolvedAt
                  ? new Date(data.summary.oldestUnresolvedAt).toLocaleDateString("en-US", { timeZone: "America/New_York" })
                  : "—"
              }
            />
            <Stat
              label="Sources"
              value={data.summary.bySource.map((s) => `${SOURCE_LABEL[s.source] ?? s.source}: ${s.count}`).join(", ") || "—"}
            />
          </div>
        )}

        {data && (
          <>
            <Section title={`Unresolved (${data.unresolved.length})`}>
              {data.unresolved.length === 0 ? (
                <p className="text-white/40 text-sm py-6 text-center">All clear — nothing to retry.</p>
              ) : (
                <Table
                  rows={data.unresolved}
                  busyIds={busyIds}
                  onRetry={retryOne}
                  showRetry
                />
              )}
            </Section>

            {includeResolved && (
              <Section title={`Resolved (last 7d, ${data.resolved.length})`} className="mt-8">
                {data.resolved.length === 0 ? (
                  <p className="text-white/40 text-sm py-6 text-center">No recent resolutions.</p>
                ) : (
                  <Table rows={data.resolved} busyIds={busyIds} onRetry={retryOne} showRetry={false} />
                )}
              </Section>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/5 p-4">
      <p className="text-white/40 text-xs uppercase tracking-wider mb-1">{label}</p>
      <p className="text-white text-lg font-semibold break-words">{value}</p>
    </div>
  );
}

function Section({ title, children, className }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={className}>
      <h2 className="text-sm font-semibold uppercase tracking-widest text-white/60 mb-3">{title}</h2>
      <div className="rounded-lg border border-white/10 bg-white/[0.02] overflow-x-auto">
        {children}
      </div>
    </section>
  );
}

function Table({ rows, busyIds, onRetry, showRetry }: {
  rows: FailureRow[];
  busyIds: Set<number>;
  onRetry: (id: number) => void;
  showRetry: boolean;
}) {
  return (
    <table className="w-full text-sm">
      <thead className="text-white/40 text-xs uppercase tracking-wider border-b border-white/10">
        <tr>
          <th className="px-3 py-2 text-left">Source</th>
          <th className="px-3 py-2 text-left">Person</th>
          <th className="px-3 py-2 text-left">Amount</th>
          <th className="px-3 py-2 text-left">Ref</th>
          <th className="px-3 py-2 text-left">Last error</th>
          <th className="px-3 py-2 text-left">Attempts</th>
          <th className="px-3 py-2 text-left">Created</th>
          {showRetry && <th className="px-3 py-2 text-right">Action</th>}
          {!showRetry && <th className="px-3 py-2 text-left">Resolved</th>}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id} className="border-b border-white/5 hover:bg-white/[0.02]">
            <td className="px-3 py-2">
              <span className="inline-block px-2 py-0.5 rounded bg-white/10 text-white/80 text-xs">
                {SOURCE_LABEL[r.source] ?? r.source}
              </span>
            </td>
            <td className="px-3 py-2 font-mono text-xs">{r.personId}</td>
            <td className="px-3 py-2">
              <span className={r.amount > 0 ? "text-emerald-300" : "text-amber-300"}>
                {fmtAmount(r.amount, r.depositKindId)}
              </span>
            </td>
            <td className="px-3 py-2 text-white/60 text-xs">{r.sourceRef}</td>
            <td className="px-3 py-2 text-white/60 text-xs max-w-[280px] truncate" title={r.lastError ?? undefined}>
              {r.lastError || "—"}
            </td>
            <td className="px-3 py-2 text-white/60 text-xs">{r.attempts}</td>
            <td className="px-3 py-2 text-white/60 text-xs">{fmtTime(r.createdAt)}</td>
            {showRetry && (
              <td className="px-3 py-2 text-right">
                <button
                  type="button"
                  onClick={() => onRetry(r.id)}
                  disabled={busyIds.has(r.id)}
                  className="px-2 py-1 rounded bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-200 text-xs border border-emerald-500/30 disabled:opacity-40"
                >
                  {busyIds.has(r.id) ? "…" : "Retry"}
                </button>
              </td>
            )}
            {!showRetry && (
              <td className="px-3 py-2 text-emerald-300/70 text-xs">{fmtTime(r.resolvedAt)}</td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
