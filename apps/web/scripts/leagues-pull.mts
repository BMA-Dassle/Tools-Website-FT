/**
 * The league standings pull — off switch, on switch, and the one-shot warm.
 *
 * `/api/leagues` standings + summary reads consult a Redis kill switch. While it
 * is set, the public /leagues page NEVER calls Pandora: it serves the copy we
 * kept, at any age, because a finished season's standings cannot change. Nothing
 * about the sessions/scores reads is affected — those belong to
 * /api/cron/level-up-watch's tier qualification, not to the league.
 *
 *   npx tsx scripts/leagues-pull.mts status   # is it frozen, and what is cached
 *   npx tsx scripts/leagues-pull.mts warm     # pull the /leagues page's reads once
 *   npx tsx scripts/leagues-pull.mts freeze   # stop pulling (warm first!)
 *   npx tsx scripts/leagues-pull.mts resume    # next league season
 *
 * `freeze` refuses to run if the page's reads are not all cached — a freeze with
 * a cold cache is a 503 on the standings page, and finding that out from a guest
 * is not the plan.
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
import https from "node:https";
import Redis from "ioredis";

const HOST = "bma-pandora-api.azurewebsites.net";
const KEY = process.env.SWAGGER_ADMIN_KEY || "";
const FROZEN_KEY = "pandora:leagues:pull-frozen";
const RETENTION_SECONDS = 30 * 24 * 60 * 60;

/** The reads app/leagues/page.tsx actually makes: one `summary` per league leg
 *  (plus Blue's legacy-name fallback), always excludePractice=true. Kept in step
 *  with LEAGUE in that file by hand — there are three of them and they change
 *  once a season. */
const LOCATION = "LAB52GY480CJF";
const PAGE_READS: Array<{ label: string; track: string; scoreGroup: string }> = [
  {
    label: "Blue (canonical)",
    track: "Blue Track",
    scoreGroup: "Blue League (April to July 2026)",
  },
  { label: "Blue (legacy)", track: "Blue Track", scoreGroup: "Blue League (4/1/26-7/8/26)" },
  { label: "Red (canonical)", track: "Red Track", scoreGroup: "Red League (April to July 2026)" },
];

const encodeScoreGroup = (name: string) => encodeURIComponent(name).replace(/%2F/gi, "%252F");

function summaryPath(track: string, scoreGroup: string): string {
  return (
    `/v2/bmi/records/summary/${LOCATION}/${encodeURIComponent(track)}/${encodeScoreGroup(scoreGroup)}` +
    `?startDate=${encodeURIComponent("2026-01-01T00:00:00")}` +
    `&endDate=${encodeURIComponent("2026-12-31T23:59:59")}&excludePractice=true`
  );
}

const cacheKey = (path: string) => `pandora:leagues:v1:${path}`;

function pandoraGet(path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      { hostname: HOST, path, headers: { Authorization: `Bearer ${KEY}` } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode || 500, body: data }));
      },
    );
    req.on("error", reject);
    req.setTimeout(20_000, () => {
      req.destroy();
      reject(new Error("Timeout"));
    });
  });
}

const redis = new Redis(process.env.REDIS_URL || "", { maxRetriesPerRequest: 2 });

function describe(raw: string | null): { ok: boolean; text: string } {
  if (!raw) return { ok: false, text: "NOT CACHED" };
  try {
    const env = JSON.parse(raw) as { body: string; cachedAt: number };
    const rows = (JSON.parse(env.body) as { data?: unknown[] })?.data;
    const ageMin = Math.round((Date.now() - env.cachedAt) / 60_000);
    return {
      ok: true,
      text: `${Array.isArray(rows) ? `${rows.length} drivers` : "no data[]"}, ${ageMin} min old`,
    };
  } catch {
    return { ok: false, text: "UNREADABLE ENVELOPE" };
  }
}

async function status(): Promise<boolean> {
  const frozen = (await redis.get(FROZEN_KEY)) !== null;
  console.log(`pull: ${frozen ? "FROZEN — /leagues serves the kept copy" : "LIVE"}`);
  let allCached = true;
  for (const r of PAGE_READS) {
    const d = describe(await redis.get(cacheKey(summaryPath(r.track, r.scoreGroup))));
    if (!d.ok) allCached = false;
    console.log(`  ${r.label.padEnd(18)} ${d.text}`);
  }
  return allCached;
}

async function warm(): Promise<void> {
  for (const r of PAGE_READS) {
    const path = summaryPath(r.track, r.scoreGroup);
    try {
      const res = await pandoraGet(path);
      if (res.status >= 400) {
        console.log(`  ${r.label.padEnd(18)} pandora ${res.status} — left as-is`);
        continue;
      }
      const rows = (JSON.parse(res.body) as { data?: unknown[] })?.data;
      // Never overwrite a real copy with an empty one: the legacy-name read is
      // EXPECTED to come back empty, and the page only falls back to it when the
      // canonical name has no rows.
      if (!Array.isArray(rows) || rows.length === 0) {
        console.log(`  ${r.label.padEnd(18)} 0 rows — not cached (kept whatever was there)`);
        continue;
      }
      await redis.set(
        cacheKey(path),
        JSON.stringify({ status: res.status, body: res.body, cachedAt: Date.now() }),
        "EX",
        RETENTION_SECONDS,
      );
      console.log(`  ${r.label.padEnd(18)} cached ${rows.length} drivers`);
    } catch (err) {
      console.log(`  ${r.label.padEnd(18)} FAILED — ${err instanceof Error ? err.message : err}`);
    }
  }
}

const command = process.argv[2] || "status";
switch (command) {
  case "status":
    await status();
    break;
  case "warm":
    await warm();
    console.log("");
    await status();
    break;
  case "freeze": {
    const ready = await status();
    // The legacy-name read is allowed to be missing — the page only reaches for
    // it when the canonical name is empty, and it is empty by design today.
    const canonicalCached = (
      await Promise.all(
        PAGE_READS.filter((r) => r.label.includes("canonical")).map(
          async (r) => describe(await redis.get(cacheKey(summaryPath(r.track, r.scoreGroup)))).ok,
        ),
      )
    ).every(Boolean);
    if (!canonicalCached) {
      console.log("\nREFUSING to freeze — run `warm` first, or the page 503s.");
      process.exit(1);
    }
    await redis.set(FROZEN_KEY, new Date().toISOString());
    console.log(`\npull FROZEN${ready ? "" : " (legacy-name read uncached, which is expected)"}`);
    break;
  }
  case "resume":
    await redis.del(FROZEN_KEY);
    console.log("pull LIVE again — standings refresh on the normal 1h window");
    break;
  default:
    console.log("usage: leagues-pull.mts [status|warm|freeze|resume]");
    process.exit(1);
}

await redis.quit();
process.exit(0);
