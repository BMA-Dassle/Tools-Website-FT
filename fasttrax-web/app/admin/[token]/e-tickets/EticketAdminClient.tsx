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
  if (s === "video-match") return "video";
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
 * Consistent pill-chip status renderer — matches the video admin's
 * style (`text-[10px] uppercase px-1.5 py-0.5 rounded bg-{color}-500/20`).
 * Returns an array of chips so the table cell + mobile card render
 * exactly the same set: delivery state + opened state + any
 * routing flags (Twilio failover / guardian). One renderer = one
 * source of truth for status appearance across views.
 *
 * Delivery state precedence:
 *   - Webhook DLR if available (delivered/undelivered/failed/sent/queued)
 *   - Else fall back to send-time `ok` flag (legacy "sent" pre-webhook)
 *   - Failure cases mark needs-verbal-OK and quota-queued separately
 *
 * Opened state: emerald "opened ✓" if at least one click recorded;
 * grey "not opened —" if we have a shortCode but no clicks yet;
 * omitted entirely otherwise (no link to track).
 */
const PILL_BASE = "inline-flex items-center text-[10px] uppercase px-1.5 py-0.5 rounded";
const PILL_OK = "bg-emerald-500/20 text-emerald-300";
const PILL_AMBER = "bg-amber-500/20 text-amber-300";
const PILL_RED = "bg-red-500/20 text-red-300";
const PILL_GREY = "bg-white/10 text-white/50";
const PILL_PURPLE = "bg-purple-500/20 text-purple-300";

/**
 * Color semantics — explained in the legend at the top of the page:
 *   GREY   = not sent (failed, queued, or no consent — message
 *            never made it out of our system)
 *   YELLOW = sent (Vox accepted but carrier hasn't confirmed
 *            delivery to the handset yet)
 *   GREEN  = delivered (carrier confirmed handset receipt via DLR)
 *   RED    = carrier rejected (e.g. message too long, opted out,
 *            invalid number)
 *
 * Opened state is a SEPARATE pill independent of delivery — we
 * track it from /s/{code} click logs. A green "opened" + grey
 * "not sent" is impossible; a green "delivered" + grey "not opened"
 * is normal (customer hasn't tapped the link yet).
 */
function renderStatusPills(e: EnrichedLogEntry, noConsent: boolean): React.ReactNode {
  const pills: React.ReactNode[] = [];

  // 1. Delivery-state chip — semantics per the page legend:
  //    grey not-sent / yellow sent / green delivered / red rejected.
  if (!e.ok) {
    // Send didn't make it out — never reached Vox successfully.
    if (noConsent) {
      pills.push(
        <span key="ds" className={`${PILL_BASE} ${PILL_GREY}`} title="Customer hasn't given verbal SMS consent — staff must collect it before resend">not sent · needs verbal ok</span>,
      );
    } else if (isQuotaQueued(e)) {
      pills.push(
        <span key="ds" className={`${PILL_BASE} ${PILL_GREY} ring-1 ring-amber-400/20`} title="SMS hit a daily/rate limit and is queued. Sweep cron retries on quota reset.">not sent · queued ⏳</span>,
      );
    } else {
      pills.push(
        <span key="ds" className={`${PILL_BASE} ${PILL_GREY}`} title={e.error || `failed (${e.status ?? "?"})`}>not sent</span>,
      );
    }
  } else {
    switch (e.deliveryStatus) {
      case "delivered":
        pills.push(
          <span key="ds" className={`${PILL_BASE} ${PILL_OK}`} title={e.deliveryUpdatedAt ? `Carrier confirmed handset receipt at ${formatEt(e.deliveryUpdatedAt)}` : "Carrier confirmed handset receipt"}>delivered ✓</span>,
        );
        break;
      case "undelivered":
      case "failed": {
        // Carrier rejected — red. Surfaces the actual error code
        // (e.g. 4505 "carrier rejected message too long") in the
        // tooltip so operators can act.
        const code = e.deliveryErrorCode ? ` ${e.deliveryErrorCode}` : "";
        pills.push(
          <span key="ds" className={`${PILL_BASE} ${PILL_RED}`} title={e.error || `Carrier rejected — status ${e.deliveryStatus}${code}`}>rejected{code} ✗</span>,
        );
        break;
      }
      case "sent":
      case "queued":
      default:
        // Vox accepted; carrier DLR not in yet (or webhook never
        // wired for this entry). Yellow = "sent, awaiting confirm".
        pills.push(
          <span key="ds" className={`${PILL_BASE} ${PILL_AMBER}`} title="Vox accepted the send — waiting for carrier delivery confirmation">sent</span>,
        );
        break;
    }
  }

  // 2. Opened-state chip — independent of delivery.
  //    Click telemetry from /s/{code} redirect log.
  if (e.clickCount && e.clickCount > 0) {
    pills.push(
      <span
        key="op"
        className={`${PILL_BASE} ${PILL_OK}`}
        title={
          e.clickFirst && e.clickLast
            ? `First opened ${formatEt(e.clickFirst)}${e.clickCount > 1 ? ` · last ${formatEt(e.clickLast)}` : ""}`
            : "Recipient tapped the e-ticket link"
        }
      >
        opened ✓{e.clickCount > 1 ? ` ${e.clickCount}×` : ""}
      </span>,
    );
  } else if (e.shortCode && e.ok) {
    pills.push(
      <span key="op" className={`${PILL_BASE} ${PILL_GREY}`} title="Recipient hasn't tapped the e-ticket link yet">not opened</span>,
    );
  }

  // 3. Routing flags — orthogonal to delivery + opened state.
  if (e.failedOver) {
    pills.push(
      <span key="tw" className={`${PILL_BASE} ${PILL_AMBER}`} title="Vox quota hit — delivered via Twilio failover">↻ twilio</span>,
    );
  }
  if (e.viaGuardian) {
    pills.push(
      <span key="gd" className={`${PILL_BASE} ${PILL_PURPLE}`} title="Sent to guardian — minor racer with no usable own contact">↻ guardian</span>,
    );
  }

  return <span className="inline-flex flex-wrap items-center gap-1">{pills}</span>;
}

/** Color-coded legend rendered above the SMS log table — explains
 *  what each pill color means so staff aren't guessing whether
 *  yellow vs. green is the success state. */
function StatusLegend() {
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2 mb-3 text-xs">
      <p className="text-white/40 uppercase tracking-wider text-[10px] font-semibold mb-1.5">
        Status colors
      </p>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-white/70">
        <span className="inline-flex items-center gap-1.5">
          <span className={`${PILL_BASE} ${PILL_GREY}`}>not sent</span>
          <span className="text-white/50">never reached carrier (failed / queued / no consent)</span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className={`${PILL_BASE} ${PILL_AMBER}`}>sent</span>
          <span className="text-white/50">carrier accepted, no delivery confirm yet</span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className={`${PILL_BASE} ${PILL_OK}`}>delivered ✓</span>
          <span className="text-white/50">handset receipt confirmed</span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className={`${PILL_BASE} ${PILL_RED}`}>rejected ✗</span>
          <span className="text-white/50">carrier blocked the message</span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className={`${PILL_BASE} ${PILL_OK}`}>opened ✓</span>
          <span className="text-white/50">recipient tapped the link (separate from delivery)</span>
        </span>
      </div>
    </div>
  );
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

type QuotaStatus = {
  exhausted: boolean;
  status: { hitAt: string; status: number | null; error: string } | null;
  queueSize: number;
  queue?: Array<{ phone: string; source: string; queuedAt: string; shortCode?: string }>;
};

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
  const [quota, setQuota] = useState<QuotaStatus | null>(null);
  const [quotaBusy, setQuotaBusy] = useState(false);
  const [quotaMsg, setQuotaMsg] = useState<string | null>(null);

  /** Pull current SMS quota / queue state. Cheap (Redis only). */
  const loadQuota = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/sms-quota?token=${token}`, { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as QuotaStatus;
      setQuota(data);
    } catch { /* non-fatal */ }
  }, [token]);

  /** Clear cooldown and drain queue. Wired to "Vox is back — push pending" button. */
  const clearAndDrain = useCallback(async () => {
    setQuotaBusy(true);
    setQuotaMsg(null);
    try {
      const res = await fetch(`/api/admin/sms-quota?token=${token}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "clear-and-drain" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `drain failed (${res.status})`);
      const drained = data.drain?.ok ?? 0;
      const stopped = data.drain?.stoppedOnQuota ? " — quota re-hit, will retry" : "";
      const remaining = data.queueAfter ?? 0;
      setQuotaMsg(`Sent ${drained} queued SMS${stopped}. ${remaining} still queued.`);
      await Promise.all([loadQuota(), load()]);
    } catch (err) {
      setQuotaMsg(err instanceof Error ? err.message : "drain failed");
    } finally {
      setQuotaBusy(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, loadQuota]);

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

  // Pull SMS quota state on mount + every 30s. Lighter than the entries
  // refresh, and the data is what staff stare at when Vox is degraded.
  useEffect(() => {
    loadQuota();
    const id = setInterval(loadQuota, 30_000);
    return () => clearInterval(id);
  }, [loadQuota]);

  return (
    <div className="min-h-screen bg-[#0a1128] text-white">
      <div className="max-w-7xl mx-auto p-3 sm:p-6">
        <header className="mb-3 sm:mb-5">
          <h1 className="text-xl sm:text-2xl font-bold uppercase tracking-wider">E-Ticket Admin</h1>
          <p className="text-white/50 text-xs sm:text-sm mt-0.5 sm:mt-1 hidden sm:block">
            Audit and resend SMS e-tickets. Entries below are ordered newest first.
          </p>
        </header>

        {/* SMS quota panel — only renders when there's something the
            operator can act on (queue non-empty OR cooldown flag set).
            Provides the one-click "Vox is back, push pending" button. */}
        {quota && (quota.queueSize > 0 || quota.exhausted) && (
          <div className={`mb-3 sm:mb-4 rounded-xl border p-3 sm:p-4 ${
            quota.exhausted
              ? "border-amber-500/40 bg-amber-500/10"
              : "border-emerald-500/30 bg-emerald-500/5"
          }`}>
            <div className="flex items-start gap-3 flex-wrap">
              <div className="text-2xl shrink-0" aria-hidden="true">
                {quota.exhausted ? "⏸" : "▶"}
              </div>
              <div className="flex-1 min-w-0">
                <p className={`text-sm font-bold uppercase tracking-wider ${
                  quota.exhausted ? "text-amber-300" : "text-emerald-300"
                }`}>
                  {quota.exhausted ? "Vox cooldown active" : "Vox cooldown cleared"}
                </p>
                <p className="text-white/70 text-xs sm:text-sm mt-1 leading-relaxed">
                  <strong className="text-white">{quota.queueSize}</strong> SMS queued for delivery.
                  {quota.exhausted ? (
                    <>
                      {" "}Cooldown set <strong>{formatEt(quota.status?.hitAt || "")}</strong>
                      {quota.status?.status ? <> · status <code className="text-white/60">{quota.status.status}</code></> : null}.
                      Sweep cron will retry on its own once the 1-hour TTL elapses.
                    </>
                  ) : (
                    <> Cooldown is clear — the next minute&apos;s sweep cron will drain the queue.</>
                  )}
                </p>
                {quotaMsg && (
                  <p className="text-emerald-300 text-xs sm:text-sm mt-1.5">{quotaMsg}</p>
                )}
              </div>
              <button
                type="button"
                onClick={clearAndDrain}
                disabled={quotaBusy}
                className="shrink-0 px-4 py-2 rounded-lg font-bold text-sm bg-[#00E2E5] text-[#000418] hover:bg-white disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {quotaBusy
                  ? "Sending…"
                  : quota.exhausted
                    ? "Vox is back — clear & drain"
                    : `Drain ${quota.queueSize} now`}
              </button>
            </div>
          </div>
        )}

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
              <option value="" style={{ backgroundColor: "#0a1128" }}>All e-tickets</option>
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

        {/* Status-color legend — keys the pill colors used in
            both the mobile card list and the desktop table below.
            Helps staff parse "yellow sent vs. green delivered"
            without having to memorize the convention. */}
        {entries.length > 0 && <StatusLegend />}

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
                {/* Top row: time + source chip. Opened-chip moved
                    down into the consolidated status-pills row so
                    every status indicator follows the same legend. */}
                <div className="flex items-center justify-between gap-2 mb-2">
                  <span className="text-white/50 text-xs">{formatEt(e.ts)}</span>
                  <span className={`text-[10px] uppercase px-1.5 py-0.5 rounded ${
                    noConsent ? "bg-red-500/25 text-red-200"
                    : e.source === "pre-race-cron" ? "bg-blue-500/20 text-blue-300"
                    : e.source === "checkin-cron" ? "bg-emerald-500/20 text-emerald-300"
                    : e.source === "admin-resend" ? "bg-amber-500/20 text-amber-300"
                    : "bg-white/10 text-white/60"
                  }`}>
                    {noConsent ? "no consent" : sourceLabel(e.source)}
                  </span>
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

                {/* Phone + status pills.
                    Pills follow the page-top legend: grey not-sent,
                    yellow sent (no DLR yet), green delivered, red
                    rejected. Opened state is a separate pill. */}
                <div className="flex items-center justify-between gap-2 mt-2 flex-wrap">
                  <span className="font-mono text-xs text-white/70">{e.phone}</span>
                  {renderStatusPills(e, noConsent)}
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
                        {/* Unified pill chips — same renderer as
                            the mobile card view. Color semantics
                            keyed by the StatusLegend above. */}
                        {renderStatusPills(e, noConsent)}
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
  // Two explicit modes — staff picks one. Defaults to "same" so the
  // common case (resend to the already-known number) is one click.
  // No-consent and missing-original-phone cases force "new" since
  // there's nothing to reuse.
  const hasOriginal = !!entry.phone;
  const [destMode, setDestMode] = useState<"same" | "new">(
    !hasOriginal || noConsent ? "new" : "same",
  );
  const [phone, setPhone] = useState(noConsent ? (entry.phone || "") : "");
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    if (!entry.shortCode) { setErr("No shortCode on this entry — can't resend."); return; }
    if (!entry.body) { setErr("No body text — can't resend."); return; }

    // Resolve destination phone: "same" reuses the original, "new"
    // takes the typed value. Validation happens here so the user gets
    // a clear inline message instead of an opaque server 400.
    let destPhone = "";
    if (destMode === "same") {
      destPhone = entry.phone || "";
      if (!destPhone) {
        setErr("No original phone on file. Switch to 'Different number' and enter one.");
        return;
      }
    } else {
      destPhone = phone.trim();
      if (!destPhone) {
        setErr("Enter a phone number.");
        return;
      }
    }

    setSending(true);
    setErr(null);
    try {
      // Always send overridePhone explicitly. Side benefit: the backend
      // can fire even when the ticket has expired (12h TTL) — without
      // the override, an expired-ticket resend hits a 404.
      const res = await fetch("/api/admin/e-tickets/resend", {
        method: "POST",
        headers: { "content-type": "application/json", "x-admin-token": token },
        body: JSON.stringify({
          shortCode: entry.shortCode,
          body: entry.body,
          overridePhone: destPhone,
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

          <fieldset className="mb-3">
            <legend className="text-xs text-white/60 mb-1.5">Send to</legend>
            <div className="flex flex-col gap-2">
              {hasOriginal && !noConsent && (
                <label className="flex items-center gap-2 text-sm text-white/85 cursor-pointer">
                  <input
                    type="radio"
                    name="destMode"
                    value="same"
                    checked={destMode === "same"}
                    onChange={() => setDestMode("same")}
                    className="accent-[#00E2E5]"
                  />
                  <span>Same number <span className="font-mono text-white/60">{entry.phone}</span></span>
                </label>
              )}
              <label className="flex flex-col gap-1.5">
                <span className="flex items-center gap-2 text-sm text-white/85 cursor-pointer">
                  <input
                    type="radio"
                    name="destMode"
                    value="new"
                    checked={destMode === "new"}
                    onChange={() => setDestMode("new")}
                    className="accent-[#00E2E5]"
                  />
                  Different number
                </span>
                <input
                  type="tel"
                  inputMode="numeric"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  onFocus={() => setDestMode("new")}
                  disabled={destMode !== "new"}
                  className="ml-6 bg-white/5 border border-white/10 rounded px-2 py-1.5 text-sm text-white font-mono disabled:opacity-40 disabled:cursor-not-allowed"
                  placeholder="2395551234"
                />
                {destMode === "new" && (
                  <span className="ml-6 text-[11px] text-white/40">10 digits, or 11 starting with 1</span>
                )}
              </label>
            </div>
          </fieldset>

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
            {/* Effective destination phone — derived once for both
                the disabled-state check and the visible feedback.
                Was a bug here: the disabled flag only checked the
                "Different number" input box (`phone` state), so
                with "Same number" selected and phone="" (default)
                the Send button was always disabled. Operators saw
                a button that looked clickable but did nothing. */}
            <button
              type="button"
              onClick={submit}
              disabled={
                sending ||
                !entry.body ||
                (destMode === "same" ? !entry.phone : !phone.trim())
              }
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
