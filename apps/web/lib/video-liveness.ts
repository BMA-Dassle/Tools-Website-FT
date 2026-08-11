/**
 * Video-pipeline liveness sweeps — pure logic for /api/cron/video-liveness
 * (2026-08-10, PR B of the W57384 incident spec; owner: "make it permanent").
 *
 * Three failure classes, all invisible until a guest complains:
 *
 *  1. WRONG-WINDOW DELIVERY — a racer was matched (and usually texted) a
 *     video whose footage window can't belong to their heat. 95 on 8/9,
 *     14 more on 8/10. Once the plausibility gate (PR A) merges this
 *     should be permanently zero — a nonzero sweep then means the gate
 *     regressed or was killed, which is exactly worth an alert.
 *  2. ZERO-SCAN HEAT — a heat launched with paid racers and no camera
 *     scans (red h16 on 8/9: staff scanned the group against the NEXT
 *     heat's roster). Every video from that heat is then unroutable.
 *  3. SILENT CAMERA — a scanned camera produced no upload after its heat
 *     ended (9 of 14 on blue h29; cams 58/91/84 were dead ALL DAY).
 *     Those racers get no video, and before PR A each silence armed the
 *     one-racer-behind cascade.
 *
 * Everything here is pure (no Redis, no fetch) so it unit-tests against
 * the 8/9–8/10 fixtures; the cron route owns I/O, dedupe, and dispatch.
 *
 * Wrong-window rule: midpoint-or-containment against the heat's padded
 * actual window — the same calibration as lib/video-plausibility.ts
 * (PR A, unmerged as this ships). Duplicated here in ~15 lines so the
 * two PRs stay independently mergeable; consolidate on the PR A module
 * once both are on main.
 */

export const PRE_MS = 270_000; // staging slack — cameras roll from the grid scan
export const POST_MS = 210_000; // pit-return slack past actualEnd

export interface HeatWindowInfo {
  sessionId: string;
  label: string; // e.g. "Blue h44"
  aStartMs?: number;
  aEndMs?: number;
}

export interface SweepVideo {
  videoCode: string;
  sessionId?: string | number;
  personId?: string | number;
  firstName?: string;
  lastName?: string;
  cameraNumber?: number;
  capturedAt?: string;
  duration?: number;
  notifySmsOk?: boolean;
  notifySmsDeliveryStatus?: string;
}

export interface ScanLogEntry {
  sys: string; // camera/system number the NFC tag typed
  sid: string;
  pid: string;
  fn?: string;
  ln?: string;
  at: string; // assignedAt ISO
}

export function livenessEnabled(): boolean {
  return process.env.VIDEO_LIVENESS_ALERTS !== "false";
}

export function livenessRadioEnabled(): boolean {
  return process.env.VIDEO_LIVENESS_RADIO !== "false";
}

/** Latest-possible footage window: [created_at − duration, created_at]
 *  (created_at is VT3 dock time; recording ends before docking). */
export function footageWindow(
  capturedAt: string | undefined,
  durationS: number | undefined,
): { startMs: number; endMs: number } | null {
  if (!capturedAt || typeof durationS !== "number" || !Number.isFinite(durationS) || durationS <= 0)
    return null;
  const endMs = new Date(capturedAt).getTime();
  if (!Number.isFinite(endMs)) return null;
  return { startMs: endMs - durationS * 1000, endMs };
}

/** True when the footage cannot belong to the heat: its midpoint falls
 *  outside the padded actual window AND it doesn't fully contain that
 *  window (long multi-heat recordings do contain their racer's race). */
export function isWrongWindow(
  win: { startMs: number; endMs: number },
  aStartMs: number,
  aEndMs: number,
): boolean {
  const lo = aStartMs - PRE_MS;
  const hi = aEndMs + POST_MS;
  const mid = (win.startMs + win.endMs) / 2;
  const midpointInside = mid >= lo && mid <= hi;
  const contains = win.startMs <= lo && win.endMs >= hi;
  return !midpointInside && !contains;
}

export interface WrongWindowHit {
  videoCode: string;
  racer: string;
  label: string;
  cameraNumber?: number;
  footageStartMs: number;
  footageEndMs: number;
  delivered: boolean;
}

/** Class 1 — matched videos whose footage can't belong to their labeled
 *  heat. Skips videos with no duration and heats with no actuals (both
 *  judged on a later tick once the data lands). */
export function sweepWrongWindow(
  matches: SweepVideo[],
  windows: Map<string, HeatWindowInfo>,
): WrongWindowHit[] {
  const out: WrongWindowHit[] = [];
  for (const m of matches) {
    if (m.sessionId == null || !m.videoCode) continue;
    const w = windows.get(String(m.sessionId));
    if (!w || w.aStartMs == null || w.aEndMs == null) continue;
    const win = footageWindow(m.capturedAt, m.duration);
    if (!win) continue;
    if (isWrongWindow(win, w.aStartMs, w.aEndMs)) {
      out.push({
        videoCode: m.videoCode,
        racer: `${m.firstName ?? ""} ${m.lastName ?? ""}`.trim() || "(unknown)",
        label: w.label,
        cameraNumber: m.cameraNumber,
        footageStartMs: win.startMs,
        footageEndMs: win.endMs,
        delivered: m.notifySmsOk === true || m.notifySmsDeliveryStatus === "delivered",
      });
    }
  }
  return out;
}

export interface SilentScan {
  sessionId: string;
  personId: string;
  label: string;
  camera: string;
  racer: string;
  assignedAtMs: number;
}

/** Class 3 — scans whose heat ended ≥ `graceMs` ago with no upload from
 *  that camera since the scan. `uploadsByCamera` = every video seen today
 *  (matched AND unmatched/held) keyed by camera number as a string. */
export function sweepSilentScans(
  scans: ScanLogEntry[],
  uploadsByCamera: Map<string, number[]>, // camera → capturedAt epoch ms list
  windows: Map<string, HeatWindowInfo>,
  nowMs: number,
  graceMs = 12 * 60_000,
): SilentScan[] {
  const out: SilentScan[] = [];
  for (const s of scans) {
    const w = windows.get(String(s.sid));
    if (!w || w.aEndMs == null) continue; // heat not finished (or unknown) — judge later
    if (nowMs - w.aEndMs < graceMs) continue; // uploads normally land within ~3 min; allow stragglers
    const assignedMs = new Date(s.at).getTime();
    if (!Number.isFinite(assignedMs)) continue;
    const uploads = uploadsByCamera.get(String(s.sys)) ?? [];
    const hasUpload = uploads.some((t) => t >= assignedMs - 60_000);
    if (!hasUpload) {
      out.push({
        sessionId: String(s.sid),
        personId: String(s.pid),
        label: w.label,
        camera: String(s.sys),
        racer: `${s.fn ?? ""} ${s.ln ?? ""}`.trim() || "(unknown)",
        assignedAtMs: assignedMs,
      });
    }
  }
  return out;
}

export interface ZeroScanHeat {
  sessionId: string;
  label: string;
  aStartMs: number;
  rosterCount: number;
}

/** Class 2 — heats that STARTED (actuals) recently with a roster but no
 *  scans. `recentWindowMs` bounds how far back a launch still alerts, so
 *  a cron outage doesn't page about heats from hours ago. UNKNOWN data
 *  never pages: a session pages only when the roster is confirmed ≥2 AND
 *  the scan count is confirmed 0 — a cold roster cache or a failed Redis
 *  SCARD simply skips the session this tick (it re-qualifies on the next
 *  tick inside the 20-min window once the reads succeed). */
export function sweepZeroScanHeats(
  windows: Map<string, HeatWindowInfo>,
  rosterCounts: Map<string, number>,
  scanCounts: Map<string, number>,
  nowMs: number,
  recentWindowMs = 20 * 60_000,
): ZeroScanHeat[] {
  const out: ZeroScanHeat[] = [];
  for (const [sid, w] of windows) {
    if (w.aStartMs == null) continue;
    if (nowMs - w.aStartMs > recentWindowMs || w.aStartMs > nowMs) continue;
    const roster = rosterCounts.get(sid);
    if (roster == null || roster < 2) continue;
    const scans = scanCounts.get(sid);
    if (scans === 0) {
      out.push({ sessionId: sid, label: w.label, aStartMs: w.aStartMs, rosterCount: roster });
    }
  }
  return out;
}

const hmET = (ms: number) =>
  new Date(ms).toLocaleTimeString("en-US", {
    timeZone: "America/New_York",
    hour12: true,
    hour: "numeric",
    minute: "2-digit",
  });

/** Radio scripts — spoken on staff Zello, so short, no codes/URLs.
 *
 *  Radio carries ONLY what floor staff can act on in the moment:
 *  zero-scan (go scan-bind before videos dock) and mass camera silence
 *  (grab spare cameras before the next heat). Wrong-window deliveries
 *  deliberately stay OFF radio — until the plausibility gate merges they
 *  accrue all evening (95 on 8/9) and would speak on FOH every ~5 min
 *  about something nobody can fix mid-rush; they go to the alert email
 *  and the nightly digest instead. */
export function radioMessages(input: {
  newZeroScan: ZeroScanHeat[];
  newSilent: SilentScan[];
  silentRadioFloor?: number;
}): string[] {
  const msgs: string[] = [];
  if (input.newZeroScan.length) {
    for (const z of input.newZeroScan) {
      msgs.push(`Race video alert. ${z.label} launched with no cameras scanned.`);
    }
  }
  const floor = input.silentRadioFloor ?? 3;
  const bySession = new Map<string, SilentScan[]>();
  for (const s of input.newSilent) {
    const arr = bySession.get(s.sessionId) ?? [];
    arr.push(s);
    bySession.set(s.sessionId, arr);
  }
  for (const [, list] of bySession) {
    if (list.length >= floor) {
      msgs.push(
        `Race video alert. ${list.length} cameras from ${list[0].label} have not uploaded a video.`,
      );
    }
  }
  return msgs;
}

/** Email detail — one combined message per tick, full context. */
export function alertEmailHtml(input: {
  newWrong: WrongWindowHit[];
  newZeroScan: ZeroScanHeat[];
  newSilent: SilentScan[];
  adminUrl: string;
}): { subject: string; html: string } | null {
  const { newWrong, newZeroScan, newSilent } = input;
  if (!newWrong.length && !newZeroScan.length && !newSilent.length) return null;
  const bits: string[] = [];
  if (newWrong.length) bits.push(`${newWrong.length} wrong video${newWrong.length > 1 ? "s" : ""}`);
  if (newZeroScan.length)
    bits.push(`${newZeroScan.length} zero-scan heat${newZeroScan.length > 1 ? "s" : ""}`);
  if (newSilent.length)
    bits.push(`${newSilent.length} silent camera${newSilent.length > 1 ? "s" : ""}`);
  const subject = `Video pipeline: ${bits.join(", ")}`;
  const p = (s: string) =>
    `<p style="font-family:Arial,sans-serif;font-size:14px;color:#1A1A1A;">${s}</p>`;
  const li = (s: string) => `<li style="font-family:Arial,sans-serif;font-size:13px;">${s}</li>`;
  let html = "";
  if (newZeroScan.length) {
    html += p(
      "<strong>Heats launched with NO camera scans</strong> — every video from these is unroutable; scan-bind or plan manual sends:",
    );
    html += `<ul>${newZeroScan.map((z) => li(`${z.label} — started ${hmET(z.aStartMs)}, roster ${z.rosterCount}, 0 scans`)).join("")}</ul>`;
  }
  if (newWrong.length) {
    html += p(
      "<strong>Wrong-window deliveries</strong> — the footage can't belong to the racer's heat (resend candidates):",
    );
    html += `<ul>${newWrong
      .map((w) =>
        li(
          `${w.racer} [${w.label}] got <code>${w.videoCode}</code> (cam ${w.cameraNumber ?? "?"}, footage ${hmET(w.footageStartMs)}–${hmET(w.footageEndMs)})${w.delivered ? " — DELIVERED" : ""}`,
        ),
      )
      .join("")}</ul>`;
  }
  if (newSilent.length) {
    html += p(
      "<strong>Silent cameras</strong> — scanned, heat finished, no upload (racer will have no video; camera may be dead):",
    );
    html += `<ul>${newSilent.map((s) => li(`cam ${s.camera} — ${s.racer} [${s.label}], scanned ${hmET(s.assignedAtMs)}`)).join("")}</ul>`;
  }
  html += p(`<a href="${input.adminUrl}">Open the videos admin</a>`);
  return { subject, html };
}

/** Nightly digest — the day's totals whether or not they alerted live. */
export function digestEmailHtml(input: {
  ymd: string;
  matchedCount: number;
  wrongToday: WrongWindowHit[];
  silentToday: SilentScan[];
  deadCameras: string[]; // scanned ≥1 today, zero uploads all day
  heldImplausible?: number | null; // from video_decision_log (post-PR-A)
  adminUrl: string;
}): { subject: string; html: string } {
  const p = (s: string) =>
    `<p style="font-family:Arial,sans-serif;font-size:14px;color:#1A1A1A;">${s}</p>`;
  const subject = `Video pipeline digest ${input.ymd}: ${input.wrongToday.length} wrong, ${input.deadCameras.length} dead cameras`;
  let html = p(
    `<strong>${input.ymd}</strong> — ${input.matchedCount} videos matched · ` +
      `<strong>${input.wrongToday.length}</strong> wrong-window (target 0) · ` +
      `${input.silentToday.length} silent scans · ` +
      `${input.deadCameras.length} dead-all-day cameras` +
      (input.heldImplausible != null
        ? ` · ${input.heldImplausible} held by the plausibility gate`
        : ""),
  );
  if (input.deadCameras.length)
    html += p(
      `<strong>Bench-check these cameras</strong> (scanned today, uploaded nothing): ${input.deadCameras.join(", ")}`,
    );
  if (input.wrongToday.length)
    html += p(
      `Wrong-window codes: ${input.wrongToday.map((w) => `${w.videoCode} (${w.racer}, ${w.label})`).join(" · ")}`,
    );
  html += p(`<a href="${input.adminUrl}">Videos admin</a>`);
  return { subject, html };
}
