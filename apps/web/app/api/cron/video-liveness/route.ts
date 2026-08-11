import { NextRequest, NextResponse } from "next/server";
import redis from "@/lib/redis";
import { verifyCron } from "@/lib/cron-auth";
import { sendEmail } from "@/lib/sendgrid";
import { sql, isDbConfigured } from "@/lib/db";
import { listMatchesInRange, listUnmatchedInRange } from "@/lib/video-match";
import {
  businessDayYmdET,
  businessDayWeekdayET,
  businessDayETRange,
  calendarYmdET,
} from "@/lib/race-business-day";
import {
  livenessEnabled,
  livenessRadioEnabled,
  sweepWrongWindow,
  sweepSilentScans,
  sweepZeroScanHeats,
  radioMessages,
  alertEmailHtml,
  digestEmailHtml,
  type HeatWindowInfo,
  type ScanLogEntry,
  type SweepVideo,
  type WrongWindowHit,
  type SilentScan,
} from "@/lib/video-liveness";

/**
 * GET /api/cron/video-liveness — every 5 min (vercel.json).
 *
 * The permanent form of the manual wrong-video watch the owner ran after
 * the 8/9 W57384 incident ("keep monitoring this … make it permanent").
 * Three sweeps per tick — see lib/video-liveness.ts for the classes and
 * the incident numbers behind each:
 *
 *   wrong-window   → alert once per videoCode (Redis NX, 48h)
 *   zero-scan heat → alert once per sessionId (24h)
 *   silent camera  → alert once per (sessionId, camera) (24h)
 *
 * Dispatch: radio (soteria → staff Zello, spoken; batched per tick so a
 * bad night can't stream 14 announcements) + one detail email per tick.
 * A ~10 PM ET tick additionally sends the daily digest: totals, dead-
 * all-day cameras to bench-check, and — once the PR A gate is live —
 * how many videos it held (`held-implausible` in video_decision_log).
 *
 * Data sources are all cron-warmed already: the sessions proxy (heat
 * actuals), the video match/unmatched logs, camera-scan-log:{ymd}
 * (written by upsertCameraAssignment as of this PR), and the
 * participants proxy (roster sizes, cacheOnly so this cron NEVER blocks
 * on Pandora — a cold cache skips the zero-scan sweep for that tick
 * rather than false-alarming).
 *
 * Kill switches (house rule — default ON): VIDEO_LIVENESS_ALERTS=false
 * kills the whole cron, VIDEO_LIVENESS_RADIO=false mutes radio only.
 * Recipients: VIDEO_ALERT_EMAILS (falls back to ops).
 */

// Sequential proxy fetches + per-item Redis claims + dispatch can push a
// busy evening's tick past the default function limit.
export const maxDuration = 300;

const BASE = process.env.NEXT_PUBLIC_SITE_URL || "https://fasttraxent.com";
const FASTTRAX_LOCATION_ID = "LAB52GY480CJF";
const RADIO_ALERT_URL = "https://bma-soteria-alerts.azurewebsites.net/radio";
const ET = "America/New_York";
const RECIPIENTS = (process.env.VIDEO_ALERT_EMAILS || "eric@headpinz.com,alex@headpinz.com")
  .split(",")
  .map((e) => e.trim())
  .filter(Boolean);
const ADMIN_URL = `${BASE}/admin/videos`;
const DIGEST_HOUR_ET = 22;

interface ProxySession {
  sessionId: string;
  name: string;
  scheduledStart: string;
  type: string;
  heatNumber: number;
  actualStart?: string | null;
  actualEnd?: string | null;
}

/** Racing business day (2 AM ET rollover) of a video's dock time — the
 *  same clock as `ymd`, the scan log, and the heat schedule. A plain
 *  calendar date here is the midnight trap: uploads docked 12–2 AM would
 *  vanish from the sweep and page whole late heats as silent. */
function businessDayOf(iso?: string | null): string {
  if (!iso) return "?";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "?";
  return businessDayYmdET(new Date(t));
}

async function fetchSessions(
  resource: string,
  range: { startDate: string; endDate: string },
): Promise<(ProxySession & { resource: string })[]> {
  const qs = new URLSearchParams({
    locationId: FASTTRAX_LOCATION_ID,
    resourceName: resource,
    startDate: range.startDate,
    endDate: range.endDate,
    prefer: "cache",
  });
  try {
    const res = await fetch(`${BASE}/api/pandora/sessions?${qs}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    const list: ProxySession[] = Array.isArray(data?.data) ? data.data : [];
    return list.map((s) => ({ ...s, resource }));
  } catch {
    return [];
  }
}

/** Roster size via the participants proxy, cache-only (cron-warmed by
 *  pre-race-tickets / checkin-alerts). Cold cache → null → the caller
 *  skips the session this tick instead of treating it as empty. */
async function rosterCount(sessionId: string): Promise<number | null> {
  const qs = new URLSearchParams({
    locationId: FASTTRAX_LOCATION_ID,
    sessionId,
    excludeRemoved: "true",
    excludeUnpaid: "false",
    cacheOnly: "1",
  });
  try {
    const res = await fetch(`${BASE}/api/pandora/session-participants?${qs}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const rows = Array.isArray(data?.data) ? data.data : [];
    return rows.length > 0 ? rows.length : null; // empty = cold cache, not an empty heat
  } catch {
    return null;
  }
}

async function sendRadio(message: string, name: string): Promise<boolean> {
  try {
    const res = await fetch(RADIO_ALERT_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        server: "FT",
        target: "FOH",
        priority: 1,
        message,
        name,
        cooldown: 15,
      }),
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** SET NX dedupe — true when THIS tick should alert for the key. */
async function firstTime(key: string, ttlS: number): Promise<boolean> {
  try {
    return (await redis.set(key, new Date().toISOString(), "EX", ttlS, "NX")) === "OK";
  } catch {
    return false; // Redis hiccup — stay silent rather than spam on every tick
  }
}

export async function GET(req: NextRequest) {
  const authFail = verifyCron(req);
  if (authFail) return authFail;
  if (!livenessEnabled()) {
    return NextResponse.json({ ok: true, disabled: true });
  }

  const nowMs = Date.now();
  const ymd = businessDayYmdET();
  const force = req.nextUrl.searchParams.get("force") === "1";

  // ── Heat windows (actuals) for today's tracks ──
  //
  // Between midnight and the 2 AM rollover the business day's range
  // (`ymd T00:00–23:59`) no longer covers heats scheduled after
  // midnight — the exact trap race-business-day.ts documents — so those
  // ticks fetch the calendar day's window too and merge. Both window
  // shapes match cache keys the crons / camera-assign page keep warm.
  const weekday = businessDayWeekdayET();
  const resources = weekday === "Tue" ? ["Mega Track"] : ["Blue Track", "Red Track"];
  const ranges: { startDate: string; endDate: string }[] = [businessDayETRange()];
  const calYmd = calendarYmdET();
  if (calYmd !== ymd) {
    ranges.push({ startDate: `${calYmd}T00:00:00`, endDate: `${calYmd}T23:59:59` });
  }
  const sessionLists = await Promise.all(
    resources.flatMap((r) => ranges.map((range) => fetchSessions(r, range))),
  );
  const seenSessions = new Set<string>();
  const sessions = sessionLists.flat().filter((s) => {
    const k = String(s.sessionId);
    if (seenSessions.has(k)) return false;
    seenSessions.add(k);
    return true;
  });
  const windows = new Map<string, HeatWindowInfo>();
  for (const s of sessions) {
    const aStart = s.actualStart ? new Date(s.actualStart).getTime() : NaN;
    const aEnd = s.actualEnd ? new Date(s.actualEnd).getTime() : NaN;
    windows.set(String(s.sessionId), {
      sessionId: String(s.sessionId),
      label: `${s.resource.replace(" Track", "")} h${s.heatNumber}`,
      aStartMs: Number.isFinite(aStart) ? aStart : undefined,
      aEndMs: Number.isFinite(aEnd) ? aEnd : undefined,
    });
  }

  // ── Today's videos (matched + held), business-day filtered ──
  const rangeStartMs = nowMs - 30 * 60 * 60 * 1000;
  const [matchedRaw, unmatchedRaw] = await Promise.all([
    listMatchesInRange({ startMs: rangeStartMs, endMs: nowMs, limit: 3000 }),
    listUnmatchedInRange({ startMs: rangeStartMs, endMs: nowMs, limit: 2000 }),
  ]);
  const matched = matchedRaw.filter(
    (m) => businessDayOf(m.capturedAt) === ymd,
  ) as unknown as SweepVideo[];
  // Uploads keyed by BOTH identifiers a video carries: systemNumber (the
  // NFC number scans are recorded under — required on every record) and
  // cameraNumber (VT3's hardware id, optional and usually DIFFERENT).
  // The silent-camera lookup probes with the scanned number, which can
  // legitimately match either.
  const uploadsByCamera = new Map<string, number[]>();
  const addUpload = (key: string | undefined | null, t: number) => {
    if (!key) return;
    const arr = uploadsByCamera.get(String(key)) ?? [];
    arr.push(t);
    uploadsByCamera.set(String(key), arr);
  };
  for (const v of [...matchedRaw, ...unmatchedRaw]) {
    if (businessDayOf(v.capturedAt) !== ymd) continue;
    const t = v.capturedAt ? new Date(v.capturedAt).getTime() : NaN;
    if (!Number.isFinite(t)) continue;
    addUpload(v.systemNumber, t);
    if (v.cameraNumber != null && String(v.cameraNumber) !== String(v.systemNumber)) {
      addUpload(String(v.cameraNumber), t);
    }
  }

  // Every NX key claimed this tick — rolled back if dispatch fails
  // outright, so a SendGrid/radio outage delays an alert instead of
  // permanently swallowing it (the claim windows outlive the sweep
  // windows, so there is no later natural retry).
  const claimedKeys: string[] = [];
  const claim = async (key: string, ttlS: number): Promise<boolean> => {
    if (force) return true;
    const first = await firstTime(key, ttlS);
    if (first) claimedKeys.push(key);
    return first;
  };

  // ── Sweep 1: wrong-window ──
  const wrongToday = sweepWrongWindow(matched, windows);
  const newWrong: WrongWindowHit[] = [];
  for (const w of wrongToday) {
    if (await claim(`video-liveness:alerted:wrong:${w.videoCode}`, 48 * 3600)) {
      newWrong.push(w);
    }
  }

  // ── Sweep 2: zero-scan heats (recent launches only) ──
  const recentLaunches = [...windows.values()].filter(
    (w) => w.aStartMs != null && nowMs - w.aStartMs <= 20 * 60_000 && w.aStartMs <= nowMs,
  );
  const rosterCounts = new Map<string, number>();
  const scanCounts = new Map<string, number>();
  for (const w of recentLaunches) {
    const [roster, scans] = await Promise.all([
      rosterCount(w.sessionId),
      redis.scard(`camera-assign:session:${w.sessionId}`).catch(() => null),
    ]);
    if (roster != null) rosterCounts.set(w.sessionId, roster);
    if (typeof scans === "number") scanCounts.set(w.sessionId, scans);
  }
  const zeroScan = sweepZeroScanHeats(windows, rosterCounts, scanCounts, nowMs);
  const newZeroScan = [];
  for (const z of zeroScan) {
    if (await claim(`video-liveness:alerted:zeroscan:${z.sessionId}`, 24 * 3600)) {
      newZeroScan.push(z);
    }
  }

  // ── Sweep 3: silent cameras ──
  const scanRaw = await redis.zrange(`camera-scan-log:${ymd}`, 0, -1).catch(() => [] as string[]);
  const rawScans: ScanLogEntry[] = [];
  for (const raw of scanRaw) {
    try {
      rawScans.push(JSON.parse(raw));
    } catch {
      /* skip malformed */
    }
  }
  // The scan log is append-only, but the admin redo path
  // (deleteCameraAssignment) and re-scans onto a different camera leave
  // stale entries behind — a corrected typo must not page as a dead
  // camera. Keep only scans whose LIVE assignment record still exists
  // and still names the same camera. A Redis read failure keeps zero
  // scans — silent-sweep goes quiet for a tick rather than false-paging.
  let scans: ScanLogEntry[] = [];
  if (rawScans.length) {
    const raws = await redis
      .mget(...rawScans.map((s) => `camera-assign:${s.sid}:${s.pid}`))
      .catch(() => null);
    if (raws) {
      scans = rawScans.filter((s, i) => {
        const raw = raws[i];
        if (!raw) return false;
        try {
          const a = JSON.parse(raw) as { systemNumber?: string };
          return String(a.systemNumber) === String(s.sys);
        } catch {
          return false;
        }
      });
    }
  }
  const silentToday = sweepSilentScans(scans, uploadsByCamera, windows, nowMs);
  const newSilent: SilentScan[] = [];
  for (const s of silentToday) {
    if (await claim(`video-liveness:alerted:silent:${s.sessionId}:${s.camera}`, 24 * 3600)) {
      newSilent.push(s);
    }
  }

  // ── Dispatch ──
  // Radio speaks only the floor-actionable classes (zero-scan, mass
  // silence); email carries everything including wrong-window detail.
  const radioSent: boolean[] = [];
  if (livenessRadioEnabled()) {
    const tickBucket = Math.floor(nowMs / 300_000);
    for (const [i, msg] of radioMessages({ newZeroScan, newSilent }).entries()) {
      radioSent.push(await sendRadio(msg, `VideoLiveness${tickBucket}n${i}`));
    }
  }
  let emailSent = false;
  const email = alertEmailHtml({ newWrong, newZeroScan, newSilent, adminUrl: ADMIN_URL });
  if (email) {
    for (const to of RECIPIENTS) {
      try {
        const r = await sendEmail({ to, subject: email.subject, html: email.html });
        emailSent = emailSent || r.ok;
      } catch {
        /* per-recipient best effort */
      }
    }
    // Email is the channel that carries every class — if no recipient
    // got it, release this tick's claims so the next tick retries
    // instead of the alert dying inside a still-live dedupe key.
    if (!emailSent && claimedKeys.length) {
      await redis.del(...claimedKeys).catch(() => void 0);
    }
  }

  // ── Nightly digest (first tick at/after 10 PM ET) ──
  const etHour = parseInt(
    new Intl.DateTimeFormat("en-US", { timeZone: ET, hour: "2-digit", hour12: false }).format(
      new Date(),
    ),
    10,
  );
  let digestSent = false;
  if (
    etHour >= DIGEST_HOUR_ET &&
    (force || (await firstTime(`video-liveness:digest:${ymd}`, 40 * 3600)))
  ) {
    const scannedCams = new Set(scans.map((s) => String(s.sys)));
    const deadCameras = [...scannedCams]
      .filter((c) => !(uploadsByCamera.get(c) ?? []).length)
      .sort();
    let heldImplausible: number | null = null;
    if (isDbConfigured()) {
      try {
        const q = sql();
        const rows = (await q`
          SELECT COUNT(*)::int AS n FROM video_decision_log
          WHERE decision = 'held-implausible' AND ts >= NOW() - INTERVAL '24 hours'`) as {
          n: number;
        }[];
        heldImplausible = rows[0]?.n ?? 0;
      } catch {
        heldImplausible = null; // table/columns predate PR A — omit the stat
      }
    }
    const digest = digestEmailHtml({
      ymd,
      matchedCount: matched.length,
      wrongToday,
      silentToday,
      deadCameras,
      heldImplausible,
      adminUrl: ADMIN_URL,
    });
    for (const to of RECIPIENTS) {
      try {
        const r = await sendEmail({ to, subject: digest.subject, html: digest.html });
        digestSent = digestSent || r.ok;
      } catch {
        /* best effort */
      }
    }
    // Undelivered digest → release the day-key so a later tick retries.
    if (!digestSent && !force) {
      await redis.del(`video-liveness:digest:${ymd}`).catch(() => void 0);
    }
  }

  const summary = {
    ok: true,
    ymd,
    sessions: sessions.length,
    matched: matched.length,
    wrongToday: wrongToday.length,
    newWrong: newWrong.length,
    zeroScan: zeroScan.length,
    newZeroScan: newZeroScan.length,
    silentToday: silentToday.length,
    newSilent: newSilent.length,
    radioSent,
    emailSent,
    digestSent,
  };
  if (newWrong.length || newZeroScan.length || newSilent.length) {
    console.log(`[video-liveness] ${JSON.stringify(summary)}`);
  }
  return NextResponse.json(summary, { headers: { "Cache-Control": "no-store" } });
}
