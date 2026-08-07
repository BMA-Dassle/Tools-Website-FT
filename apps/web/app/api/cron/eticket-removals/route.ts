import { NextRequest, NextResponse } from "next/server";
import redis from "@/lib/redis";
import { verifyCron } from "@/lib/cron-auth";
import { logCronRun } from "@/lib/sms-log";
import {
  clearSeenRemoved,
  etYmd,
  forgetNotified,
  markSeenRemoved,
  moveSignals,
  notifiedSessionIds,
  readNotified,
  removalSweepEnabled,
  removalVerdict,
  sendRemovalSms,
  type NotifiedRacer,
} from "~/features/racing/eticket/removal-sweep";

/**
 * Flow C — e-ticket retraction sweep.
 *
 * Every 2 min: for each heat we have already e-ticketed today, pull the roster
 * TWICE (excludeRemoved true and false) and diff. Anyone in the all-state list
 * but not the active one is at F_PAR_STATE = 5 — genuinely scratched — and gets
 * told, once, that their ticket is dead.
 *
 * See features/racing/eticket/removal-sweep.ts for why the diff is the only
 * available signal, why it fails closed, and why a MOVE must never reach here.
 *
 * ?dryRun=1 — log who would be retracted, send nothing.
 */

const BASE = process.env.NEXT_PUBLIC_SITE_URL || "https://fasttraxent.com";
const FASTTRAX_LOCATION_ID = "LAB52GY480CJF";
const RESOURCES = ["Blue Track", "Red Track", "Mega Track"] as const;

const CRON_LOCK_KEY = "cron-lock:eticket-removals";
const CRON_LOCK_TTL = 90;

interface SessionRow {
  sessionId?: string | number;
  scheduledStart?: string;
  actualStart?: string | null;
  actualEnd?: string | null;
}

/** Today's schedule across all tracks. `prefer=cache` — the pre-race and
 *  check-in crons warm this every 1-2 min, so this is a Redis read in practice
 *  and never puts this sweep on Pandora's critical path. */
async function fetchTodaySessions(ymd: string): Promise<Map<string, SessionRow>> {
  const byId = new Map<string, SessionRow>();
  await Promise.all(
    RESOURCES.map(async (resourceName) => {
      try {
        const qs = new URLSearchParams({
          locationId: FASTTRAX_LOCATION_ID,
          resourceName,
          startDate: `${ymd}T00:00:00`,
          endDate: `${ymd}T23:59:59`,
          prefer: "cache",
        }).toString();
        const res = await fetch(`${BASE}/api/pandora/sessions?${qs}`, {
          cache: "no-store",
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) return;
        const json = await res.json();
        for (const s of Array.isArray(json?.data) ? (json.data as SessionRow[]) : []) {
          const id = s.sessionId == null ? "" : String(s.sessionId);
          if (id) byId.set(id, s);
        }
      } catch {
        /* one track failing must not strand the others */
      }
    }),
  );
  return byId;
}

/**
 * One roster read. Returns null on ANY doubt — non-200, malformed body, or a
 * response the proxy flagged `stale` (its cache-on-upstream-failure path).
 * A null here skips the whole session: we would rather retract nothing than
 * retract on data we cannot stand behind.
 *
 * No `x-pandora-internal` header on purpose — the redacted response is
 * `{ personId, checkedIn }`, which is everything the diff needs, so this route
 * never pulls co-racer PII it has no use for.
 */
async function rosterPersonIds(
  sessionId: string,
  excludeRemoved: boolean,
  preferCache = false,
): Promise<Set<string> | null> {
  try {
    const qs = new URLSearchParams({
      locationId: FASTTRAX_LOCATION_ID,
      sessionId,
      excludeRemoved: String(excludeRemoved),
      excludeUnpaid: "false",
      // The wide move-check reads cron-warmed cache so scanning the rest of
      // the day costs Redis, not Pandora. The decision rosters never do.
      ...(preferCache ? { prefer: "cache" } : { warm: "1" }),
    }).toString();
    const res = await fetch(`${BASE}/api/pandora/session-participants?${qs}`, {
      cache: "no-store",
    });
    if (!res.ok) return null;
    const json = await res.json();
    if (json?.stale) return null;
    if (!Array.isArray(json?.data)) return null;
    return new Set(
      (json.data as { personId: string | number }[])
        .map((p) => String(p.personId ?? "").trim())
        .filter(Boolean),
    );
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const denied = verifyCron(req);
  if (denied) return denied;

  const dryRun = new URL(req.url).searchParams.get("dryRun") === "1";
  const started = Date.now();

  if (!removalSweepEnabled()) {
    return NextResponse.json(
      { ok: true, disabled: true, note: "ETICKET_REMOVAL_SWEEP=false" },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

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
  let skipped = 0;
  let errors = 0;
  const reasons: Record<string, number> = {};
  const detail: { sessionId: string; personId: string; verdict: string }[] = [];
  const sessionNotes: { sessionId: string; reason: string }[] = [];

  try {
    const ymd = etYmd();
    const sessionIds = await notifiedSessionIds(ymd);
    const schedule = await fetchTodaySessions(ymd);

    // Pass 1 — read rosters for every eligible session BEFORE judging anyone.
    // `activeElsewhere` is the strongest move guard and it only works if the
    // whole picture is in hand first, so this genuinely needs the barrier.
    const rosters = new Map<string, { active: Set<string>; allStates: Set<string> }>();
    const activeElsewhereAll = new Set<string>();

    for (const sessionId of sessionIds) {
      const s = schedule.get(sessionId);

      // A heat that has gone off is beyond retracting — the racer either
      // raced or did not, and a text now is noise. Same actualStart/actualEnd
      // truth licence-clear.ts keys off, for the same reason: the clock lies
      // about when heats run, BMI does not.
      if (s && (s.actualStart || s.actualEnd)) {
        sessionNotes.push({ sessionId, reason: "heat-already-ran" });
        continue;
      }
      // Unknown session — schedule fetch failed or it is not today's. Never
      // guess; leaving it costs one late retraction, guessing costs a wrong one.
      if (!s) {
        sessionNotes.push({ sessionId, reason: "session-unknown" });
        continue;
      }

      const notified = await readNotified(sessionId);
      if (notified.length === 0) {
        sessionNotes.push({ sessionId, reason: "nobody-notified" });
        continue;
      }

      const [active, allStates] = await Promise.all([
        rosterPersonIds(sessionId, true),
        rosterPersonIds(sessionId, false),
      ]);
      // FAIL CLOSED. Either call in doubt, or an empty all-state roster (which
      // would make every notified racer look scratched at once), and we walk
      // away from this session entirely.
      if (!active || !allStates || allStates.size === 0) {
        sessionNotes.push({ sessionId, reason: "roster-unavailable" });
        continue;
      }
      rosters.set(sessionId, { active, allStates });
      for (const p of active) activeElsewhereAll.add(p);
    }

    // Pass 2 — judge everything EXCEPT the "are they racing elsewhere" guard,
    // which needs a wider view than the sessions we happen to have swept.
    const pending: { sessionId: string; racer: NotifiedRacer; personId: string }[] = [];

    for (const [sessionId, { active, allStates }] of rosters) {
      const notified = await readNotified(sessionId);
      const activeElsewhere = new Set([...activeElsewhereAll].filter((p) => !active.has(p)));

      for (const racer of notified) {
        candidates++;
        const personId = String(racer.personId);
        const nowMs = Date.now();

        if (active.has(personId)) {
          await clearSeenRemoved(sessionId, personId);
          skipped++;
          reasons["still-on-roster"] = (reasons["still-on-roster"] || 0) + 1;
          continue;
        }

        const { ticketMoved, refSessionId } = await moveSignals(racer);
        // Grace clock starts on the first sighting; a racer who returns has it
        // cleared above, so a later removal gets a fresh window.
        const firstSeenMs = await markSeenRemoved(sessionId, personId, nowMs);

        const verdict = removalVerdict(sessionId, personId, {
          active,
          allStates,
          activeElsewhere,
          ticketMoved,
          refSessionId,
          firstSeenMs,
          nowMs,
        });

        if (!verdict.act) {
          skipped++;
          reasons[verdict.reason] = (reasons[verdict.reason] || 0) + 1;
          // A move is settled, not pending — stop tracking so we never revisit.
          if (verdict.reason === "moved") {
            await clearSeenRemoved(sessionId, personId);
            if (!dryRun) await forgetNotified(sessionId, personId);
          }
          detail.push({ sessionId, personId, verdict: verdict.reason });
          continue;
        }
        pending.push({ sessionId, racer, personId });
      }
    }

    // Pass 3 — the wide move check, paid for ONLY when someone is actually
    // about to be retracted.
    //
    // A replay of 2026-08-06 against live rosters proved this is load-bearing:
    // with `activeElsewhere` built only from swept sessions, racer 18586763 —
    // who was bounced across four heats in twelve minutes — drew four
    // retractions. Every one was a MOVE that pre-race-tickets had already
    // alerted on. The gap is that a racer moved to a heat we have not
    // e-ticketed yet is invisible to a guard built from e-ticketed heats.
    //
    // "Active on some other heat today" is the definitive move test, so it has
    // to be asked against the whole day. `prefer=cache` keeps it to Redis reads
    // of cron-warmed rosters, and finished heats are skipped — nobody is moved
    // into a race that already ran.
    if (pending.length > 0) {
      const wide = new Set(activeElsewhereAll);
      for (const [sid, s] of schedule) {
        if (rosters.has(sid)) continue; // already counted
        if (s.actualEnd) continue; // cannot be moved into a finished heat
        const active = await rosterPersonIds(sid, true, true);
        if (!active) continue;
        for (const p of active) wide.add(p);
      }

      for (const { sessionId, racer, personId } of pending) {
        const ownActive = rosters.get(sessionId)?.active;
        if (ownActive?.has(personId)) continue; // re-added while we worked
        if (wide.has(personId)) {
          skipped++;
          reasons["moved"] = (reasons["moved"] || 0) + 1;
          detail.push({ sessionId, personId, verdict: "moved" });
          await clearSeenRemoved(sessionId, personId);
          if (!dryRun) await forgetNotified(sessionId, personId);
          continue;
        }

        const res = await sendRemovalSms(sessionId, racer, dryRun);
        if (res.ok) {
          sent++;
          detail.push({ sessionId, personId, verdict: "RETRACTED" });
        } else if (res.skipped) {
          skipped++;
          reasons[res.skipped] = (reasons[res.skipped] || 0) + 1;
          // Nothing to send to / given up — stop reconsidering every tick.
          if (res.skipped === "no-phone" || res.skipped === "attempts-exhausted") {
            if (!dryRun) await forgetNotified(sessionId, personId);
          }
        } else {
          errors++;
        }
      }
    }

    await logCronRun({
      ts: new Date().toISOString(),
      cron: "eticket-removal",
      dryRun,
      elapsedMs: Date.now() - started,
      invoker: req.headers.get("x-vercel-cron")
        ? "vercel-cron"
        : req.headers.get("user-agent") || "unknown",
      candidates,
      sent,
      skipped,
      errors,
    });

    return NextResponse.json({
      ok: true,
      dryRun,
      elapsedMs: Date.now() - started,
      sessionsTracked: sessionIds.length,
      sessionsSwept: rosters.size,
      candidates,
      sent,
      skipped,
      errors,
      reasons,
      sessionNotes,
      detail,
    });
  } catch (err) {
    console.error("[eticket-removals] error:", err);
    await logCronRun({
      ts: new Date().toISOString(),
      cron: "eticket-removal",
      dryRun,
      elapsedMs: Date.now() - started,
      invoker: req.headers.get("x-vercel-cron")
        ? "vercel-cron"
        : req.headers.get("user-agent") || "unknown",
      candidates,
      sent,
      skipped,
      errors,
      fatalError: err instanceof Error ? err.message : "cron error",
    });
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
