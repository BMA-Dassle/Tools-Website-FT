import { NextRequest, NextResponse } from "next/server";
import { listMatchesInRange, updateVideoMatch, type VideoMatch } from "@/lib/video-match";
import { notifyVideoReady, cameraHistoryEntryFromMatch } from "@/lib/video-notify";
import type { GuardianContact, Participant } from "@/lib/participant-contact";

const FASTTRAX_LOCATION_ID = "LAB52GY480CJF";
const BASE = process.env.NEXT_PUBLIC_SITE_URL || "https://fasttraxent.com";

/**
 * Re-fetch the live participant roster for a sessionId from Pandora
 * via our existing proxy route, return a Map keyed by personId so the
 * caller can graft guardian onto old VideoMatch records that were
 * saved before the cron started snapshotting it.
 *
 * We use the existing /api/pandora/session-participants endpoint
 * (which is auth-gated by SWAGGER_ADMIN_KEY at the proxy layer) so
 * we don't have to duplicate Pandora's auth handling here.
 */
async function fetchGuardiansForSession(
  sessionId: string | number,
): Promise<Map<string, GuardianContact>> {
  const out = new Map<string, GuardianContact>();
  try {
    const url = `${BASE}/api/pandora/session-participants?locationId=${FASTTRAX_LOCATION_ID}&sessionId=${sessionId}&excludeRemoved=true&excludeUnpaid=false`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return out;
    const json = await res.json();
    const data: Participant[] = Array.isArray(json?.data) ? json.data : [];
    for (const p of data) {
      const g = p.guardian;
      if (g && (g.mobilePhone || g.homePhone || g.email)) {
        out.set(String(p.personId), g);
      }
    }
  } catch (err) {
    console.warn("[backfill-guardian] Pandora re-fetch failed for session", sessionId, err);
  }
  return out;
}

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
    // Pre-fetch fresh guardian data so the preview shows what the
    // real run would actually find (otherwise old match records
    // without guardian look hopeless even when Pandora has the
    // parent contact on file now).
    const drySessionsToFetch = new Set<string>();
    for (const m of candidates) {
      const has = !!m.guardian && (!!m.guardian.mobilePhone || !!m.guardian.homePhone || !!m.guardian.email);
      if (!has && m.sessionId !== "manual") drySessionsToFetch.add(String(m.sessionId));
    }
    const dryGuardianMap = new Map<string, GuardianContact>();
    await Promise.all(
      [...drySessionsToFetch].map(async (sid) => {
        const map = await fetchGuardiansForSession(sid);
        for (const [pid, g] of map) dryGuardianMap.set(`${sid}:${pid}`, g);
      }),
    );
    return NextResponse.json({
      dryRun: true,
      windowStart: new Date(startMs).toISOString(),
      windowEnd: new Date(endMs).toISOString(),
      total: matches.length,
      candidates: candidates.length,
      enrichableFromPandora: dryGuardianMap.size,
      skipped: skipped.length,
      skipReasons: skipped.reduce((acc, s) => {
        acc[s.reason] = (acc[s.reason] || 0) + 1;
        return acc;
      }, {} as Record<string, number>),
      candidateSample: candidates.slice(0, 50).map((m) => {
        const livedGuardian = m.guardian || dryGuardianMap.get(`${m.sessionId}:${m.personId}`) || null;
        return {
          videoCode: m.videoCode,
          firstName: m.firstName,
          lastName: m.lastName,
          racerPhone: m.mobilePhone || m.homePhone || m.phone || null,
          racerEmail: m.email || null,
          guardianFirstName: livedGuardian?.firstName || null,
          guardianPhone: livedGuardian?.mobilePhone || livedGuardian?.homePhone || null,
          guardianEmail: livedGuardian?.email || null,
          guardianSource: m.guardian ? "match-record" : (livedGuardian ? "pandora-refetch" : "none"),
          priorSmsError: m.notifySmsError || null,
          priorEmailError: m.notifyEmailError || null,
        };
      }),
    });
  }

  let smsSent = 0;
  let emailSent = 0;
  let viaGuardian = 0;
  let stillNoContact = 0;
  let errored = 0;
  let enrichedFromPandora = 0;

  // Pre-pass: candidates saved BEFORE the guardian-snapshot deploy
  // (commit 20a121d) carry no guardian on their match record, even
  // though Pandora has the data live now. Group by sessionId, fetch
  // each session's participants once, build a personId → guardian
  // map, and graft any guardian we find onto the match record before
  // we hand it to notifyVideoReady. Patched records are persisted so
  // future operations don't need to re-fetch.
  const sessionsToFetch = new Set<string>();
  for (const m of candidates) {
    const hasGuardian = !!m.guardian && (
      !!m.guardian.mobilePhone ||
      !!m.guardian.homePhone ||
      !!m.guardian.email
    );
    if (!hasGuardian && m.sessionId !== "manual") {
      sessionsToFetch.add(String(m.sessionId));
    }
  }
  const guardianBySessionPerson = new Map<string, GuardianContact>();
  await Promise.all(
    [...sessionsToFetch].map(async (sid) => {
      const map = await fetchGuardiansForSession(sid);
      for (const [pid, g] of map) {
        guardianBySessionPerson.set(`${sid}:${pid}`, g);
      }
    }),
  );

  for (const match of candidates) {
    try {
      // Graft fresh guardian data onto stale match records so the
      // notify path's pickVideoContact has something to fall back to.
      const hasGuardianAlready = !!match.guardian && (
        !!match.guardian.mobilePhone ||
        !!match.guardian.homePhone ||
        !!match.guardian.email
      );
      if (!hasGuardianAlready) {
        const g = guardianBySessionPerson.get(`${match.sessionId}:${match.personId}`);
        if (g) {
          match.guardian = g;
          enrichedFromPandora++;
        }
      }

      const entry = cameraHistoryEntryFromMatch(match);
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
    enrichedFromPandora,
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
