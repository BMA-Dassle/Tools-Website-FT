import { NextRequest, NextResponse } from "next/server";
import { listMatchesInRange, updateVideoMatch, type VideoMatch } from "@/lib/video-match";
import { notifyVideoReady, cameraHistoryEntryFromMatch } from "@/lib/video-notify";

/**
 * POST /api/admin/videos/backfill-guardian
 *
 * One-time-use backfill for matches that went out before the
 * guardian-fallback rolled in (or were saved before Pandora started
 * returning the `guardian` block on minor racers).
 *
 * Body:
 *   { dryRun?: boolean, sinceMs?: number }
 *     dryRun  — preview the candidate set without firing
 *     sinceMs — epoch ms lower bound. Default = start of today (ET).
 *
 * Picks any match whose:
 *   - sessionId !== "manual"
 *   - !pendingNotify (has a real video to point at)
 *   - notifySmsOk !== true AND notifyEmailOk !== true
 *     (i.e. nothing has ever reached this racer)
 *
 * Calls notifyVideoReady() per match. The new picker tries the
 * racer first, then falls back to guardian (if Pandora gave us
 * one). Body is automatically reframed as "video ready for {racer
 * first name}" when guardian is used.
 *
 * On the new contact succeeding, the match record's notifySms* /
 * notifyEmail* fields get patched so the videos board flips chips
 * green on the next refresh.
 *
 * Auth: gated by middleware on ADMIN_CAMERA_TOKEN.
 */

/** ET start-of-day epoch ms — used as the default lower bound. */
function startOfTodayET(): number {
  const now = new Date();
  // Format today's ET YYYY-MM-DD, then re-parse with the right offset.
  const ymd = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
  // EDT (Apr-Oct) = UTC-4, EST = UTC-5. Same DST math the videos/list
  // route uses — fine for a daily window since DST transitions don't
  // happen at midnight.
  const month = parseInt(ymd.slice(5, 7), 10);
  const isEDT = month >= 4 && month <= 10;
  const offsetHours = isEDT ? 4 : 5;
  const baseUtc = Date.parse(`${ymd}T00:00:00Z`);
  return baseUtc + offsetHours * 60 * 60 * 1000;
}

interface Body {
  dryRun?: boolean;
  sinceMs?: number;
}

export async function POST(req: NextRequest) {
  let body: Body = {};
  try { body = await req.json().catch(() => ({})); }
  catch { /* keep empty */ }

  const dryRun = !!body.dryRun;
  const startMs = typeof body.sinceMs === "number" && body.sinceMs > 0
    ? body.sinceMs
    : startOfTodayET();
  const endMs = Date.now();

  const matches = await listMatchesInRange({ startMs, endMs, limit: 1000 });

  // Filter: never-notified rows with a real video. Skips:
  //   - manual sends (not a true match)
  //   - pendingNotify (VT3 hasn't finished sampling — body would
  //     point at a not-ready preview)
  //   - rows where SMS or email already succeeded once (re-firing on
  //     those would double-message racers who got their video fine)
  const candidates: VideoMatch[] = [];
  const skipped: { match: VideoMatch; reason: string }[] = [];
  for (const m of matches) {
    if (m.sessionId === "manual") {
      skipped.push({ match: m, reason: "manual-send record" });
      continue;
    }
    if (m.pendingNotify) {
      skipped.push({ match: m, reason: "pending VT3 upload" });
      continue;
    }
    if (m.notifySmsOk === true || m.notifyEmailOk === true) {
      skipped.push({ match: m, reason: "already notified successfully" });
      continue;
    }
    candidates.push(m);
  }

  if (dryRun) {
    return NextResponse.json({
      dryRun: true,
      windowStart: new Date(startMs).toISOString(),
      windowEnd: new Date(endMs).toISOString(),
      total: matches.length,
      candidates: candidates.length,
      skipped: skipped.length,
      skipReasons: skipped.reduce((acc, s) => {
        acc[s.reason] = (acc[s.reason] || 0) + 1;
        return acc;
      }, {} as Record<string, number>),
      candidateSample: candidates.slice(0, 50).map((m) => ({
        videoCode: m.videoCode,
        firstName: m.firstName,
        lastName: m.lastName,
        racerPhone: m.mobilePhone || m.homePhone || m.phone || null,
        racerEmail: m.email || null,
        guardianFirstName: m.guardian?.firstName || null,
        guardianPhone: m.guardian?.mobilePhone || m.guardian?.homePhone || null,
        guardianEmail: m.guardian?.email || null,
        priorSmsError: m.notifySmsError || null,
        priorEmailError: m.notifyEmailError || null,
      })),
    });
  }

  let smsSent = 0;
  let emailSent = 0;
  let viaGuardian = 0;
  let stillNoContact = 0;
  let errored = 0;

  for (const match of candidates) {
    try {
      const entry = cameraHistoryEntryFromMatch(match);
      // Snapshot pre-state to detect whether this fire actually
      // delivered anything new (vs. e.g. skipping silently again).
      const hadGuardian = !!match.guardian && (
        !!match.guardian.mobilePhone ||
        !!match.guardian.homePhone ||
        !!match.guardian.email
      );

      const n = await notifyVideoReady(match, entry);
      const nowIso = new Date().toISOString();

      if (n.sms.attempted) {
        match.notifySmsOk = n.sms.ok;
        match.notifySmsError = n.sms.error;
        match.notifySmsSentTo = n.sms.sentTo;
        match.notifySmsSentAt = nowIso;
        if (n.sms.ok) smsSent++;
      }
      if (n.email.attempted) {
        match.notifyEmailOk = n.email.ok;
        match.notifyEmailError = n.email.error;
        match.notifyEmailSentTo = n.email.sentTo;
        match.notifyEmailSentAt = nowIso;
        if (n.email.ok) emailSent++;
      }

      // Tag whether this attempt landed via guardian. Heuristic — if
      // the SMS was sent to a phone that matches the guardian's
      // mobilePhone/homePhone, count it. Same for email.
      const gPhones = [match.guardian?.mobilePhone, match.guardian?.homePhone]
        .filter(Boolean) as string[];
      const gEmails = [match.guardian?.email].filter(Boolean) as string[];
      const smsViaGuardian = !!(n.sms.ok && n.sms.sentTo && gPhones.some((g) => g.replace(/\D/g, "") && n.sms.sentTo!.includes(g.replace(/\D/g, "").slice(-10))));
      const emailViaGuardian = !!(n.email.ok && n.email.sentTo && gEmails.includes(n.email.sentTo));
      if (smsViaGuardian || emailViaGuardian) viaGuardian++;

      if (!n.sms.attempted && !n.email.attempted) {
        // pickVideoContact returned null — neither racer nor guardian
        // had usable contact. Track it so admin sees the leftover gap.
        if (!hadGuardian) stillNoContact++;
        else stillNoContact++; // guardian present but also unusable
      }

      await updateVideoMatch(match).catch(() => void 0);
    } catch (err) {
      errored++;
      console.error("[backfill-guardian] error for", match.videoCode, err);
    }
  }

  return NextResponse.json({
    ok: true,
    windowStart: new Date(startMs).toISOString(),
    windowEnd: new Date(endMs).toISOString(),
    total: matches.length,
    candidates: candidates.length,
    smsSent,
    emailSent,
    viaGuardian,
    stillNoContact,
    errored,
    skipped: skipped.length,
    skipReasons: skipped.reduce((acc, s) => {
      acc[s.reason] = (acc[s.reason] || 0) + 1;
      return acc;
    }, {} as Record<string, number>),
  });
}
