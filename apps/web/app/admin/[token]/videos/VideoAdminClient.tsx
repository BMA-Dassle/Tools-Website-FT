"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useVisibleInterval } from "@/lib/use-visible-interval";
import { modalBackdropProps } from "@/lib/a11y";
import { ADMIN_SANS, PORTAL_DARK } from "~/components/features/admin-skin/theme";
import { usePortalAutoHeight } from "~/components/features/admin-skin/usePortalAutoHeight";

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
  /** Carrier-DLR delivery state (populated by /api/sms-webhook/vox).
   *  Optional — older records and pre-webhook entries don't have it,
   *  so the UI falls back to the send-time `notifySmsOk` outcome.
   *  Same vocabulary as the e-ticket admin so the legend applies
   *  identically across both screens. */
  notifySmsDeliveryStatus?: "delivered" | "undelivered" | "failed" | "sent" | "queued";
  notifyEmailOk?: boolean;
  notifyEmailError?: string;
  notifyEmailSentTo?: string;
  notifyEmailSentAt?: string;
  /** True when the match is saved but SMS/email are deferred because
   *  VT3 hasn't finished sampling yet. Admin shows a 'pending upload'
   *  chip instead of sms/email status until the cron's next tick
   *  catches the status transition and fires the notify. */
  pendingNotify?: boolean;
  /** Last VT3 status observed for the video, for debug / transparency. */
  videoStatus?: string;
  /** VT3 impression overlay — populated by the video-match cron from
   *  vt3's /videos feed. `viewed` is true once ANY viewer has loaded
   *  the video page or media-centre tile. Timestamps let staff see
   *  when the racer first/last opened it. */
  viewed?: boolean;
  firstViewedAt?: string;
  lastViewedAt?: string;
  /** True when the video has been unlocked via VT3's purchase flow.
   *  `purchaseType` is the raw VT3 string (e.g. 'FREE', 'PAID') for
   *  the chip tooltip; `unlockedAt` is when unlock happened. */
  purchased?: boolean;
  purchaseType?: string;
  unlockedAt?: string;
  /** Block mirror — set by the cron / block endpoints. Source of
   *  truth is the video-block:* keys. */
  blocked?: boolean;
  blockLevel?: "video" | "person" | "session";
  blockReason?: string;
  blockedAt?: string;
  /** True when the SMS / email landed via the guardian instead of
   *  the racer (minor with no usable own contact). Drives a small
   *  "↻ guardian" chip alongside the sms/email status. */
  viaGuardian?: boolean;
  /** Review-hold context on unmatched rows — set when the matcher
   *  held this video because every eligible assignment on its camera
   *  already had a video (usually: the next racer's heat never got
   *  scanned). `suggested` is the newest eligible assignment's
   *  snapshot — the best contact lead staff have. */
  reason?: "duplicate-assignment";
  existingVideoCode?: string;
  suggested?: {
    sessionId: string | number;
    personId: string | number;
    firstName: string;
    lastName: string;
    heatNumber?: number;
    track?: string;
    sessionName?: string;
    phone?: string;
    email?: string;
  };
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
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function formatEt(iso?: string): string {
  if (!iso) return "";
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

// Pill palette — matches the e-ticket admin so staff parse one
// legend across both screens. Color semantics:
//   GREY   = not sent (no attempt yet)
//   YELLOW = sent (Vox accepted, no carrier DLR yet)
//   GREEN  = delivered (carrier confirmed handset receipt)
//   RED    = rejected (carrier blocked the message)
const PILL_BASE = "text-[10px] uppercase px-1.5 py-0.5 rounded";
const PILL_OK = "bg-emerald-500/20 text-emerald-300";
const PILL_AMBER = "bg-amber-500/20 text-amber-300";
const PILL_RED = "bg-red-500/20 text-red-300";
const PILL_GREY = "bg-white/10 text-white/50";

// Portal-skin tokens (see ~/components/features/admin-skin/theme). Tailwind's
// JIT needs literal hex in class strings, so arbitrary-value classes below
// mirror the same constants:
//   #3b82f6 = PORTAL_BLUE (primary buttons) · #60a5fa = PORTAL_BLUE_SOFT
//   (links) · #19273e = PORTAL_DARK.card · #323e53 = PORTAL_DARK.border ·
//   #98a2b3 = PORTAL_DARK.muted · #3c4b66 = PORTAL_DARK.inputBorder
const INPUT_STYLE: React.CSSProperties = {
  backgroundColor: PORTAL_DARK.inputBg,
  border: `1px solid ${PORTAL_DARK.inputBorder}`,
  borderRadius: 8,
  color: PORTAL_DARK.fg,
};
const CARD_STYLE: React.CSSProperties = {
  backgroundColor: PORTAL_DARK.card,
  borderColor: PORTAL_DARK.border,
  borderRadius: 8,
};

/** Translate the raw VT3 status into a short, racer-/staff-friendly
 *  label for the pending-notify chip. Previously the chip always said
 *  "pending upload" regardless of state, which read as a bug to ops
 *  when the file was actually queued in VT3's encoder for 30+ minutes
 *  past upload completion. */
function pendingPhaseLabel(status: string | undefined): string {
  switch (status) {
    case "PENDING_UPLOAD":
    case "TRANSFERRING":
      return "uploading";
    case "TRANSFERRED":
      return "uploaded · awaiting encode";
    case "FOR_ENCODING":
      return "queued for encode";
    case "IS_ENCODING":
    case "ENCODING":
      return "encoding";
    case "SAMPLING":
    case "PROCESSING":
      return "processing";
    default:
      return status ? status.toLowerCase().replace(/_/g, " ") : "pending";
  }
}

/** SMS-state chip — same shape as the e-ticket admin. Returns
 *  null for passive "not sent" states so the row stays uncluttered;
 *  only renders when there's something the operator needs to see
 *  (yellow sent, green delivered, red rejected/quota). */
function smsPill(e: VideoRow): React.ReactNode {
  if (e.notifySmsError?.includes("[quota")) {
    // Quota state — keep visible, but as RED since it's an actionable
    // hold (sweep cron will retry, but operator may want to drain
    // manually via the SMS quota tool).
    return (
      <span
        className={`${PILL_BASE} ${PILL_RED}`}
        title="SMS hit a daily/rate limit and is queued. Sweep cron retries on quota reset."
      >
        sms quota ⏳
      </span>
    );
  }
  if (e.notifySmsError) {
    return (
      <span className={`${PILL_BASE} ${PILL_RED}`} title={e.notifySmsError}>
        sms rejected ✗
      </span>
    );
  }
  if (e.notifySmsOk !== true) {
    // No send yet (notify-deferred, never attempted, etc.) — render
    // nothing so passive states don't clutter the row.
    return null;
  }
  // notifySmsOk=true → consult the carrier DLR if we have one
  switch (e.notifySmsDeliveryStatus) {
    case "delivered":
      return (
        <span
          className={`${PILL_BASE} ${PILL_OK}`}
          title={
            e.notifySmsSentTo
              ? `Delivered to ${e.notifySmsSentTo}`
              : "Carrier confirmed handset receipt"
          }
        >
          sms delivered ✓
        </span>
      );
    case "undelivered":
    case "failed":
      return (
        <span
          className={`${PILL_BASE} ${PILL_RED}`}
          title="Carrier rejected the message after Vox accepted it"
        >
          sms rejected ✗
        </span>
      );
    case "sent":
    case "queued":
    default:
      return (
        <span
          className={`${PILL_BASE} ${PILL_AMBER}`}
          title={
            e.notifySmsSentTo
              ? `Sent to ${e.notifySmsSentTo} — waiting for carrier delivery confirmation`
              : "Vox accepted — waiting for carrier delivery confirmation"
          }
        >
          sms sent
        </span>
      );
  }
}

/** Email-state chip. No DLR for email — `ok` is the only signal.
 *  Hides the passive "not sent" pill (returns null). */
function emailPill(e: VideoRow): React.ReactNode {
  if (e.notifyEmailError) {
    return (
      <span className={`${PILL_BASE} ${PILL_RED}`} title={e.notifyEmailError}>
        email ✗
      </span>
    );
  }
  if (e.notifyEmailOk === true) {
    return (
      <span
        className={`${PILL_BASE} ${PILL_OK}`}
        title={e.notifyEmailSentTo ? `Sent to ${e.notifyEmailSentTo}` : undefined}
      >
        email ✓
      </span>
    );
  }
  return null;
}

/** Color-coded legend — keys the pill colors used in the table.
 *  Mirrors the e-ticket admin's StatusLegend so staff have ONE
 *  convention to learn. */
function VideoStatusLegend() {
  return (
    <div className="rounded-lg border px-3 py-2 mb-3 text-xs" style={CARD_STYLE}>
      <p className="text-[#98a2b3] uppercase tracking-wider text-[10px] font-semibold mb-1.5">
        Status colors
      </p>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[#98a2b3]">
        <span className="inline-flex items-center gap-1.5">
          <span className={`${PILL_BASE} ${PILL_AMBER}`}>sms sent</span>
          <span className="text-[#98a2b3]">accepted, no carrier confirm</span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className={`${PILL_BASE} ${PILL_OK}`}>sms delivered ✓</span>
          <span className="text-[#98a2b3]">handset receipt confirmed</span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className={`${PILL_BASE} ${PILL_RED}`}>sms rejected ✗</span>
          <span className="text-[#98a2b3]">carrier blocked</span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className={`${PILL_BASE} ${PILL_OK}`}>👁 opened</span>
          <span className="text-[#98a2b3]">recipient opened video</span>
        </span>
      </div>
    </div>
  );
}

export default function VideoAdminClient({
  token,
  embedded,
}: {
  token: string;
  /** Portal iframe mode — posts content height so the iframe auto-sizes. */
  embedded?: boolean;
}) {
  const [date, setDate] = useState(todayYmd());
  const [show, setShow] = useState<"all" | "matched" | "unmatched">("all");
  const [status, setStatus] = useState<"" | "notified" | "unnotified" | "failed">("");
  const [q, setQ] = useState("");
  const [entries, setEntries] = useState<VideoRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resendTarget, setResendTarget] = useState<VideoRow | null>(null);
  const [flash, setFlash] = useState<{ key: string; msg: string } | null>(null);
  // Tracks which videoCode is currently being block-toggled so we can
  // disable its button and prevent double-clicks.
  const [blockBusy, setBlockBusy] = useState<string | null>(null);

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

  // Auto-refresh every 10s so delivery state + viewed/opened
  // updates land in near-real-time. History:
  //   - was 2 min: operator stared at stale "yellow sent" pills
  //     after the carrier confirmed delivery
  //   - bumped to 15s: better but still felt laggy during busy
  //     race windows when VT3 events flow ~5-12 events/min
  //   - now 10s + visibility-aware: pauses while the tab is hidden
  //     (idle laptops don't poll), uses setTimeout-recursive so
  //     slow tabs don't pile up overlapping fetches.
  // Modal open → pause (don't yank state out from under the
  // resend dialog).
  useVisibleInterval(
    async (signal) => {
      if (signal.aborted) return;
      await load();
    },
    10_000,
    !resendTarget,
  );

  const rowKey = (e: VideoRow) => `${e.sessionId}:${e.personId}:${e.videoCode}`;

  /**
   * Toggle video-level block. On block: prompts for optional reason.
   * On unblock: if the resulting record is first-send-able (no prior
   * notify, VT3 ready), the server fires the notify inline and we
   * show a success toast reflecting it.
   */
  const toggleBlock = useCallback(
    async (row: VideoRow) => {
      const nowBlocked = !row.blocked;
      let reason: string | undefined;
      if (nowBlocked) {
        const r = prompt(`Block video ${row.videoCode}?\n\nOptional reason (shown in tooltip):`);
        if (r === null) return; // cancelled
        reason = r.trim() || undefined;
      } else if (
        !confirm(`Unblock video ${row.videoCode}? If not yet notified, SMS + email will send now.`)
      ) {
        return;
      }
      setBlockBusy(row.videoCode);
      try {
        const res = await fetch(`/api/admin/videos/block`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-admin-token": token },
          body: JSON.stringify({ videoCode: row.videoCode, block: nowBlocked, reason }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `block failed (${res.status})`);
        const bits: string[] = [];
        if (nowBlocked) bits.push("blocked on VT3");
        else {
          if (data.stillBlocked) bits.push("still blocked (heat/person)");
          else if (data.vt3Ok) bits.push("unblocked on VT3");
          if (data.notified) bits.push("SMS + email sent");
        }
        setFlash({ key: rowKey(row), msg: bits.join(" · ") || "done" });
        setTimeout(() => setFlash(null), 4000);
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : "block failed");
      } finally {
        setBlockBusy(null);
      }
    },
    [token, load],
  );

  usePortalAutoHeight("videos-resize", !!embedded, resendTarget !== null);

  return (
    <div
      className={embedded ? "" : "min-h-screen"}
      style={{
        fontFamily: ADMIN_SANS,
        background: PORTAL_DARK.bodyGradient,
        color: PORTAL_DARK.fg,
      }}
    >
      <div className="max-w-7xl mx-auto p-3 sm:p-6">
        <header className="mb-3 sm:mb-5">
          <h1 className="uppercase tracking-wider" style={{ fontSize: "1.5rem", fontWeight: 700 }}>
            Video Admin
          </h1>
          <p className="text-[#98a2b3] text-xs sm:text-sm mt-0.5 sm:mt-1 hidden sm:block">
            Matched race videos from vt3.io. Resend via SMS or email with optional overrides.
          </p>
        </header>

        {/* Filter bar */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
          <label className="flex flex-col gap-1 text-xs text-[#98a2b3]">
            Date
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="px-2 py-1.5 text-sm"
              style={INPUT_STYLE}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-[#98a2b3]">
            Show
            <select
              value={show}
              onChange={(e) => setShow(e.target.value as typeof show)}
              className="px-2 py-1.5 text-sm"
              style={INPUT_STYLE}
            >
              <option value="all" style={{ backgroundColor: PORTAL_DARK.card }}>
                All videos
              </option>
              <option value="matched" style={{ backgroundColor: PORTAL_DARK.card }}>
                Matched only
              </option>
              <option value="unmatched" style={{ backgroundColor: PORTAL_DARK.card }}>
                Unmatched only
              </option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-[#98a2b3]">
            Notify status
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as typeof status)}
              className="px-2 py-1.5 text-sm"
              style={INPUT_STYLE}
            >
              <option value="" style={{ backgroundColor: PORTAL_DARK.card }}>
                All
              </option>
              <option value="notified" style={{ backgroundColor: PORTAL_DARK.card }}>
                notified
              </option>
              <option value="unnotified" style={{ backgroundColor: PORTAL_DARK.card }}>
                unnotified
              </option>
              <option value="failed" style={{ backgroundColor: PORTAL_DARK.card }}>
                had failures
              </option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-[#98a2b3]">
            Search
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="name  913  ABC123"
              className="px-2 py-1.5 text-sm placeholder:text-white/30"
              style={INPUT_STYLE}
            />
          </label>
        </div>

        {/* Summary line */}
        <div className="flex flex-wrap items-center justify-between gap-2 mb-2 text-xs text-[#98a2b3]">
          <span>
            {loading ? "Loading…" : `${total} match${total === 1 ? "" : "es"}`}
            {error && <span className="ml-2 text-red-400">· {error}</span>}
          </span>
          <button type="button" onClick={load} className="text-[#60a5fa] hover:underline">
            Refresh
          </button>
        </div>

        {/* Empty state */}
        {entries.length === 0 && !loading && (
          <div className="rounded-lg border text-center text-[#98a2b3] py-8" style={CARD_STYLE}>
            No video matches for this date.
          </div>
        )}

        {/* Status-color legend — keys the SMS chip colors used in
            the table below. Mirrors the e-ticket admin's legend so
            staff have ONE color convention across both screens. */}
        {entries.length > 0 && <VideoStatusLegend />}

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
                      : ""
                }`}
                style={flashHere || isUnmatched ? undefined : CARD_STYLE}
              >
                <div className="flex items-center justify-between gap-2 mb-2">
                  <span className="text-[#98a2b3] text-xs">
                    {isUnmatched ? `Captured ${formatEt(e.capturedAt)}` : formatEt(e.matchedAt)}
                  </span>
                  <div className="flex items-center gap-1 flex-wrap justify-end">
                    {e.blocked && (
                      <span
                        className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-red-500/25 text-red-200"
                        title={
                          e.blockReason
                            ? `Blocked (${e.blockLevel || "?"}): ${e.blockReason}`
                            : `Blocked at ${e.blockLevel || "?"} level`
                        }
                      >
                        🚫 blocked
                      </span>
                    )}
                    {isUnmatched ? (
                      e.reason === "duplicate-assignment" ? (
                        <span
                          className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-300"
                          title={`Held for review — ${e.suggested ? `${e.suggested.firstName} ${e.suggested.lastName}'s` : "the last scanned racer's"} slot already has video ${e.existingVideoCode || "?"}. This capture is probably the NEXT racer (camera not re-scanned). Send manually.`}
                        >
                          ⚠ needs review
                        </span>
                      ) : (
                        <span className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300">
                          unmatched
                        </span>
                      )
                    ) : e.pendingNotify ? (
                      <span
                        className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-sky-500/20 text-sky-300"
                        title={`Matched — waiting for VT3 preview to finish (${e.videoStatus || "status unknown"})`}
                      >
                        ⏳ {pendingPhaseLabel(e.videoStatus)}
                      </span>
                    ) : (
                      <>
                        {smsPill(e)}
                        {emailPill(e)}
                        {e.viaGuardian && (
                          <span
                            className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-300"
                            title="Sent to guardian — minor racer with no usable own contact"
                          >
                            ↻ guardian
                          </span>
                        )}
                      </>
                    )}
                    {e.viewed && (
                      <span
                        className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-cyan-500/20 text-cyan-300"
                        title={
                          e.lastViewedAt
                            ? `Last viewed ${formatEt(e.lastViewedAt)}${e.firstViewedAt && e.firstViewedAt !== e.lastViewedAt ? ` · first ${formatEt(e.firstViewedAt)}` : ""}`
                            : "Racer opened the video"
                        }
                      >
                        👁 opened
                      </span>
                    )}
                    {e.purchased && (
                      <span
                        className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-amber-400/20 text-amber-300"
                        title={
                          e.unlockedAt
                            ? `Unlocked ${formatEt(e.unlockedAt)}${e.purchaseType ? ` · ${e.purchaseType}` : ""}`
                            : e.purchaseType || "Purchased"
                        }
                      >
                        💰 purchased
                      </span>
                    )}
                  </div>
                </div>
                <div className="font-semibold text-white mb-1">
                  {isUnmatched ? (
                    e.suggested ? (
                      <span
                        className="text-amber-300/80 italic font-normal"
                        title="Not confirmed — the newest scan on this camera. The video likely belongs to whoever raced after them."
                      >
                        after {e.suggested.firstName} {e.suggested.lastName}
                        {e.suggested.heatNumber ? ` · Heat ${e.suggested.heatNumber}` : ""}
                      </span>
                    ) : (
                      <span className="text-[#98a2b3] italic font-normal">
                        (no racer — assign manually)
                      </span>
                    )
                  ) : (
                    <>
                      {e.firstName} {e.lastName}
                    </>
                  )}
                </div>
                {!isUnmatched && (e.track || e.heatNumber) && (
                  <div className="text-xs text-[#98a2b3] mb-1">
                    {e.track && e.heatNumber
                      ? `${e.track.replace(" Track", "")} · Heat ${e.heatNumber}`
                      : ""}
                    {e.raceType && <span className="text-[#98a2b3] ml-1">· {e.raceType}</span>}
                  </div>
                )}
                <div className="flex items-center justify-between gap-2 mt-2 text-xs">
                  <span className="text-[#98a2b3]">
                    System{" "}
                    <span className="font-mono text-emerald-300">{e.systemNumber || "—"}</span>
                    {e.cameraNumber != null && (
                      <>
                        <span className="text-[#98a2b3] mx-1">·</span>
                        Camera <span className="font-mono text-amber-300">{e.cameraNumber}</span>
                      </>
                    )}
                    <span className="text-[#98a2b3] mx-1">·</span>
                    <a
                      href={e.customerUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="text-[#60a5fa] hover:underline font-mono"
                    >
                      {e.videoCode}
                    </a>
                  </span>
                </div>
                <div className="mt-3 flex gap-2">
                  <button
                    type="button"
                    onClick={() => setResendTarget(e)}
                    disabled={e.blocked}
                    className={`flex-1 py-2 rounded font-semibold text-sm disabled:opacity-50 disabled:cursor-not-allowed ${
                      isUnmatched
                        ? "bg-amber-400 text-[#000418] hover:bg-amber-300"
                        : "bg-[#3b82f6] text-white hover:bg-[#60a5fa]"
                    }`}
                    title={e.blocked ? "Unblock first to resend" : undefined}
                  >
                    {isUnmatched ? "Send" : "Resend"}
                  </button>
                  <button
                    type="button"
                    onClick={() => void toggleBlock(e)}
                    disabled={blockBusy === e.videoCode}
                    aria-label={e.blocked ? "Unblock this video" : "Block this video"}
                    className={`px-3 py-2 rounded font-semibold text-sm border transition-colors disabled:opacity-50 ${
                      e.blocked
                        ? "border-red-500/50 bg-red-500/20 text-red-200 hover:bg-red-500/30"
                        : "border-[#3c4b66] text-[#98a2b3] hover:bg-red-500/10 hover:border-red-500/40 hover:text-red-300"
                    }`}
                  >
                    {blockBusy === e.videoCode ? "Working…" : e.blocked ? "Unblock" : "Block"}
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        {/* Desktop table */}
        <div className="hidden md:block rounded-lg border overflow-hidden" style={CARD_STYLE}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead
                className="text-xs uppercase text-[#98a2b3]"
                style={{ backgroundColor: PORTAL_DARK.muted2 }}
              >
                <tr>
                  <th className="text-left px-3 py-2">Matched</th>
                  <th className="text-left px-3 py-2">Racer</th>
                  <th className="text-left px-3 py-2">Race</th>
                  <th
                    className="text-left px-3 py-2"
                    title="Kart the camera was mounted in (video.system.name)"
                  >
                    System
                  </th>
                  <th className="text-left px-3 py-2" title="Camera hardware id (video.camera)">
                    Camera
                  </th>
                  <th className="text-left px-3 py-2">Video</th>
                  <th className="text-left px-3 py-2">Notified</th>
                  <th className="px-3 py-2">
                    <span className="sr-only">Actions</span>
                  </th>
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
                      className={`border-t border-[#323e53] ${
                        flashHere ? "bg-emerald-500/10" : isUnmatched ? "bg-amber-500/[0.04]" : ""
                      }`}
                    >
                      <td className="px-3 py-2 whitespace-nowrap text-[#98a2b3]">
                        {isUnmatched ? (
                          <span className="text-amber-300/70">{formatEt(e.capturedAt)}</span>
                        ) : (
                          formatEt(e.matchedAt)
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {isUnmatched ? (
                          e.suggested ? (
                            <span
                              className="text-amber-300/80 italic"
                              title="Not confirmed — the newest scan on this camera. The video likely belongs to whoever raced after them."
                            >
                              after {e.suggested.firstName} {e.suggested.lastName}
                              {e.suggested.heatNumber ? ` · Heat ${e.suggested.heatNumber}` : ""}
                            </span>
                          ) : (
                            <span className="text-[#98a2b3] italic">(no racer)</span>
                          )
                        ) : (
                          <>
                            {e.firstName} {e.lastName}
                          </>
                        )}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-[#98a2b3]">
                        {!isUnmatched && e.track && e.heatNumber
                          ? `${e.track.replace(" Track", "")} · Heat ${e.heatNumber}`
                          : ""}
                        {!isUnmatched && e.raceType && (
                          <span className="text-[#98a2b3] ml-1">· {e.raceType}</span>
                        )}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap font-mono text-xs text-emerald-300">
                        {e.systemNumber || "—"}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap font-mono text-xs text-amber-300">
                        {e.cameraNumber ?? "—"}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <a
                          href={e.customerUrl}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="text-[#60a5fa] hover:underline font-mono text-xs"
                        >
                          {e.videoCode}
                        </a>
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <span className="inline-flex items-center gap-1 flex-wrap">
                          {e.blocked && (
                            <span
                              className="text-xs uppercase px-1.5 py-0.5 rounded bg-red-500/25 text-red-200"
                              title={
                                e.blockReason
                                  ? `Blocked (${e.blockLevel || "?"}): ${e.blockReason}`
                                  : `Blocked at ${e.blockLevel || "?"} level`
                              }
                            >
                              🚫 blocked
                            </span>
                          )}
                          {isUnmatched ? (
                            e.reason === "duplicate-assignment" ? (
                              <span
                                className="text-xs uppercase px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-300"
                                title={`Held for review — ${e.suggested ? `${e.suggested.firstName} ${e.suggested.lastName}'s` : "the last scanned racer's"} slot already has video ${e.existingVideoCode || "?"}. This capture is probably the NEXT racer (camera not re-scanned). Send manually.`}
                              >
                                ⚠ needs review
                              </span>
                            ) : (
                              <span className="text-xs uppercase px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300">
                                unmatched
                              </span>
                            )
                          ) : e.pendingNotify ? (
                            <span
                              className="text-xs uppercase px-1.5 py-0.5 rounded bg-sky-500/20 text-sky-300"
                              title={`Matched — waiting for VT3 preview to finish (${e.videoStatus || "status unknown"})`}
                            >
                              ⏳ {pendingPhaseLabel(e.videoStatus)}
                            </span>
                          ) : (
                            <>
                              {smsPill(e)}
                              {emailPill(e)}
                              {e.viaGuardian && (
                                <span
                                  className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-300"
                                  title="Sent to guardian — minor racer with no usable own contact"
                                >
                                  ↻ guardian
                                </span>
                              )}
                            </>
                          )}
                          {e.viewed && (
                            <span
                              className="text-xs uppercase px-1.5 py-0.5 rounded bg-cyan-500/20 text-cyan-300"
                              title={
                                e.lastViewedAt
                                  ? `Last viewed ${formatEt(e.lastViewedAt)}${e.firstViewedAt && e.firstViewedAt !== e.lastViewedAt ? ` · first ${formatEt(e.firstViewedAt)}` : ""}`
                                  : "Racer opened the video"
                              }
                            >
                              👁 opened
                            </span>
                          )}
                          {e.purchased && (
                            <span
                              className="text-xs uppercase px-1.5 py-0.5 rounded bg-amber-400/20 text-amber-300"
                              title={
                                e.unlockedAt
                                  ? `Unlocked ${formatEt(e.unlockedAt)}${e.purchaseType ? ` · ${e.purchaseType}` : ""}`
                                  : e.purchaseType || "Purchased"
                              }
                            >
                              💰 purchased
                            </span>
                          )}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-1.5 justify-end">
                          <button
                            type="button"
                            onClick={() => setResendTarget(e)}
                            disabled={e.blocked}
                            className={`text-xs px-2 py-1 rounded font-semibold disabled:opacity-50 disabled:cursor-not-allowed ${
                              isUnmatched
                                ? "bg-amber-400 text-[#000418] hover:bg-amber-300"
                                : "bg-[#3b82f6] text-white hover:bg-[#60a5fa]"
                            }`}
                            title={e.blocked ? "Unblock first to resend" : undefined}
                          >
                            {isUnmatched ? "Send" : "Resend"}
                          </button>
                          <button
                            type="button"
                            onClick={() => void toggleBlock(e)}
                            disabled={blockBusy === e.videoCode}
                            aria-label={e.blocked ? "Unblock this video" : "Block this video"}
                            className={`text-xs px-2 py-1 rounded font-semibold border transition-colors disabled:opacity-50 ${
                              e.blocked
                                ? "border-red-500/50 bg-red-500/20 text-red-200 hover:bg-red-500/30"
                                : "border-[#3c4b66] text-[#98a2b3] hover:bg-red-500/10 hover:border-red-500/40 hover:text-red-300"
                            }`}
                          >
                            {blockBusy === e.videoCode
                              ? "Working…"
                              : e.blocked
                                ? "Unblock"
                                : "Block"}
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
      </div>
    </div>
  );
}

import AdminResendModal from "@/components/admin/AdminResendModal";

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
  const isUnmatched = !entry.matched || !entry.sessionId || !entry.personId;
  // Held-duplicate rows carry the newest assignment's contact as a
  // suggested lead — prefill it, but the banner below tells staff to
  // confirm the recipient (the video usually belongs to whoever raced
  // AFTER the suggested racer).
  const defaultPhone =
    entry.phone || entry.mobilePhone || entry.homePhone || entry.suggested?.phone || "";
  const defaultEmail = entry.email || entry.suggested?.email || "";

  // Default channel: if one channel already succeeded, default to
  // the OTHER one. Otherwise default SMS.
  const defaultChannel: "sms" | "email" = useMemo(() => {
    if (entry.notifySmsOk && !entry.notifyEmailOk) return "email";
    if (entry.notifyEmailOk && !entry.notifySmsOk) return "sms";
    return "sms";
  }, [entry]);

  // Unmatched videos need optional name fields for the greeting —
  // seeded from the suggested racer on held-duplicate rows.
  const [firstName, setFirstName] = useState(
    isUnmatched ? entry.suggested?.firstName || "" : entry.firstName,
  );
  const [lastName, setLastName] = useState(
    isUnmatched ? entry.suggested?.lastName || "" : entry.lastName,
  );

  const previewText = `FastTrax — your race video is ready!\n\n${(isUnmatched ? firstName.trim() : entry.firstName) || "Hey there"}, your ${entry.track ? `${entry.track.replace(" Track", "")} Track` : "race"}${entry.heatNumber ? ` Heat ${entry.heatNumber}` : ""} video is live.\n\nWatch + share: ${entry.customerUrl.includes("?") ? `${entry.customerUrl}&referrer=receipt` : `${entry.customerUrl}?referrer=receipt`}`;

  return (
    <AdminResendModal
      title={isUnmatched ? "Send video (unmatched)" : "Resend video"}
      channels={["sms", "email"]}
      defaultChannel={defaultChannel}
      originalPhone={defaultPhone || null}
      originalEmail={defaultEmail || null}
      forceNew={isUnmatched && !entry.suggested}
      onClose={onClose}
      alertBanner={
        isUnmatched ? (
          entry.reason === "duplicate-assignment" ? (
            <div className="rounded-lg border border-purple-500/40 bg-purple-500/10 px-3 py-2.5 mb-3 text-xs text-purple-200">
              Held for review —{" "}
              {entry.suggested
                ? `${entry.suggested.firstName} ${entry.suggested.lastName}`
                : "the last scanned racer"}{" "}
              already has video {entry.existingVideoCode || "?"} on this camera, so this capture
              likely belongs to whoever raced AFTER them (camera wasn&apos;t re-scanned). The
              prefilled contact is the suggested racer&apos;s — confirm the recipient before
              sending.
            </div>
          ) : (
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 mb-3 text-xs text-amber-200">
              This video has no racer on file (no camera-assign scan, or the assignment window
              expired). Type the racer&apos;s phone and/or email to send directly.
            </div>
          )
        ) : undefined
      }
      contextSection={
        <>
          <div className="text-xs text-[#98a2b3] mb-3 space-y-0.5">
            {!isUnmatched && (
              <>
                <div>
                  Racer:{" "}
                  <span className="text-white/80">
                    {entry.firstName} {entry.lastName}
                  </span>
                </div>
                {entry.track && entry.heatNumber && (
                  <div>
                    Race:{" "}
                    <span className="text-white/80">
                      {entry.track.replace(" Track", "")} · Heat {entry.heatNumber}
                      {entry.raceType ? ` · ${entry.raceType}` : ""}
                    </span>
                  </div>
                )}
              </>
            )}
            <div>
              System:{" "}
              <span className="text-white/80 font-mono">{entry.systemNumber || "(none)"}</span>
              {entry.cameraNumber != null && (
                <>
                  {" · "}
                  Camera: <span className="text-white/80 font-mono">{entry.cameraNumber}</span>
                </>
              )}
              {" · "}
              Video:{" "}
              <a
                href={entry.customerUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="text-[#60a5fa] hover:underline font-mono"
              >
                {entry.videoCode}
              </a>
            </div>
            {isUnmatched && (
              <div>
                Captured: <span className="text-white/80">{formatEt(entry.capturedAt)}</span>
              </div>
            )}
            {!isUnmatched && entry.notifySmsSentAt && (
              <div>
                Last SMS:{" "}
                <span className="text-white/80">
                  {entry.notifySmsSentTo} · {formatEt(entry.notifySmsSentAt)}
                </span>
                {entry.notifySmsOk === false && <span className="text-red-400 ml-1">(failed)</span>}
              </div>
            )}
            {!isUnmatched && entry.notifyEmailSentAt && (
              <div>
                Last email:{" "}
                <span className="text-white/80">
                  {entry.notifyEmailSentTo} · {formatEt(entry.notifyEmailSentAt)}
                </span>
                {entry.notifyEmailOk === false && (
                  <span className="text-red-400 ml-1">(failed)</span>
                )}
              </div>
            )}
          </div>
          {isUnmatched && (
            <div className="grid grid-cols-2 gap-2 mb-3">
              <label className="flex flex-col gap-1 text-xs text-[#98a2b3]">
                First name (optional)
                <input
                  type="text"
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  placeholder="Alice"
                  className="px-2 py-1.5 text-sm"
                  style={INPUT_STYLE}
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-[#98a2b3]">
                Last name (optional)
                <input
                  type="text"
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  placeholder="Smith"
                  className="px-2 py-1.5 text-sm"
                  style={INPUT_STYLE}
                />
              </label>
            </div>
          )}
        </>
      }
      bodyPreview={previewText}
      onSend={async ({ channel, phone, email }) => {
        const payload: Record<string, unknown> = { channel };
        // Always include video raw fields for fallback
        payload.videoCode = entry.videoCode;
        payload.systemNumber = entry.systemNumber;
        payload.cameraNumber = entry.cameraNumber;
        payload.customerUrl = entry.customerUrl;
        payload.thumbnailUrl = entry.thumbnailUrl;
        payload.capturedAt = entry.capturedAt;
        payload.duration = entry.duration;

        if (isUnmatched) {
          payload.firstName = firstName.trim() || undefined;
          payload.lastName = lastName.trim() || undefined;
        } else {
          payload.sessionId = entry.sessionId;
          payload.personId = entry.personId;
        }
        if (phone) payload.overridePhone = phone;
        if (email) payload.overrideEmail = email;

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
        const msg = bits.join(" · ") || "sent";
        onSuccess(msg);
        return msg;
      }}
    />
  );
}
