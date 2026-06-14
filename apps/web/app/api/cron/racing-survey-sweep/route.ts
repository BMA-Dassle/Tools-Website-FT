import { NextRequest, NextResponse } from "next/server";
import redis from "@/lib/redis";
import { listMatchesInRange, type VideoMatch } from "@/lib/video-match";
import { enqueueRacingSurvey } from "~/features/guest-survey";
import { logCronRun } from "@/lib/sms-log";
import { verifyCron } from "@/lib/cron-auth";

/**
 * GET /api/cron/racing-survey-sweep
 *
 * Sends the FastTrax racing guest-survey ~15 min after each racer received
 * their race-video text. The video pipeline (video-match cron +
 * vt3-video-event webhook) stamps `notifySmsSentAt` / `notifyEmailSentAt`
 * on each VideoMatch the moment the video link goes out — this sweep uses
 * that timestamp as the anchor and fires the survey once enough time has
 * passed for the racer to have watched their video.
 *
 * Why a sweep and not an inline hook: serverless functions can't sleep for
 * 15 minutes. A 5-minute cron is restart-safe and idempotent — the survey
 * service de-dupes on (origin='racing', origin_ref=videoCode), so a match
 * that sits in the window across two ticks is only ever surveyed once.
 *
 * Candidate window: notify fired between NOTIFY_MIN_AGE (15 min) and
 * NOTIFY_MAX_AGE (6 h) ago. The upper bound keeps the first deploy from
 * blasting surveys at everyone matched in the last day, and stops us
 * surveying stale records long after the visit.
 *
 * Hard rules enforced here:
 *   - Minors are NEVER surveyed. A guardian on the match (or a notify that
 *     was routed via the guardian) means a minor — skip outright. The
 *     survey service double-guards on input.isMinor.
 *   - Only the racer's OWN contact is used (mobile/phone/home + own email);
 *     we never redirect a survey to a guardian.
 *   - Kill switch: GUEST_SURVEY_DISABLED=true pauses sends without a deploy.
 *
 * Schedule (vercel.json): every 5 minutes.
 */

const CRON_LOCK_KEY = "cron-lock:racing-survey-sweep";
const CRON_LOCK_TTL = 90;

/** FastTrax Square location id — the survey center_code for racing. */
const FASTTRAX_CENTER_CODE = "LAB52GY480CJF";

const NOTIFY_MIN_AGE_MS = 15 * 60 * 1000; // 15 min — give the racer time to watch
const NOTIFY_MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6 h — don't survey stale matches
/** matchedAt scan window. Wider than NOTIFY_MAX_AGE so pending-then-notified
 *  records (matched early, notified hours later) are still caught. */
const SCAN_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Earliest of the two notify timestamps, in epoch ms, or null if neither. */
function notifyAtMs(m: VideoMatch): number | null {
  const ts = m.notifySmsSentAt || m.notifyEmailSentAt;
  if (!ts) return null;
  const ms = new Date(ts).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** A guardian on file (or a guardian-routed notify) means a minor racer. */
function isMinor(m: VideoMatch): boolean {
  return !!m.guardian || m.viaGuardian === true;
}

/** Racer's OWN phone — never the guardian's. */
function racerPhone(m: VideoMatch): string | undefined {
  return m.mobilePhone || m.phone || m.homePhone || undefined;
}

export async function GET(req: NextRequest) {
  const denied = verifyCron(req);
  if (denied) return denied;

  const url = new URL(req.url);
  const dryRun = url.searchParams.get("dryRun") === "1";
  // Manual backfill knobs (ignored on the scheduled run):
  //   force=1       — bypass the 15-min minimum so racers notified moments
  //                   ago are surveyed now.
  //   windowMin=60  — only survey racers whose video notify fired within the
  //                   last N minutes (overrides the 6-h max age). Use with
  //                   force=1 for "send to everyone who raced in the past
  //                   hour". Idempotency, consent, frequency-cap and the
  //                   minor skip all still apply, so a backfill can't double-
  //                   send or reach a minor.
  const force = url.searchParams.get("force") === "1";
  const windowMinRaw = Number(url.searchParams.get("windowMin"));
  // once=<key>: one-shot guard. Lets a *recurring* Vercel cron entry behave
  // as a single fire — the first invocation claims the Redis key and runs;
  // every later invocation (e.g. the same daily cron tomorrow) sees the key
  // and no-ops. Used to schedule the week-long backfill for a specific day
  // without a bespoke one-time scheduler. TTL 7d so the key self-expires.
  const onceKey = url.searchParams.get("once");
  const minAge = force ? 0 : NOTIFY_MIN_AGE_MS;
  const maxAge =
    Number.isFinite(windowMinRaw) && windowMinRaw > 0
      ? windowMinRaw * 60 * 1000
      : NOTIFY_MAX_AGE_MS;
  const scanWindow = Math.max(SCAN_WINDOW_MS, maxAge);
  // Wider read for big backfills; the normal 6-h sweep never needs near this.
  const scanLimit = force || maxAge > NOTIFY_MAX_AGE_MS ? 5000 : 1000;
  const started = Date.now();

  if (process.env.GUEST_SURVEY_DISABLED === "true") {
    return NextResponse.json(
      { ok: true, skipped: "GUEST_SURVEY_DISABLED" },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  // Acquire the run-lock FIRST so two sweeps never process the same matches
  // concurrently (the cap is enforced sequentially within one run — see the
  // loop — so overlap is the only way the same person could be double-sent).
  if (!dryRun) {
    const acquired = await redis.set(CRON_LOCK_KEY, "1", "EX", CRON_LOCK_TTL, "NX");
    if (!acquired) {
      return NextResponse.json(
        { ok: true, locked: true, note: "previous run still in flight" },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
  }

  let candidates = 0;
  let sent = 0;
  let tooEarly = 0;
  let tooOld = 0;
  let notNotified = 0;
  let skippedMinor = 0;
  let skippedNoPhone = 0;
  let skippedBlocked = 0;
  let skippedOther = 0; // already-sent / consent / frequency / send-failure
  let errors = 0;

  try {
    // One-shot guard — claimed only AFTER we hold the lock and are about to
    // run, so a lock-collision never burns the key (which would make the
    // backfill silently skip forever). Released-by-TTL, not by us.
    if (onceKey && !dryRun) {
      // 90-day TTL: long enough that the daily cron entry can't re-fire the
      // backfill before someone removes it from vercel.json (the entry should
      // be deleted after its single run — it's a one-shot via this sentinel).
      const claimed = await redis.set(
        `racing-survey-backfill:${onceKey}`,
        "1",
        "EX",
        90 * 24 * 60 * 60,
        "NX",
      );
      if (claimed !== "OK") {
        return NextResponse.json(
          { ok: true, skipped: "once-already-fired", onceKey },
          { headers: { "Cache-Control": "no-store" } },
        );
      }
    }

    const now = Date.now();
    const matches = await listMatchesInRange({
      startMs: now - scanWindow,
      endMs: now,
      limit: scanLimit,
    });

    // Anti-spam layer 1 (in-run): a racer with several visits in the window
    // has several matches here. We attempt AT MOST ONE survey per racer per
    // run, keyed on their phone — so multiple visits can never fan out into
    // multiple sends even before the (layer 2) 30-day per-customer cap and
    // (layer 3) origin_ref idempotency get involved. matches are newest-first,
    // so the kept one is their most recent visit.
    const seenPhones = new Set<string>();
    let dedupedMultiVisit = 0;

    for (const m of matches) {
      const at = notifyAtMs(m);
      if (at == null) {
        notNotified++;
        continue;
      }
      const age = now - at;
      if (age < minAge) {
        tooEarly++; // caught on a later tick
        continue;
      }
      if (age > maxAge) {
        tooOld++;
        continue;
      }
      candidates++;

      if (m.blocked) {
        skippedBlocked++;
        continue;
      }
      if (isMinor(m)) {
        skippedMinor++;
        continue;
      }
      const phone = racerPhone(m);
      if (!phone) {
        skippedNoPhone++;
        continue;
      }
      // One attempt per racer per run (covers the multi-visit backfill case).
      if (seenPhones.has(phone)) {
        dedupedMultiVisit++;
        continue;
      }
      seenPhones.add(phone);

      if (dryRun) {
        sent++; // would-send count in dry-run (already deduped per racer)
        continue;
      }

      try {
        // visitDate in the center's timezone (America/New_York for FastTrax).
        const visitDate = new Date(m.capturedAt || m.matchedAt).toLocaleDateString("en-CA", {
          timeZone: "America/New_York",
        });
        const outcome = await enqueueRacingSurvey({
          videoCode: m.videoCode,
          phone,
          guestName: `${m.firstName ?? ""} ${m.lastName ?? ""}`.trim() || undefined,
          guestEmail: m.email,
          centerCode: FASTTRAX_CENTER_CODE,
          visitDate,
          isMinor: false, // already filtered above; double-guard in the service
        });
        if (outcome.status === "sent") {
          sent++;
        } else {
          skippedOther++;
        }
        console.log(
          `[racing-survey-sweep] videoCode=${m.videoCode} outcome=${outcome.status}` +
            (outcome.status === "skipped" ? ` reason=${outcome.reason}` : ""),
        );
      } catch (err) {
        errors++;
        console.error(
          `[racing-survey-sweep] enqueue threw videoCode=${m.videoCode}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    await logCronRun({
      ts: new Date().toISOString(),
      cron: "racing-survey-sweep",
      dryRun,
      elapsedMs: Date.now() - started,
      invoker: req.headers.get("x-vercel-cron")
        ? "vercel-cron"
        : req.headers.get("user-agent") || "unknown",
      candidates,
      sent,
      skipped: skippedMinor + skippedNoPhone + skippedBlocked + skippedOther,
      errors,
    });

    return NextResponse.json(
      {
        ok: true,
        dryRun,
        force,
        windowMin: maxAge / 60000,
        elapsedMs: Date.now() - started,
        scanned: matches.length,
        dedupedMultiVisit,
        candidates,
        sent,
        tooEarly,
        tooOld,
        notNotified,
        skippedMinor,
        skippedNoPhone,
        skippedBlocked,
        skippedOther,
        errors,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    console.error("[racing-survey-sweep] error:", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "cron error", sent, errors },
      { status: 500 },
    );
  } finally {
    if (!dryRun) {
      try {
        await redis.del(CRON_LOCK_KEY);
      } catch {
        /* best-effort */
      }
    }
  }
}
