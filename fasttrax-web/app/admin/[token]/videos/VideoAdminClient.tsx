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

type VideoRow = {
  matched: boolean;
  sessionId: string | number;
  personId: string | number;
  firstName: string;
  lastName: string;
  /** System / base-station number (what the NFC tag reads, e.g. "913"). */
  systemNumber: string;
  /** Hardware camera number (e.g. 20) from vt3's video.camera field. */
  cameraNumber?: number;
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
  entries: VideoRow[];
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
  const [show, setShow] = useState<"all" | "matched" | "unmatched">("all");
  const [status, setStatus] = useState<"" | "notified" | "unnotified" | "failed">("");
  const [q, setQ] = useState("");
  const [entries, setEntries] = useState<VideoRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resendTarget, setResendTarget] = useState<VideoRow | null>(null);
  const [previewTarget, setPreviewTarget] = useState<VideoRow | null>(null);
  const [flash, setFlash] = useState<{ key: string; msg: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ date, limit: "200", token });
      if (show !== "all") qs.set("show", show);
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
  }, [date, show, status, q, token]);

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);

  // Auto-refresh every 2 min; paused while any modal is open so we
  // don't yank state out from under the operator.
  useEffect(() => {
    if (resendTarget || previewTarget) return;
    const id = setInterval(load, 120_000);
    return () => clearInterval(id);
  }, [load, resendTarget, previewTarget]);

  const rowKey = (e: VideoRow) => `${e.sessionId}:${e.personId}:${e.videoCode}`;

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
            Show
            <select
              value={show}
              onChange={(e) => setShow(e.target.value as typeof show)}
              className="bg-white/5 border border-white/10 rounded px-2 py-1.5 text-sm text-white"
            >
              <option value="all" style={{ backgroundColor: "#0a1128" }}>All videos</option>
              <option value="matched" style={{ backgroundColor: "#0a1128" }}>Matched only</option>
              <option value="unmatched" style={{ backgroundColor: "#0a1128" }}>Unmatched only</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-white/60">
            Notify status
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
          <label className="flex flex-col gap-1 text-xs text-white/60">
            Search
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="name  913  ABC123"
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
            // Treat "matched record with empty identifiers" as unmatched
            // for UI purposes — same rationale as in ResendModal below.
            const isUnmatched = !e.matched || !e.sessionId || !e.personId;
            return (
              <div
                key={rowKey(e)}
                className={`rounded-lg border p-3 text-sm ${
                  flashHere
                    ? "border-emerald-400/40 bg-emerald-500/10"
                    : isUnmatched
                      ? "border-amber-500/30 bg-amber-500/[0.04]"
                      : "border-white/10 bg-white/[0.02]"
                }`}
              >
                <div className="flex items-center justify-between gap-2 mb-2">
                  <span className="text-white/50 text-xs">
                    {isUnmatched ? `Captured ${formatEt(e.capturedAt)}` : formatEt(e.matchedAt)}
                  </span>
                  <div className="flex items-center gap-1 flex-wrap justify-end">
                    {isUnmatched ? (
                      <span className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300">unmatched</span>
                    ) : (
                      <>
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
                      </>
                    )}
                  </div>
                </div>
                <div className="font-semibold text-white mb-1">
                  {isUnmatched
                    ? <span className="text-white/40 italic font-normal">(no racer — assign manually)</span>
                    : <>{e.firstName} {e.lastName}</>}
                </div>
                {!isUnmatched && (e.track || e.heatNumber) && (
                  <div className="text-xs text-white/60 mb-1">
                    {e.track && e.heatNumber ? `${e.track.replace(" Track", "")} · Heat ${e.heatNumber}` : ""}
                    {e.raceType && <span className="text-white/40 ml-1">· {e.raceType}</span>}
                  </div>
                )}
                <div className="flex items-center justify-between gap-2 mt-2 text-xs">
                  <span className="text-white/70">
                    System <span className="font-mono text-emerald-300">{e.systemNumber || "—"}</span>
                    {e.cameraNumber != null && (
                      <>
                        <span className="text-white/30 mx-1">·</span>
                        Camera <span className="font-mono text-amber-300">{e.cameraNumber}</span>
                      </>
                    )}
                    <span className="text-white/30 mx-1">·</span>
                    <a href={e.customerUrl} target="_blank" rel="noreferrer noopener" className="text-[#00E2E5] hover:underline font-mono">{e.videoCode}</a>
                  </span>
                </div>
                <div className="flex gap-2 mt-3">
                  <button
                    type="button"
                    onClick={() => setPreviewTarget(e)}
                    className="flex-1 py-2 rounded font-semibold text-sm bg-white/10 text-white border border-white/15 hover:bg-white/20"
                  >
                    ▶ Preview
                  </button>
                  <button
                    type="button"
                    onClick={() => setResendTarget(e)}
                    className={`flex-1 py-2 rounded font-semibold text-sm ${
                      isUnmatched
                        ? "bg-amber-400 text-[#000418] hover:bg-amber-300"
                        : "bg-[#00E2E5] text-[#000418] hover:bg-white"
                    }`}
                  >
                    {isUnmatched ? "Send" : "Resend"}
                  </button>
                </div>
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
                  <th className="text-left px-3 py-2" title="Kart the camera was mounted in (video.system.name)">System</th>
                  <th className="text-left px-3 py-2" title="Camera hardware id (video.camera)">Camera</th>
                  <th className="text-left px-3 py-2">Video</th>
                  <th className="text-left px-3 py-2">Notified</th>
                  <th className="px-3 py-2"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => {
                  const flashHere = flash?.key === rowKey(e);
                  // Treat "matched record with empty identifiers" as unmatched
            // for UI purposes — same rationale as in ResendModal below.
            const isUnmatched = !e.matched || !e.sessionId || !e.personId;
                  return (
                    <tr
                      key={rowKey(e)}
                      className={`border-t border-white/5 ${
                        flashHere ? "bg-emerald-500/10" : isUnmatched ? "bg-amber-500/[0.04]" : ""
                      }`}
                    >
                      <td className="px-3 py-2 whitespace-nowrap text-white/70">
                        {isUnmatched
                          ? <span className="text-amber-300/70">{formatEt(e.capturedAt)}</span>
                          : formatEt(e.matchedAt)}
                      </td>
                      <td className="px-3 py-2">
                        {isUnmatched
                          ? <span className="text-white/30 italic">(no racer)</span>
                          : <>{e.firstName} {e.lastName}</>}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-white/70">
                        {!isUnmatched && e.track && e.heatNumber ? `${e.track.replace(" Track", "")} · Heat ${e.heatNumber}` : ""}
                        {!isUnmatched && e.raceType && <span className="text-white/40 ml-1">· {e.raceType}</span>}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap font-mono text-xs text-emerald-300">{e.systemNumber || "—"}</td>
                      <td className="px-3 py-2 whitespace-nowrap font-mono text-xs text-amber-300">{e.cameraNumber ?? "—"}</td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <a href={e.customerUrl} target="_blank" rel="noreferrer noopener" className="text-[#00E2E5] hover:underline font-mono text-xs">
                          {e.videoCode}
                        </a>
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {isUnmatched ? (
                          <span className="text-xs uppercase px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300">unmatched</span>
                        ) : (
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
                        )}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <div className="flex gap-1 justify-end">
                          <button
                            type="button"
                            onClick={() => setPreviewTarget(e)}
                            aria-label="Preview video"
                            className="text-xs px-2 py-1 rounded font-semibold bg-white/10 text-white border border-white/15 hover:bg-white/20"
                            title="Preview video"
                          >
                            ▶ <span className="sr-only">Preview</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => setResendTarget(e)}
                            className={`text-xs px-2 py-1 rounded font-semibold ${
                              isUnmatched
                                ? "bg-amber-400 text-[#000418] hover:bg-amber-300"
                                : "bg-[#00E2E5] text-[#000418] hover:bg-white"
                            }`}
                          >
                            {isUnmatched ? "Send" : "Resend"}
                          </button>
                        </div>
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

        {/* Preview modal */}
        {previewTarget && (
          <PreviewModal
            entry={previewTarget}
            token={token}
            onClose={() => setPreviewTarget(null)}
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
  entry: VideoRow;
  token: string;
  onClose: () => void;
  onSuccess: (msg: string) => void;
}) {
  // A row is "unmatched" if it's flagged so by the server, OR if its
  // identifiers are empty strings (a corrupted match record from an
  // earlier manual send where we didn't capture identifiers). Either
  // way, we can't use the matched-resend API path — fall through to
  // the manual-send flow which only needs videoCode + contact info.
  const isUnmatched = !entry.matched || !entry.sessionId || !entry.personId;

  // Sensible default: if neither send has succeeded, try both; if one
  // already succeeded, default to the other. Staff can override.
  // For unmatched: default to "both" so staff can fill in either and
  // fire at least one channel.
  const defaultChannel: "sms" | "email" | "both" = useMemo(() => {
    if (isUnmatched) return "both";
    if (entry.notifySmsOk && !entry.notifyEmailOk) return "email";
    if (entry.notifyEmailOk && !entry.notifySmsOk) return "sms";
    return "both";
  }, [entry, isUnmatched]);

  const [channel, setChannel] = useState<"sms" | "email" | "both">(defaultChannel);
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [firstName, setFirstName] = useState(isUnmatched ? "" : entry.firstName);
  const [lastName, setLastName] = useState(isUnmatched ? "" : entry.lastName);
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

      const payload: Record<string, unknown> = { channel };
      if (isUnmatched) {
        // Manual send on an unmatched video — server expects videoCode
        // + raw fields + the contact staff is typing into the form.
        if ((channel === "sms" || channel === "both") && !tp) {
          throw new Error("Phone is required for SMS");
        }
        if ((channel === "email" || channel === "both") && !te) {
          throw new Error("Email is required for email send");
        }
        payload.videoCode = entry.videoCode;
        payload.systemNumber = entry.systemNumber;
        payload.cameraNumber = entry.cameraNumber;
        payload.customerUrl = entry.customerUrl;
        payload.thumbnailUrl = entry.thumbnailUrl;
        payload.capturedAt = entry.capturedAt;
        payload.duration = entry.duration;
        payload.firstName = firstName.trim() || undefined;
        payload.lastName = lastName.trim() || undefined;
        if (tp) payload.overridePhone = tp;
        if (te) payload.overrideEmail = te;
      } else {
        // Matched resend.
        payload.sessionId = entry.sessionId;
        payload.personId = entry.personId;
        // Also include videoCode + raw vt3 fields as a manual-send
        // fallback in case the match record is missing on the server
        // (e.g., trimmed from the match log). The server will only
        // use these if the primary match lookup fails.
        payload.videoCode = entry.videoCode;
        payload.systemNumber = entry.systemNumber;
        payload.cameraNumber = entry.cameraNumber;
        payload.customerUrl = entry.customerUrl;
        payload.thumbnailUrl = entry.thumbnailUrl;
        payload.capturedAt = entry.capturedAt;
        payload.duration = entry.duration;
        if (tp && tp !== defaultPhone) payload.overridePhone = tp;
        if (te && te !== defaultEmail) payload.overrideEmail = te;
      }

      const res = await fetch("/api/admin/videos/resend", {
        method: "POST",
        headers: { "content-type": "application/json", "x-admin-token": token },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `send failed (${res.status})`);
      const r = data.result || {};
      const bits: string[] = [];
      if (r.sms?.ok) bits.push(`SMS → ${r.sms.sentTo}`);
      if (r.sms && !r.sms.ok) bits.push(`SMS failed: ${r.sms.error || "?"}`);
      if (r.email?.ok) bits.push(`email → ${r.email.sentTo}`);
      if (r.email && !r.email.ok) bits.push(`email failed: ${r.email.error || "?"}`);
      onSuccess(bits.join(" · ") || "sent");
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
          <h3 className="text-lg font-bold uppercase tracking-wide mb-3 pr-10">
            {isUnmatched ? "Send video (unmatched)" : "Resend video"}
          </h3>

          {isUnmatched && (
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 mb-3 text-xs text-amber-200">
              This video has no racer on file (no camera-assign scan, or the assignment
              window expired). Type the racer&apos;s phone and/or email to send directly.
            </div>
          )}

          <div className="text-xs text-white/50 mb-3 space-y-0.5">
            {!isUnmatched && (
              <>
                <div>Racer: <span className="text-white/80">{entry.firstName} {entry.lastName}</span></div>
                {entry.track && entry.heatNumber && (
                  <div>Race: <span className="text-white/80">{entry.track.replace(" Track", "")} · Heat {entry.heatNumber}{entry.raceType ? ` · ${entry.raceType}` : ""}</span></div>
                )}
              </>
            )}
            <div>
              System: <span className="text-white/80 font-mono">{entry.systemNumber || "(none)"}</span>
              {entry.cameraNumber != null && (
                <>
                  {" · "}
                  Camera: <span className="text-white/80 font-mono">{entry.cameraNumber}</span>
                </>
              )}
              {" · "}
              Video: <a href={entry.customerUrl} target="_blank" rel="noreferrer noopener" className="text-[#00E2E5] hover:underline font-mono">{entry.videoCode}</a>
            </div>
            {isUnmatched && (
              <div>Captured: <span className="text-white/80">{formatEt(entry.capturedAt)}</span></div>
            )}
            {!isUnmatched && entry.notifySmsSentAt && (
              <div>Last SMS: <span className="text-white/80">{entry.notifySmsSentTo} · {formatEt(entry.notifySmsSentAt)}</span>{entry.notifySmsOk === false && <span className="text-red-400 ml-1">(failed)</span>}</div>
            )}
            {!isUnmatched && entry.notifyEmailSentAt && (
              <div>Last email: <span className="text-white/80">{entry.notifyEmailSentTo} · {formatEt(entry.notifyEmailSentAt)}</span>{entry.notifyEmailOk === false && <span className="text-red-400 ml-1">(failed)</span>}</div>
            )}
          </div>

          {/* Racer name — only editable on unmatched (manual) sends.
              Optional, used just for greeting in the SMS/email body. */}
          {isUnmatched && (
            <div className="grid grid-cols-2 gap-2 mb-3">
              <label className="flex flex-col gap-1 text-xs text-white/60">
                First name (optional)
                <input
                  type="text"
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  placeholder="Alice"
                  className="bg-white/5 border border-white/10 rounded px-2 py-1.5 text-sm text-white"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-white/60">
                Last name (optional)
                <input
                  type="text"
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  placeholder="Smith"
                  className="bg-white/5 border border-white/10 rounded px-2 py-1.5 text-sm text-white"
                />
              </label>
            </div>
          )}

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
              {isUnmatched
                ? "Phone (required for SMS)"
                : `Phone (leave blank to reuse ${defaultPhone || "none"})`}
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
              {isUnmatched
                ? "Email (required for email send)"
                : `Email (leave blank to reuse ${defaultEmail || "none"})`}
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

${(isUnmatched ? firstName.trim() : entry.firstName) || "Hey there"}, your ${entry.track?.replace(" Track", "") || "race"}${entry.heatNumber ? ` Heat ${entry.heatNumber}` : ""} video is live.

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

/**
 * Preview modal — plays the vt3.io MP4 inline via a signed R2 URL
 * fetched from /api/admin/videos/preview.
 *
 * Mobile-first layout:
 *   - Full-width with tight padding
 *   - Video uses aspect-ratio:16/9 so it scales cleanly without the
 *     browser trying to match the intrinsic height before it loads
 *   - Thumbnail poster so there's immediate visual feedback while the
 *     MP4 stream establishes
 *   - 'Open in new tab' fallback for the rare case /sample or /url
 *     returns something we can't play inline
 */
function PreviewModal({
  entry,
  token,
  onClose,
}: {
  entry: VideoRow;
  token: string;
  onClose: () => void;
}) {
  const [mp4Url, setMp4Url] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [kind, setKind] = useState<"url" | "sample" | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    setMp4Url(null);
    (async () => {
      try {
        const qs = new URLSearchParams({ code: entry.videoCode, token });
        const res = await fetch(`/api/admin/videos/preview?${qs.toString()}`, { cache: "no-store" });
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok || !data.url) throw new Error(data.error || `preview failed (${res.status})`);
        setMp4Url(data.url);
        setKind(data.kind || null);
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : "preview failed");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [entry.videoCode, token]);

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center p-2 sm:p-3 bg-black/85"
      style={{ height: "100dvh" }}
      {...modalBackdropProps(onClose)}
    >
      <div
        className="relative w-full max-w-3xl rounded-xl"
        style={{
          backgroundColor: "#0a1128",
          border: "1.78px solid rgba(255,255,255,0.1)",
          maxHeight: "calc(100dvh - 1rem)",
          overflowY: "auto",
        }}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close preview"
          className="absolute top-2 right-2 z-10 w-9 h-9 flex items-center justify-center rounded-full bg-white/15 hover:bg-white/25 text-white"
          style={{ fontSize: "22px", lineHeight: 1 }}
        >
          &times;
        </button>
        <div className="p-3 sm:p-5">
          {/* Title — compact on mobile */}
          <div className="mb-3 pr-10">
            <div className="text-[10px] uppercase tracking-widest text-white/40 font-semibold">
              {kind === "sample" ? "Sample preview" : kind === "url" ? "Full video" : "Preview"}
            </div>
            <div className="text-sm sm:text-base font-semibold truncate">
              {entry.matched
                ? <>{entry.firstName} {entry.lastName}</>
                : <span className="text-white/50 italic font-normal">(unmatched)</span>}
              {entry.track && entry.heatNumber && (
                <span className="text-white/40 ml-2 font-normal">
                  · {entry.track.replace(" Track", "")} H{entry.heatNumber}
                </span>
              )}
            </div>
            <div className="text-xs text-white/40 mt-0.5 font-mono">
              sys {entry.systemNumber || "—"}
              {entry.cameraNumber != null && <> · cam {entry.cameraNumber}</>}
              {" · "}{entry.videoCode}
            </div>
          </div>

          {/* Video slot — 16:9 so the modal scales cleanly on phones.
              VT3's /sample endpoint 403s for programmatic server-side
              callers (fine from the browser), so inline playback may
              fail. In that case we fall back to a big thumbnail + a
              prominent "Watch on vt3.io" CTA so staff still have a
              one-click path to the video. */}
          <div
            className="w-full rounded-lg overflow-hidden bg-black border border-white/10 relative"
            style={{ aspectRatio: "16 / 9" }}
          >
            {loading && (
              <div className="w-full h-full flex items-center justify-center text-white/50 text-sm">
                Loading preview…
              </div>
            )}
            {!loading && mp4Url && (
              // eslint-disable-next-line jsx-a11y/media-has-caption
              <video
                key={mp4Url}
                src={mp4Url}
                poster={entry.thumbnailUrl}
                controls
                autoPlay
                playsInline
                className="w-full h-full bg-black"
              />
            )}
            {!loading && !mp4Url && entry.thumbnailUrl && (
              <a
                href={entry.customerUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="absolute inset-0 group"
                aria-label="Open video on vt3.io"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={entry.thumbnailUrl}
                  alt=""
                  className="w-full h-full object-cover"
                />
                {/* Dark overlay with play glyph to signal it's clickable */}
                <div className="absolute inset-0 bg-black/35 group-hover:bg-black/20 flex items-center justify-center transition-colors">
                  <div className="flex items-center justify-center w-16 h-16 sm:w-20 sm:h-20 rounded-full bg-[#00E2E5]/90 text-[#000418] text-3xl pl-1">
                    ▶
                  </div>
                </div>
              </a>
            )}
            {!loading && !mp4Url && !entry.thumbnailUrl && (
              <div className="w-full h-full flex items-center justify-center text-white/40 text-sm">
                Preview unavailable
              </div>
            )}
          </div>
          {!loading && !mp4Url && err && (
            <div className="mt-2 text-[11px] text-white/40 font-mono truncate" title={err}>
              inline preview unavailable ({err})
            </div>
          )}

          {/* Bottom row — open in new tab + close. Stacked on phones. */}
          <div className="flex flex-col-reverse sm:flex-row gap-2 sm:justify-between mt-3">
            <a
              href={entry.customerUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="text-xs px-3 py-2 rounded border border-white/20 text-white/70 hover:text-white hover:border-white/40 text-center"
            >
              Open on vt3.io ↗
            </a>
            <button
              type="button"
              onClick={onClose}
              className="text-sm px-5 py-2.5 rounded bg-white/10 text-white border border-white/15 hover:bg-white/20"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
