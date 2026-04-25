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
  clickCount?: number;
  clickFirst?: string;
  clickLast?: string;
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

/**
 * SMS log entries with `error === "SMS not opted in"` are racers whose
 * household had no SMS consent on file, so the cron logged a skip
 * instead of firing. The ticket + body still exist (short URL is
 * real) so the admin can manually resend after getting verbal consent.
 */
function isConsentSkip(e: EnrichedLogEntry): boolean {
  return !e.ok && e.error === "SMS not opted in";
}

/**
 * Quota-queued state: Vox returned a daily / rate limit and we routed
 * the send to the long-lived quota queue. The every-minute sweep cron
 * will retry as soon as the quota resets — at that point a fresh log
 * entry is written with ok=true. We render these as grey "queued"
 * instead of red "failed" so staff know it's pending, not broken.
 */
function isQuotaQueued(e: EnrichedLogEntry): boolean {
  if (e.ok) return false;
  const err = e.error || "";
  if (err.includes("[quota]")) return true;
  if (err.includes("[quota-drain]")) return true;
  if (e.status === 429) return true;
  return false;
}

/**
 * When an SMS is queued and later drained successfully, two distinct
 * log entries exist for the same logical send. Collapse them: keep
 * only the most recent entry per (shortCode + phone + source) tuple.
 *
 * Entries that have no shortCode (booking-confirm direct sends, etc)
 * pass through unfiltered — they're already 1-to-1 with their delivery.
 */
function dedupeLatestPerSms(entries: EnrichedLogEntry[]): EnrichedLogEntry[] {
  // Newest first ordering is preserved by the API; group + take first.
  const seen = new Map<string, EnrichedLogEntry>();
  const passthrough: EnrichedLogEntry[] = [];
  for (const e of entries) {
    if (!e.shortCode) {
      passthrough.push(e);
      continue;
    }
    const key = `${e.shortCode}|${e.phone}|${e.source}`;
    const prior = seen.get(key);
    if (!prior) { seen.set(key, e); continue; }
    // Prefer ok=true over queued/failed (drain success outranks the
    // earlier queued attempt for the same SMS), then prefer the newer
    // timestamp.
    const priorTs = new Date(prior.ts).getTime();
    const curTs = new Date(e.ts).getTime();
    if (e.ok && !prior.ok) seen.set(key, e);
    else if (!e.ok && prior.ok) { /* keep prior */ }
    else if (curTs > priorTs) seen.set(key, e);
  }
  return [...seen.values(), ...passthrough].sort(
    (a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime(),
  );
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
      // Collapse "queued" + "drained" pairs into the latest state per
      // logical SMS so staff see one row per ticket rather than duplicates.
      const collapsed = dedupeLatestPerSms(json.entries || []);
      setEntries(collapsed);
      setTotal(collapsed.length);
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

  // Auto-refresh every 2 minutes so staff see new cron-logged entries
  // (including fresh no-consent skips) without manually hitting refresh.
  // We don't refresh while the resend modal is open — that would clobber
  // the target entry out from under the operator mid-action.
  useEffect(() => {
    if (resendTarget) return;
    const id = setInterval(load, 120_000);
    return () => clearInterval(id);
  }, [load, resendTarget]);

  return (
    <div className="min-h-screen bg-[#0a1128] text-white">
      <div className="max-w-7xl mx-auto p-3 sm:p-6">
        <header className="mb-3 sm:mb-5">
          <h1 className="text-xl sm:text-2xl font-bold uppercase tracking-wider">E-Ticket Admin</h1>
          <p className="text-white/50 text-xs sm:text-sm mt-0.5 sm:mt-1 hidden sm:block">
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

        {/* Results — desktop table (md+) / mobile cards (<md) */}
        {entries.length === 0 && !loading && (
          <div className="rounded-lg border border-white/10 bg-white/[0.02] text-center text-white/40 py-8">
            No SMS log entries match.
          </div>
        )}

        {/* Mobile card list (<md). Stacks one card per entry; taps/buttons
            stay finger-sized. Table header row is purely visual chrome so
            we drop it here — each card labels its own fields. */}
        <div className="md:hidden space-y-2">
          {entries.map((e) => {
            const flashHere = flash?.shortCode === e.shortCode;
            const noConsent = isConsentSkip(e);
            return (
              <div
                key={`m-${e.ts}-${e.phone}-${e.shortCode ?? ""}`}
                className={`rounded-lg border p-3 text-sm ${
                  flashHere
                    ? "border-emerald-400/40 bg-emerald-500/10"
                    : noConsent
                      ? "border-red-400/40 bg-red-500/10"
                      : "border-white/10 bg-white/[0.02]"
                }`}
              >
                {/* Top row: time + source chip + click chip */}
                <div className="flex items-center justify-between gap-2 mb-2">
                  <span className="text-white/50 text-xs">{formatEt(e.ts)}</span>
                  <div className="flex items-center gap-1 flex-wrap justify-end">
                    <span className={`text-[10px] uppercase px-1.5 py-0.5 rounded ${
                      noConsent ? "bg-red-500/25 text-red-200"
                      : e.source === "pre-race-cron" ? "bg-blue-500/20 text-blue-300"
                      : e.source === "checkin-cron" ? "bg-emerald-500/20 text-emerald-300"
                      : e.source === "admin-resend" ? "bg-amber-500/20 text-amber-300"
                      : "bg-white/10 text-white/60"
                    }`}>
                      {noConsent ? "no consent" : sourceLabel(e.source)}
                    </span>
                    {e.clickCount && e.clickCount > 0 ? (
                      <span className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300">
                        👁 opened{e.clickCount > 1 ? ` ${e.clickCount}×` : ""}
                      </span>
                    ) : null}
                  </div>
                </div>

                {/* Racer name — big, the thing staff are scanning for */}
                <div className="font-semibold text-white mb-1">
                  {e.racerNames.length > 0
                    ? e.racerNames.join(", ")
                    : <span className="text-white/40 italic font-normal">(no ticket)</span>}
                </div>

                {/* Race line */}
                {(e.track || e.heatNumber || e.raceType) && (
                  <div className="text-xs text-white/60 mb-1">
                    {e.track && e.heatNumber ? `${e.track} · Heat ${e.heatNumber}` : ""}
                    {e.raceType && <span className="text-white/40 ml-1">· {e.raceType}</span>}
                  </div>
                )}

                {/* Phone + status on one row */}
                <div className="flex items-center justify-between gap-2 mt-2">
                  <span className="font-mono text-xs text-white/70">{e.phone}</span>
                  <span className="text-xs">
                    {e.ok
                      ? (
                        <span className="text-emerald-400">
                          sent
                          {e.failedOver && <span className="text-amber-300/80 ml-1" title="Vox quota hit — delivered via Twilio failover">↻ Twilio</span>}
                        </span>
                      )
                      : noConsent
                        ? <span className="text-red-300 font-semibold">needs verbal OK</span>
                        : isQuotaQueued(e)
                          ? <span className="text-white/50" title="SMS hit a daily/rate limit and is queued. The every-minute sweep cron will retry on quota reset — auto-flips to green when delivered.">⏳ queued</span>
                          : <span className="text-red-400">failed ({e.status ?? "?"})</span>}
                  </span>
                </div>

                {flashHere && (
                  <div className="text-emerald-400 text-xs mt-1">· {flash!.msg}</div>
                )}

                {/* Resend button — full width, big tap target */}
                <button
                  type="button"
                  onClick={() => setResendTarget(e)}
                  disabled={!e.shortCode || !e.body}
                  className="w-full mt-3 py-2 rounded bg-[#00E2E5] text-[#000418] font-semibold text-sm hover:bg-white disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Resend
                </button>
              </div>
            );
          })}
        </div>

        {/* Desktop table (md+) */}
        <div className="hidden md:block rounded-lg border border-white/10 bg-white/[0.02] overflow-hidden">
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
                {entries.map((e) => {
                  const flashHere = flash?.shortCode === e.shortCode;
                  const noConsent = isConsentSkip(e);
                  return (
                    <tr
                      key={`${e.ts}-${e.phone}-${e.shortCode ?? ""}`}
                      className={`border-t border-white/5 ${flashHere ? "bg-emerald-500/10" : noConsent ? "bg-red-500/5" : ""}`}
                    >
                      <td className="px-3 py-2 whitespace-nowrap text-white/70">{formatEt(e.ts)}</td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <span className={`text-xs uppercase px-1.5 py-0.5 rounded ${
                          noConsent ? "bg-red-500/25 text-red-200"
                          : e.source === "pre-race-cron" ? "bg-blue-500/20 text-blue-300"
                          : e.source === "checkin-cron" ? "bg-emerald-500/20 text-emerald-300"
                          : e.source === "admin-resend" ? "bg-amber-500/20 text-amber-300"
                          : "bg-white/10 text-white/60"
                        }`}>
                          {noConsent ? "no consent" : sourceLabel(e.source)}
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
                          ? (
                            <span className="text-emerald-400 text-xs">
                              sent
                              {e.failedOver && (
                                <span className="text-amber-300/80 ml-1" title="Vox quota hit — delivered via Twilio failover">↻ Twilio</span>
                              )}
                            </span>
                          )
                          : noConsent
                            ? <span className="text-red-300 text-xs font-semibold">needs verbal OK</span>
                            : isQuotaQueued(e)
                              ? <span className="text-white/50 text-xs" title="SMS hit a daily/rate limit and is queued. The every-minute sweep cron will retry on quota reset — auto-flips to green when delivered.">⏳ queued</span>
                              : <span className="text-red-400 text-xs">failed ({e.status ?? "?"})</span>}
                        {/* Click telemetry — only show if we actually have a shortCode + at least one click */}
                        {e.clickCount && e.clickCount > 0 ? (
                          <span
                            className="ml-2 inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300"
                            title={
                              e.clickFirst && e.clickLast
                                ? `First opened ${formatEt(e.clickFirst)}${e.clickCount > 1 ? ` · last ${formatEt(e.clickLast)}` : ""}`
                                : "Opened"
                            }
                          >
                            👁 opened{e.clickCount > 1 ? ` ${e.clickCount}×` : ""}
                          </span>
                        ) : e.shortCode && e.ok ? (
                          <span className="ml-2 text-xs text-white/30">not opened</span>
                        ) : null}
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
  const noConsent = isConsentSkip(entry);
  // For no-consent entries we pre-fill the phone so staff can click Send
  // without retyping — they already had to dial/look up the racer to get
  // verbal OK, don't make them type it again. For normal resends we stay
  // blank so "re-send to same phone" is explicit (leave empty) vs
  // "change phone" (type new number).
  const [phone, setPhone] = useState(noConsent ? (entry.phone || "") : "");
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    if (!entry.shortCode) { setErr("No shortCode on this entry — can't resend."); return; }
    if (!entry.body) { setErr("No body text — can't resend."); return; }
    setSending(true);
    setErr(null);
    try {
      const trimmed = phone.trim();
      const res = await fetch("/api/admin/e-tickets/resend", {
        method: "POST",
        headers: { "content-type": "application/json", "x-admin-token": token },
        body: JSON.stringify({
          shortCode: entry.shortCode,
          body: entry.body,
          // Only pass override if operator actually typed something different
          // from the original — keeps the server-side default-phone path hot.
          overridePhone: trimmed && trimmed !== entry.phone ? trimmed : undefined,
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
          <h3 className="text-lg font-bold uppercase tracking-wide mb-3 pr-10">
            {noConsent ? "Resend — NO SMS CONSENT ON FILE" : "Resend e-ticket"}
          </h3>

          {/*
            No-consent path: cron logged this racer's e-ticket but didn't
            send because Pandora has acceptSmsCommercial=false (or unset).
            Staff MUST read the verbal consent script below before clicking
            Send, and update BMI permissions afterward.
          */}
          {noConsent && (
            <div
              className="mb-4 rounded-lg border-2 border-red-500 bg-red-500/10 p-4"
              role="alert"
            >
              <div className="text-red-200 font-bold text-base leading-snug mb-2">
                Guest Services — ask the racer verbally, word-for-word:
              </div>
              <div className="text-red-100 font-bold text-xl leading-tight mb-3 italic">
                &ldquo;Do I have permission to send eTickets to you? These contain no marketing.&rdquo;
              </div>
              <div className="text-red-100 text-sm leading-snug space-y-1">
                <div>✅ If YES: click <b>Send</b> below, then update BMI:</div>
                <ol className="list-decimal list-inside pl-2 text-red-100/90 text-sm">
                  <li>Open the member in BMI</li>
                  <li>Go to the <b>Permissions</b> tab</li>
                  <li>Check <b>BOTH</b> SMS fields (commercial + scores)</li>
                  <li>Save</li>
                </ol>
                <div className="pt-1">
                  You can send the text first — the BMI update keeps future cron
                  e-tickets flowing automatically, no more manual resend needed.
                </div>
                <div className="pt-1">❌ If NO: close this dialog. Do not send.</div>
              </div>
            </div>
          )}

          <div className="text-xs text-white/50 mb-3 space-y-0.5">
            <div>Racer: <span className="text-white/80">{entry.racerNames.join(", ") || "(no ticket)"}</span></div>
            {entry.track && entry.heatNumber && (
              <div>Race: <span className="text-white/80">{entry.track} · Heat {entry.heatNumber}{entry.raceType ? ` · ${entry.raceType}` : ""}</span></div>
            )}
            <div>{noConsent ? "eTicket for:" : "Originally sent:"} <span className="text-white/80">{formatEt(entry.ts)} · {entry.phone}</span></div>
            {entry.clickCount && entry.clickCount > 0 ? (
              <div className="text-emerald-400">
                Ticket opened {entry.clickCount > 1 ? `${entry.clickCount}× · last` : "at"} {entry.clickLast ? formatEt(entry.clickLast) : ""}
              </div>
            ) : entry.shortCode && entry.ok ? (
              <div className="text-white/40">Ticket not opened yet</div>
            ) : null}
          </div>

          <label className="flex flex-col gap-1 text-xs text-white/60 mb-3">
            {noConsent
              ? "Send to (edit if wrong number)"
              : `Send to (leave blank to reuse ${entry.phone || "original"})`}
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
              disabled={sending || !phone || !entry.body}
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
