"use client";

import { useCallback, useEffect, useState } from "react";
import { modalBackdropProps } from "@/lib/a11y";
import type { SmsLogEntry } from "@/lib/sms-log";

type EnrichedLogEntry = SmsLogEntry & {
  racerNames: string[];
  track?: string;
  heatNumber?: number;
  raceType?: string;
  scheduledStart?: string;
};

type ListResponse = {
  date: string;
  total: number;
  returned: number;
  entries: EnrichedLogEntry[];
};

function todayYmd(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

function formatEt(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-US", {
      timeZone: "America/New_York",
      hour: "numeric", minute: "2-digit", hour12: true,
    });
  } catch {
    return iso;
  }
}

function sourceLabel(s: string): string {
  if (s === "pre-race-cron") return "eTicket";
  if (s === "checkin-cron") return "check-in";
  if (s === "admin-resend") return "resend";
  return s;
}

export default function EticketAdminClient({ token }: { token: string }) {
  const [date, setDate] = useState(todayYmd());
  const [source, setSource] = useState<"" | "pre-race-cron" | "checkin-cron" | "admin-resend">("");
  const [q, setQ] = useState("");
  const [entries, setEntries] = useState<EnrichedLogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resendTarget, setResendTarget] = useState<EnrichedLogEntry | null>(null);
  const [flash, setFlash] = useState<{ shortCode: string; msg: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ date, limit: "200", token });
      if (source) qs.set("source", source);
      if (q) qs.set("q", q);
      const res = await fetch(`/api/admin/e-tickets/list?${qs.toString()}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`list failed: ${res.status}`);
      const json = (await res.json()) as ListResponse;
      setEntries(json.entries || []);
      setTotal(json.total || 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to load");
    } finally {
      setLoading(false);
    }
  }, [date, source, q, token]);

  useEffect(() => {
    const t = setTimeout(load, 250); // small debounce for typing
    return () => clearTimeout(t);
  }, [load]);

  return (
    <div className="min-h-screen bg-[#0a1128] text-white">
      <div className="max-w-7xl mx-auto p-4 sm:p-6">
        <header className="mb-5">
          <h1 className="text-2xl font-bold uppercase tracking-wider">E-Ticket Admin</h1>
          <p className="text-white/50 text-sm mt-1">
            Audit and resend SMS e-tickets. Entries below are ordered newest first.
          </p>
        </header>

        {/* Filter bar */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
          <label className="flex flex-col gap-1 text-xs text-white/60">
            Date
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="bg-white/5 border border-white/10 rounded px-2 py-1.5 text-sm text-white"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-white/60">
            Source
            <select
              value={source}
              onChange={(e) => setSource(e.target.value as typeof source)}
              className="bg-white/5 border border-white/10 rounded px-2 py-1.5 text-sm text-white"
            >
              <option value="" style={{ backgroundColor: "#0a1128" }}>All</option>
              <option value="pre-race-cron" style={{ backgroundColor: "#0a1128" }}>eTicket (2hr ahead)</option>
              <option value="checkin-cron" style={{ backgroundColor: "#0a1128" }}>check-in (live)</option>
              <option value="admin-resend" style={{ backgroundColor: "#0a1128" }}>admin resends</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-white/60 col-span-2">
            Search (racer name, phone digits, shortCode)
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="e.g. racer name  or  2399863727"
              className="bg-white/5 border border-white/10 rounded px-2 py-1.5 text-sm text-white placeholder:text-white/30"
            />
          </label>
        </div>

        {/* Summary line */}
        <div className="flex items-center justify-between mb-2 text-xs text-white/50">
          <span>
            {loading ? "Loading…" : `${total} match${total === 1 ? "" : "es"}`}
            {error && <span className="ml-2 text-red-400">· {error}</span>}
          </span>
          <button
            type="button"
            onClick={load}
            className="text-[#00E2E5] hover:underline"
          >
            Refresh
          </button>
        </div>

        {/* Results table */}
        <div className="rounded-lg border border-white/10 bg-white/[0.02] overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-white/5 text-xs uppercase text-white/50">
                <tr>
                  <th className="text-left px-3 py-2">Time (ET)</th>
                  <th className="text-left px-3 py-2">Source</th>
                  <th className="text-left px-3 py-2">Racer</th>
                  <th className="text-left px-3 py-2">Phone</th>
                  <th className="text-left px-3 py-2">Race</th>
                  <th className="text-left px-3 py-2">Status</th>
                  <th className="px-3 py-2"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {entries.length === 0 && !loading && (
                  <tr><td colSpan={7} className="text-center text-white/40 py-8">No SMS log entries match.</td></tr>
                )}
                {entries.map((e) => {
                  const flashHere = flash?.shortCode === e.shortCode;
                  return (
                    <tr
                      key={`${e.ts}-${e.phone}-${e.shortCode ?? ""}`}
                      className={`border-t border-white/5 ${flashHere ? "bg-emerald-500/10" : ""}`}
                    >
                      <td className="px-3 py-2 whitespace-nowrap text-white/70">{formatEt(e.ts)}</td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <span className={`text-xs uppercase px-1.5 py-0.5 rounded ${
                          e.source === "pre-race-cron" ? "bg-blue-500/20 text-blue-300"
                          : e.source === "checkin-cron" ? "bg-emerald-500/20 text-emerald-300"
                          : e.source === "admin-resend" ? "bg-amber-500/20 text-amber-300"
                          : "bg-white/10 text-white/60"
                        }`}>
                          {sourceLabel(e.source)}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        {e.racerNames.length > 0
                          ? e.racerNames.join(", ")
                          : <span className="text-white/30 italic">(no ticket)</span>}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap font-mono text-xs">{e.phone}</td>
                      <td className="px-3 py-2 whitespace-nowrap text-white/70">
                        {e.track && e.heatNumber ? `${e.track} · Heat ${e.heatNumber}` : ""}
                        {e.raceType && <span className="text-white/40 ml-1">· {e.raceType}</span>}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {e.ok
                          ? <span className="text-emerald-400 text-xs">sent</span>
                          : <span className="text-red-400 text-xs">failed ({e.status ?? "?"})</span>}
                        {flashHere && <span className="text-emerald-400 text-xs ml-2">· {flash!.msg}</span>}
                      </td>
                      <td className="px-3 py-2">
                        <button
                          type="button"
                          onClick={() => setResendTarget(e)}
                          disabled={!e.shortCode || !e.body}
                          className="text-xs px-2 py-1 rounded bg-[#00E2E5] text-[#000418] font-semibold hover:bg-white disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          Resend
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* Resend modal */}
        {resendTarget && (
          <ResendModal
            entry={resendTarget}
            token={token}
            onClose={() => setResendTarget(null)}
            onSuccess={(msg) => {
              if (resendTarget.shortCode) {
                setFlash({ shortCode: resendTarget.shortCode, msg });
                setTimeout(() => setFlash(null), 4000);
              }
              setResendTarget(null);
              load();
            }}
          />
        )}
      </div>
    </div>
  );
}

function ResendModal({
  entry,
  token,
  onClose,
  onSuccess,
}: {
  entry: EnrichedLogEntry;
  token: string;
  onClose: () => void;
  onSuccess: (msg: string) => void;
}) {
  const [phone, setPhone] = useState(entry.phone || "");
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    if (!entry.shortCode) { setErr("No shortCode on this entry — can't resend."); return; }
    if (!entry.body) { setErr("No body text — can't resend."); return; }
    setSending(true);
    setErr(null);
    try {
      const res = await fetch("/api/admin/e-tickets/resend", {
        method: "POST",
        headers: { "content-type": "application/json", "x-admin-token": token },
        body: JSON.stringify({
          shortCode: entry.shortCode,
          body: entry.body,
          overridePhone: phone !== entry.phone ? phone : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || `send failed (${res.status})`);
      }
      onSuccess(`resent to ${data.sentTo}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "failed");
    } finally {
      setSending(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center p-3 bg-black/80"
      style={{ height: "100dvh" }}
      {...modalBackdropProps(onClose)}
    >
      <div
        className="relative w-full max-w-lg rounded-xl"
        style={{ backgroundColor: "#0a1128", border: "1.78px solid rgba(255,255,255,0.1)", maxHeight: "calc(100dvh - 1.5rem)", overflowY: "auto" }}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close dialog"
          className="absolute top-3 right-3 z-10 w-8 h-8 flex items-center justify-center rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors"
          style={{ fontSize: "20px", lineHeight: 1 }}
        >
          &times;
        </button>
        <div className="p-5 sm:p-6">
          <h3 className="text-lg font-bold uppercase tracking-wide mb-3 pr-10">Resend e-ticket</h3>
          <div className="text-xs text-white/50 mb-3 space-y-0.5">
            <div>Racer: <span className="text-white/80">{entry.racerNames.join(", ") || "(no ticket)"}</span></div>
            {entry.track && entry.heatNumber && (
              <div>Race: <span className="text-white/80">{entry.track} · Heat {entry.heatNumber}{entry.raceType ? ` · ${entry.raceType}` : ""}</span></div>
            )}
            <div>Originally sent: <span className="text-white/80">{formatEt(entry.ts)} · {entry.phone}</span></div>
          </div>

          <label className="flex flex-col gap-1 text-xs text-white/60 mb-3">
            Phone (edit to override)
            <input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="bg-white/5 border border-white/10 rounded px-2 py-1.5 text-sm text-white font-mono"
              placeholder="+12395551234"
            />
          </label>

          <div className="text-xs text-white/60 mb-1">Body preview</div>
          <pre
            className="text-xs bg-black/40 rounded border border-white/10 p-3 whitespace-pre-wrap font-sans text-white/80 mb-4"
            style={{ maxHeight: "180px", overflow: "auto" }}
          >
            {entry.body || "(no body on this entry)"}
          </pre>

          {err && (
            <div className="text-xs text-red-400 mb-3">{err}</div>
          )}

          <div className="flex gap-2 justify-end">
            <button
              type="button"
              onClick={onClose}
              disabled={sending}
              className="text-xs px-3 py-2 rounded border border-white/20 text-white/70 hover:text-white disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={sending || !phone || !entry.body}
              className="text-xs px-4 py-2 rounded bg-[#00E2E5] text-[#000418] font-bold hover:bg-white disabled:opacity-50"
            >
              {sending ? "Sending…" : "Send"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
