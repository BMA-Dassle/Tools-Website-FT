import { NextRequest, NextResponse } from "next/server";
import { Redis } from "ioredis";

const REDIS_URL = process.env.REDIS_URL || process.env.KV_URL || "";
const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://fasttraxent.com";
const LOCATION_ID = "LAB52GY480CJF"; // FastTrax Fort Myers

// Qualifying thresholds (in milliseconds, from the racing progression chart)
// Starter → Intermediate: 41s Blue / 46s Red
// Intermediate → Pro: 32.5s Blue / 37s Red
const QUALIFY_INTERMEDIATE_BLUE = 41_000;
const QUALIFY_INTERMEDIATE_RED = 46_000;
const QUALIFY_PRO_BLUE = 32_500;
const QUALIFY_PRO_RED = 37_000;

// Score groups to scan (customize as needed)
const SCORE_GROUPS = [
  { name: "Red Starter", track: "Red Track" },
  { name: "Red Intermediate", track: "Red Track" },
  { name: "Red Pro", track: "Red Track" },
  { name: "Blue Starter", track: "Blue Track" },
  { name: "Blue Intermediate", track: "Blue Track" },
  { name: "Blue Pro", track: "Blue Track" },
];

interface SessionScore {
  parId: number;
  sessionName: string;
  position: number;
  scoreTime: string;
  bestLap: number; // milliseconds
  laps: number;
  average: number;
  name: string;
  persId: number;
  scoreGroupId: number;
}

interface Session {
  sessionId: number;
  name: string;
  scheduledStart: string;
  actualStart: string;
  state: number; // 3 = finished
}

/**
 * Determine what level a racer qualifies for based on lap time + track.
 * Returns the level NAME they qualify for, or null if they don't qualify for anything new.
 */
function qualifiesFor(bestLapMs: number, track: string): "Intermediate" | "Pro" | null {
  const isBlue = track.toLowerCase().includes("blue");
  const intermediateCutoff = isBlue ? QUALIFY_INTERMEDIATE_BLUE : QUALIFY_INTERMEDIATE_RED;
  const proCutoff = isBlue ? QUALIFY_PRO_BLUE : QUALIFY_PRO_RED;
  if (bestLapMs <= proCutoff) return "Pro";
  if (bestLapMs <= intermediateCutoff) return "Intermediate";
  return null;
}

/**
 * Check if a racer's BMI profile has a specific qualification membership.
 */
async function hasMembership(persId: number, levelName: "Intermediate" | "Pro"): Promise<{
  hasIt: boolean;
  email: string;
  phone: string;
  firstName: string;
  lastName: string;
  loginCode: string;
} | null> {
  try {
    const res = await fetch(`${BASE_URL}/api/bmi-office?action=person&id=${persId}`);
    if (!res.ok) return null;
    const p = await res.json();
    const target = `Qualified ${levelName}`;
    const memberships = p.memberships || [];
    const hasIt = memberships.some((m: { name: string; stops?: string }) =>
      m.name === target && (!m.stops || new Date(m.stops) > new Date())
    );
    const email = p.addresses?.[0]?.email || "";
    const phone = (p.addresses?.[0]?.phone || "").replace(/\D/g, "");
    const firstName = p.firstName || "";
    const lastName = p.name || "";
    const tags = (p.tags || []).sort((a: { lastSeen: string }, b: { lastSeen: string }) =>
      (b.lastSeen || "").localeCompare(a.lastSeen || "")
    );
    const loginCode = tags[0]?.tag || "";
    return { hasIt, email, phone, firstName, lastName, loginCode };
  } catch {
    return null;
  }
}

/**
 * Format lap time in seconds (e.g. 36785ms → "36.785")
 */
function formatLap(ms: number): string {
  return (ms / 1000).toFixed(3);
}

/**
 * Cron job: Level-up detection + notification.
 * Runs every 2 minutes. Two phases:
 *
 * PHASE 1 — Detection: Scan recently finished sessions, identify racers
 *   whose best lap qualifies them for a higher tier. Create a "watch" entry.
 *
 * PHASE 2 — Verification: For each watched racer, check if BMI has added the
 *   Qualified {level} membership. If so, send email/SMS and clear watch.
 *   If 15 min passed with no membership, give up.
 */
export async function GET(_req: NextRequest) {
  const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 2, lazyConnect: true });
  try {
    await redis.connect();

    // Today's date range in ET
    const now = new Date();
    const etFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
    const todayET = etFormatter.format(now);
    const startDate = `${todayET}T00:00:00`;
    const endDate = `${todayET}T23:59:59`;

    // ───────────────────────── PHASE 1: DETECTION ─────────────────────────
    const newWatches: string[] = [];
    for (const sg of SCORE_GROUPS) {
      try {
        // Fetch finished sessions
        const sessUrl = `${BASE_URL}/api/leagues?action=sessions&location=${LOCATION_ID}&track=${encodeURIComponent(sg.track)}&scoreGroup=${encodeURIComponent(sg.name)}&startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}`;
        const sessRes = await fetch(sessUrl);
        if (!sessRes.ok) continue;
        const sessJson = await sessRes.json();
        const sessions: Session[] = sessJson.data || sessJson || [];

        // Only sessions finished in the last 10 minutes
        const cutoffMs = Date.now() - 10 * 60_000;
        const recent = sessions.filter(s => {
          if (s.state < 3) return false;
          const ts = new Date(s.actualStart || s.scheduledStart).getTime();
          return ts >= cutoffMs;
        });

        for (const sess of recent) {
          // Skip if we've already processed this session
          const processedKey = `levelup:session:${sess.sessionId}`;
          const processed = await redis.get(processedKey);
          if (processed) continue;

          // Fetch scores
          const scoresUrl = `${BASE_URL}/api/leagues?action=scores&location=${LOCATION_ID}&sessionId=${sess.sessionId}`;
          const scoresRes = await fetch(scoresUrl);
          if (!scoresRes.ok) continue;
          const scoresJson = await scoresRes.json();
          const scores: SessionScore[] = scoresJson.data || scoresJson || [];

          for (const score of scores) {
            if (!score.bestLap || !score.persId) continue;
            const newLevel = qualifiesFor(score.bestLap, sg.track);
            if (!newLevel) continue;

            // Has this racer already been notified at this level?
            const sentKey = `levelup:sent:${score.persId}:${newLevel}`;
            const alreadySent = await redis.get(sentKey);
            if (alreadySent) continue;

            // Already watching?
            const watchKey = `levelup:watch:${score.persId}:${newLevel}`;
            const existing = await redis.get(watchKey);
            if (existing) continue;

            // Create watch (1hr TTL — gives up to 1hr for membership to appear)
            const watch = {
              persId: score.persId,
              levelName: newLevel,
              racerName: score.name,
              bestLapMs: score.bestLap,
              trackName: sg.track,
              scoreGroupName: sg.name,
              sessionId: sess.sessionId,
              sessionActualStart: sess.actualStart,
              createdAt: new Date().toISOString(),
              attempts: 0,
            };
            await redis.set(watchKey, JSON.stringify(watch), "EX", 60 * 60);
            await redis.sadd("levelup:watches", `${score.persId}:${newLevel}`);
            await redis.expire("levelup:watches", 60 * 60);
            newWatches.push(`${score.name} → ${newLevel} (${formatLap(score.bestLap)}s on ${sg.track})`);
          }

          // Mark session as processed
          await redis.set(processedKey, "1", "EX", 24 * 60 * 60);
        }
      } catch (err) {
        console.error(`[level-up-watch] phase1 error for ${sg.name}:`, err);
      }
    }

    // ───────────────────────── PHASE 2: VERIFICATION ─────────────────────
    const sent: string[] = [];
    const stillWaiting: string[] = [];
    const gaveUp: string[] = [];

    const watchIds = await redis.smembers("levelup:watches");
    for (const wid of watchIds) {
      const [persIdStr, levelName] = wid.split(":");
      if (!persIdStr || (levelName !== "Intermediate" && levelName !== "Pro")) continue;

      const watchKey = `levelup:watch:${persIdStr}:${levelName}`;
      const raw = await redis.get(watchKey);
      if (!raw) {
        // Expired — remove from set
        await redis.srem("levelup:watches", wid);
        continue;
      }

      const watch = JSON.parse(raw);
      const persId = parseInt(persIdStr, 10);

      // Give up after 15 min (safety net — BMI usually within 5 min)
      const ageMin = (Date.now() - new Date(watch.createdAt).getTime()) / 60_000;
      if (ageMin > 15) {
        await redis.del(watchKey);
        await redis.srem("levelup:watches", wid);
        await redis.rpush("levelup:gave-up", JSON.stringify({ ...watch, gaveUpAt: new Date().toISOString() }));
        await redis.expire("levelup:gave-up", 30 * 24 * 60 * 60);
        gaveUp.push(`${watch.racerName} → ${levelName}`);
        continue;
      }

      // Check BMI for membership
      const person = await hasMembership(persId, levelName as "Intermediate" | "Pro");
      if (!person) {
        stillWaiting.push(`${watch.racerName} → ${levelName} (BMI lookup failed)`);
        continue;
      }
      if (!person.hasIt) {
        // Not yet — increment attempts, keep watching
        watch.attempts = (watch.attempts || 0) + 1;
        await redis.set(watchKey, JSON.stringify(watch), "EX", 60 * 60);
        stillWaiting.push(`${watch.racerName} → ${levelName} (attempt ${watch.attempts})`);
        continue;
      }

      // Membership confirmed — send notification
      const sessionTime = new Date(watch.sessionActualStart).toLocaleTimeString("en-US", {
        hour: "numeric", minute: "2-digit", hour12: true,
      });
      const notifRes = await fetch(`${BASE_URL}/api/notifications/level-up`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          persId,
          email: person.email,
          phone: person.phone,
          racerName: watch.racerName,
          levelName,
          bestLapTime: formatLap(watch.bestLapMs) + "s",
          trackName: watch.trackName,
          sessionTime,
          loginCode: person.loginCode,
          smsOptIn: !!person.phone,
        }),
      });

      if (notifRes.ok) {
        const result = await notifRes.json();
        await redis.del(watchKey);
        await redis.srem("levelup:watches", wid);
        sent.push(`${watch.racerName} → ${levelName} (email=${result.emailSent}, sms=${result.smsSent})`);
      } else {
        stillWaiting.push(`${watch.racerName} → ${levelName} (notif API failed)`);
      }
    }

    redis.disconnect();
    return NextResponse.json({
      date: todayET,
      newWatches: newWatches.length,
      newWatchDetails: newWatches.length > 0 ? newWatches : undefined,
      sent: sent.length,
      sentDetails: sent.length > 0 ? sent : undefined,
      stillWaiting: stillWaiting.length,
      gaveUp: gaveUp.length,
      gaveUpDetails: gaveUp.length > 0 ? gaveUp : undefined,
    });
  } catch (err) {
    redis.disconnect();
    console.error("[level-up-watch] error:", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 500 });
  }
}
