"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { modalBackdropProps } from "@/lib/a11y";

/**
 * Video resend admin — mirrors the SMS admin (/admin/{token}/e-tickets)
 * layout + density. Lists matched videos for a date, lets staff filter
 * by racer / camera / code, and resend any match via SMS, email, or
 * both with optional address overrides.
 *
 * Same conventions as EticketAdminClient:
 *   - Mobile-first cards + desktop table
 *   - Source-style chips for delivery state
 *   - Sticky refresh + auto-refresh every 2 min while no modal is open
 */

type VideoMatch = {
  sessionId: string | number;
  personId: string | number;
  firstName: string;
  lastName: string;
  cameraNumber: string;
  videoId: number;
  videoCode: string;
  customerUrl: string;
  thumbnailUrl?: string;
  capturedAt: string;
  duration?: number;
  matchedAt: string;
  sessionName?: string;
  scheduledStart?: string;
  track?: string;
  raceType?: string;
  heatNumber?: number;
  email?: string;
  phone?: string;
  mobilePhone?: string;
  homePhone?: string;
  notifySmsOk?: boolean;
  notifySmsError?: string;
  notifySmsSentTo?: string;
  notifySmsSentAt?: string;
  notifyEmailOk?: boolean;
  notifyEmailError?: string;
  notifyEmailSentTo?: string;
  notifyEmailSentAt?: string;
};

type ListResponse = {
  date: string;
  total: number;
  returned: number;
  entries: VideoMatch[];
};

function todayYmd(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

function formatEt(iso?: string): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString("en-US", {
      timeZone: "America/New_York",
      hour: "numeric", minute: "2-digit", hour12: true,
    });
  } catch { return iso; }
}

export default function VideoAdminClient({ token }: { token: string }) {
  const [date, setDate] = useState(todayYmd());
  const [status, setStatus] = useState<"" | "notified" | "unnotified" | "failed">("");
  const [q, setQ] = useState("");
  const [entries, setEntries] = useState<VideoMatch[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resendTarget, setResendTarget] = useState<VideoMatch | null>(null);
  const [flash, setFlash] = useState<{ key: string; msg: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ date, limit: "200", token });
      if (status) qs.set("status", status);
      if (q) qs.set("q", q);
      const res = await fetch(`/api/admin/videos/list?${qs.toString()}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`list failed: ${res.status}`);
      const json = (await res.json()) as ListResponse;
      setEntries(json.entries || []);
      setTotal(json.total || 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to load");
    } finally {
      setLoading(false);
    }
  }, [date, status, q, token]);

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);

  // Auto-refresh every 2 min; paused while resend modal is open.
  useEffect(() => {
    if (resendTarget) return;
    const id = setInterval(load, 120_000);
    return () => clearInterval(id);
  }, [load, resendTarget]);

  const rowKey = (e: VideoMatch) => `${e.sessionId}:${e.personId}:${e.videoCode}`;

  return (
    <div className="min-h-screen bg-[#0a1128] text-white">
      <div className="max-w-7xl mx-auto p-3 sm:p-6">
        <header className="mb-3 sm:mb-5">
          <h1 className="text-xl sm:text-2xl font-bold uppercase tracking-wider">Video Admin</h1>
          <p className="text-white/50 text-xs sm:text-sm mt-0.5 sm:mt-1 hidden sm:block">
            Matched race videos from vt3.io. Resend via SMS, email, or both with optional overrides.
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
            Status
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as typeof status)}
              className="bg-white/5 border border-white/10 rounded px-2 py-1.5 text-sm text-white"
            >
              <option value="" style={{ backgroundColor: "#0a1128" }}>All</option>
              <option value="notified" style={{ backgroundColor: "#0a1128" }}>notified</option>
              <option value="unnotified" style={{ backgroundColor: "#0a1128" }}>unnotified</option>
              <option value="failed" style={{ backgroundColor: "#0a1128" }}>had failures</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-white/60 col-span-2">
            Search (racer name, camera #, video code)
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="e.g. Smith  or  913  or  WNX9QHJGMM"
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
          <button type="button" onClick={load} className="text-[#00E2E5] hover:underline">
            Refresh
          </button>
        </div>

        {/* Empty state */}
        {entries.length === 0 && !loading && (
          <div className="rounded-lg border border-white/10 bg-white/[0.02] text-center text-white/40 py-8">
            No video matches for this date.
          </div>
        )}

        {/* Mobile card list (<md) */}
        <div className="md:hidden space-y-2">
          {entries.map((e) => {
            const flashHere = flash?.key === rowKey(e);
            return (
              <div
                key={rowKey(e)}
                className={`rounded-lg border p-3 text-sm ${
                  flashHere ? "border-emerald-400/40 bg-emerald-500/10" : "border-white/10 bg-white/[0.02]"
                }`}
              >
                <div className="flex items-center justify-between gap-2 mb-2">
                  <span className="text-white/50 text-xs">{formatEt(e.matchedAt)}</span>
                  <div className="flex items-center gap-1 flex-wrap justify-end">
                    {e.notifySmsOk === true ? (
                      <span className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300">sms ✓</span>
                    ) : e.notifySmsError ? (
                      <span className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-red-500/20 text-red-300">sms ✗</span>
                    ) : (
                      <span className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-white/10 text-white/50">sms —</span>
                    )}
                    {e.notifyEmailOk === true ? (
                      <span className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300">email ✓</span>
                    ) : e.notifyEmailError ? (
                      <span className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-red-500/20 text-red-300">email ✗</span>
                    ) : (
                      <span className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-white/10 text-white/50">email —</span>
                    )}
                  </div>
                </div>
                <div className="font-semibold text-white mb-1">
                  {e.firstName} {e.lastName}
                </div>
                <div className="text-xs text-white/60 mb-1">
                  {e.track && e.heatNumber ? `${e.track.replace(" Track", "")} · Heat ${e.heatNumber}` : ""}
                  {e.raceType && <span className="text-white/40 ml-1">· {e.raceType}</span>}
                </div>
                <div className="flex items-center justify-between gap-2 mt-2 text-xs">
                  <span className="text-white/70">
                    Camera <span className="font-mono text-emerald-300">{e.cameraNumber}</span>
                    <span className="text-white/30 mx-1">·</span>
                    <a href={e.customerUrl} target="_blank" rel="noreferrer noopener" className="text-[#00E2E5] hover:underline font-mono">{e.videoCode}</a>
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setResendTarget(e)}
                  className="w-full mt-3 py-2 rounded bg-[#00E2E5] text-[#000418] font-semibold text-sm hover:bg-white"
                >
                  Resend
                </button>
              </div>
            );
          })}
        </div>

        {/* Desktop table */}
        <div className="hidden md:block rounded-lg border border-white/10 bg-white/[0.02] overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-white/5 text-xs uppercase text-white/50">
                <tr>
                  <th className="text-left px-3 py-2">Matched</th>
                  <th className="text-left px-3 py-2">Racer</th>
                  <th className="text-left px-3 py-2">Race</th>
                  <th className="text-left px-3 py-2">Camera</th>
                  <th className="text-left px-3 py-2">Video</th>
                  <th className="text-left px-3 py-2">Notified</th>
                  <th className="px-3 py-2"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => {
                  const flashHere = flash?.key === rowKey(e);
                  return (
                    <tr
                      key={rowKey(e)}
                      className={`border-t border-white/5 ${flashHere ? "bg-emerald-500/10" : ""}`}
                    >
                      <td className="px-3 py-2 whitespace-nowrap text-white/70">{formatEt(e.matchedAt)}</td>
                      <td className="px-3 py-2">{e.firstName} {e.lastName}</td>
                      <td className="px-3 py-2 whitespace-nowrap text-white/70">
                        {e.track && e.heatNumber ? `${e.track.replace(" Track", "")} · Heat ${e.heatNumber}` : ""}
                        {e.raceType && <span className="text-white/40 ml-1">· {e.raceType}</span>}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap font-mono text-xs text-emerald-300">{e.cameraNumber}</td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <a href={e.customerUrl} target="_blank" rel="noreferrer noopener" className="text-[#00E2E5] hover:underline font-mono text-xs">
                          {e.videoCode}
                        </a>
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <span className="inline-flex items-center gap-1">
                          {e.notifySmsOk === true ? (
                            <span className="text-xs uppercase px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300">sms ✓</span>
                          ) : e.notifySmsError ? (
                            <span className="text-xs uppercase px-1.5 py-0.5 rounded bg-red-500/20 text-red-300" title={e.notifySmsError}>sms ✗</span>
                          ) : (
                            <span className="text-xs uppercase px-1.5 py-0.5 rounded bg-white/10 text-white/50">sms —</span>
                          )}
                          {e.notifyEmailOk === true ? (
                            <span className="text-xs uppercase px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300">email ✓</span>
                          ) : e.notifyEmailError ? (
                            <span className="text-xs uppercase px-1.5 py-0.5 rounded bg-red-500/20 text-red-300" title={e.notifyEmailError}>email ✗</span>
                          ) : (
                            <span className="text-xs uppercase px-1.5 py-0.5 rounded bg-white/10 text-white/50">email —</span>
                          )}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        <button
                          type="button"
                          onClick={() => setResendTarget(e)}
                          className="text-xs px-2 py-1 rounded bg-[#00E2E5] text-[#000418] font-semibold hover:bg-white"
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
              setFlash({ key: rowKey(resendTarget), msg });
              setTimeout(() => setFlash(null), 4000);
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
  entry: VideoMatch;
  token: string;
  onClose: () => void;
  onSuccess: (msg: string) => void;
}) {
  // Sensible default: if neither send has succeeded, try both; if one
  // already succeeded, default to the other. Staff can override.
  const defaultChannel: "sms" | "email" | "both" = useMemo(() => {
    if (entry.notifySmsOk && !entry.notifyEmailOk) return "email";
    if (entry.notifyEmailOk && !entry.notifySmsOk) return "sms";
    return "both";
  }, [entry]);

  const [channel, setChannel] = useState<"sms" | "email" | "both">(defaultChannel);
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const defaultPhone = entry.phone || entry.mobilePhone || entry.homePhone || "";
  const defaultEmail = entry.email || "";

  async function submit() {
    setSending(true);
    setErr(null);
    try {
      const tp = phone.trim();
      const te = email.trim();
      const res = await fetch("/api/admin/videos/resend", {
        method: "POST",
        headers: { "content-type": "application/json", "x-admin-token": token },
        body: JSON.stringify({
          sessionId: entry.sessionId,
          personId: entry.personId,
          channel,
          overridePhone: tp && tp !== defaultPhone ? tp : undefined,
          overrideEmail: te && te !== defaultEmail ? te : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `send failed (${res.status})`);
      const r = data.result || {};
      const bits: string[] = [];
      if (r.sms?.ok) bits.push(`SMS → ${r.sms.sentTo}`);
      if (r.sms && !r.sms.ok) bits.push(`SMS failed: ${r.sms.error || "?"}`);
      if (r.email?.ok) bits.push(`email → ${r.email.sentTo}`);
      if (r.email && !r.email.ok) bits.push(`email failed: ${r.email.error || "?"}`);
      onSuccess(bits.join(" · ") || "resent");
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
          className="absolute top-3 right-3 z-10 w-8 h-8 flex items-center justify-center rounded-full bg-white/10 hover:bg-white/20 text-white"
          style={{ fontSize: "20px", lineHeight: 1 }}
        >
          &times;
        </button>
        <div className="p-5 sm:p-6">
          <h3 className="text-lg font-bold uppercase tracking-wide mb-3 pr-10">Resend video</h3>

          <div className="text-xs text-white/50 mb-3 space-y-0.5">
            <div>Racer: <span className="text-white/80">{entry.firstName} {entry.lastName}</span></div>
            {entry.track && entry.heatNumber && (
              <div>Race: <span className="text-white/80">{entry.track.replace(" Track", "")} · Heat {entry.heatNumber}{entry.raceType ? ` · ${entry.raceType}` : ""}</span></div>
            )}
            <div>Camera: <span className="text-white/80 font-mono">{entry.cameraNumber}</span> · Video: <a href={entry.customerUrl} target="_blank" rel="noreferrer noopener" className="text-[#00E2E5] hover:underline font-mono">{entry.videoCode}</a></div>
            {entry.notifySmsSentAt && (
              <div>Last SMS: <span className="text-white/80">{entry.notifySmsSentTo} · {formatEt(entry.notifySmsSentAt)}</span>{entry.notifySmsOk === false && <span className="text-red-400 ml-1">(failed)</span>}</div>
            )}
            {entry.notifyEmailSentAt && (
              <div>Last email: <span className="text-white/80">{entry.notifyEmailSentTo} · {formatEt(entry.notifyEmailSentAt)}</span>{entry.notifyEmailOk === false && <span className="text-red-400 ml-1">(failed)</span>}</div>
            )}
          </div>

          {/* Channel picker — radio-style chips */}
          <div className="mb-3">
            <div className="text-xs text-white/60 mb-1">Channel</div>
            <div className="flex gap-2">
              {(["sms", "email", "both"] as const).map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setChannel(c)}
                  className={`text-xs uppercase tracking-wider font-semibold px-3 py-1.5 rounded border transition-colors ${
                    channel === c
                      ? "bg-[#00E2E5] border-[#00E2E5] text-[#000418]"
                      : "border-white/15 bg-white/[0.02] text-white/70 hover:bg-white/10"
                  }`}
                >
                  {c === "both" ? "SMS + Email" : c.toUpperCase()}
                </button>
              ))}
            </div>
          </div>

          {(channel === "sms" || channel === "both") && (
            <label className="flex flex-col gap-1 text-xs text-white/60 mb-3">
              Phone (leave blank to reuse {defaultPhone || "none"})
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                className="bg-white/5 border border-white/10 rounded px-2 py-1.5 text-sm text-white font-mono"
                placeholder="+12395551234"
              />
            </label>
          )}

          {(channel === "email" || channel === "both") && (
            <label className="flex flex-col gap-1 text-xs text-white/60 mb-3">
              Email (leave blank to reuse {defaultEmail || "none"})
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="bg-white/5 border border-white/10 rounded px-2 py-1.5 text-sm text-white"
                placeholder="racer@example.com"
              />
            </label>
          )}

          <div className="text-xs text-white/60 mb-1">Preview</div>
          <pre
            className="text-xs bg-black/40 rounded border border-white/10 p-3 whitespace-pre-wrap font-sans text-white/80 mb-4"
            style={{ maxHeight: "180px", overflow: "auto" }}
          >
{`FastTrax — your race video is ready!

${entry.firstName}, your ${entry.track?.replace(" Track", "") || "race"}${entry.heatNumber ? ` Heat ${entry.heatNumber}` : ""} video is live.

Watch + share: ${entry.customerUrl}`}
          </pre>

          {err && <div className="text-xs text-red-400 mb-3">{err}</div>}

          <div className="flex flex-col-reverse sm:flex-row gap-2 sm:justify-end">
            <button
              type="button"
              onClick={onClose}
              disabled={sending}
              className="text-sm px-4 py-3 sm:py-2 rounded border border-white/20 text-white/70 hover:text-white disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={sending}
              className="text-sm px-5 py-3 sm:py-2 rounded bg-[#00E2E5] text-[#000418] font-bold hover:bg-white disabled:opacity-50"
            >
              {sending ? "Sending…" : "Send"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
