/**
 * Repair race_lap_results rows captured BEFORE the final lap.
 *
 * Context (2026-09-10): the standings snapshot behind the results wall, the
 * welcome-back split and the driver-view report was taken the instant the
 * race clock hit zero — the timing socket reports "finished" then — while
 * karts were still driving their final lap. Over the prior 14 days 95% of
 * races were captured before the venue's stamped end; 363 driver rows show a
 * slower best lap than the racer actually set, 16 of them on the wrong side
 * of a qualifying cutoff, and heat 28 that night archived the wrong winner.
 * The capture is fixed (standingsFinal in signage/briefing/results-frame.ts);
 * this repairs what it wrote before the fix.
 *
 * Two sources, in order of what they can fix:
 *   1. race_best_laps — folded live off every lap passing, so it holds the
 *      TRUE best lap per (session, racer). Repairs best_ms wherever the
 *      snapshot kept a slower one. Always available.
 *   2. Pandora scores (/v2/bmi/records/scores/{loc}/{sessionId}) — the
 *      venue's OFFICIAL positions and lap counts. Repairs position and laps
 *      for every session where any row was captured early. Needs
 *      SWAGGER_ADMIN_KEY; skipped (and said so) without it.
 *
 * Usage (from apps/web):
 *   node scripts/backfill-race-lap-results-final-lap.mjs            # dry run
 *   node scripts/backfill-race-lap-results-final-lap.mjs --apply    # writes
 *   node scripts/backfill-race-lap-results-final-lap.mjs --days=30  # window (default 30)
 *
 * Requires DATABASE_URL in apps/web/.env.local. --apply WRITES to the
 * production archive — get explicit approval before running it.
 *
 * BMI ids: persId/parId in the scores payload are 17-digit ids and are
 * stripped from the raw text BEFORE JSON.parse (CLAUDE.md § BMI ID Precision).
 * Session ids are handled as strings throughout.
 */
import { neon } from "@neondatabase/serverless";
import { readFileSync } from "fs";

const APPLY = process.argv.includes("--apply");
const DAYS = Number((process.argv.find((a) => a.startsWith("--days=")) ?? "--days=30").slice(7));

const PANDORA_HOST = "https://bma-pandora-api.azurewebsites.net";
const PANDORA_LOCATION = "LAB52GY480CJF";

function loadEnv(key) {
  if (process.env[key]) return process.env[key];
  try {
    const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
    const m = env.match(new RegExp(`^${key}\\s*=\\s*"?([^"\\r\\n]+)"?`, "m"));
    return m ? m[1] : undefined;
  } catch {
    return undefined;
  }
}

const databaseUrl = loadEnv("DATABASE_URL");
if (!databaseUrl) throw new Error("DATABASE_URL not found in env or .env.local");
const sql = neon(databaseUrl);
const pandoraKey = loadEnv("SWAGGER_ADMIN_KEY");

const since = new Date(Date.now() - DAYS * 86_400_000).toISOString().slice(0, 10);
console.log(`${APPLY ? "APPLY" : "DRY RUN"} — race_lap_results since business day ${since}`);

/* ── 1. best laps: the snapshot kept a slower lap than the racer set ────── */

const slow = await sql`
  SELECT r.session_id, r.driver_name, r.heat_name, r.best_ms, b.best_lap_ms
  FROM race_lap_results r
  JOIN race_best_laps b
    ON b.session_id = r.session_id AND b.participant_name = r.driver_name
  WHERE r.business_day >= ${since}
    AND (r.best_ms IS NULL OR r.best_ms > b.best_lap_ms)
  ORDER BY r.business_day, r.session_id`;

console.log(`\nbest_ms slower than the live lap feed: ${slow.length} driver rows`);
for (const row of slow.slice(0, 15)) {
  console.log(
    `  ${row.session_id} ${row.heat_name ?? "?"} · ${row.driver_name}: ${row.best_ms ?? "null"} → ${row.best_lap_ms}`,
  );
}
if (slow.length > 15) console.log(`  … ${slow.length - 15} more`);

if (APPLY && slow.length > 0) {
  let n = 0;
  for (const row of slow) {
    await sql`
      UPDATE race_lap_results SET best_ms = ${row.best_lap_ms}
      WHERE session_id = ${row.session_id} AND driver_name = ${row.driver_name}
        AND (best_ms IS NULL OR best_ms > ${row.best_lap_ms})`;
    n++;
  }
  console.log(`  wrote ${n} best_ms repairs`);
}

/* ── 2. positions + lap counts: the venue's official scores ─────────────── */

if (!pandoraKey) {
  console.log("\nSWAGGER_ADMIN_KEY not set — skipping position/lap repair from Pandora scores");
} else {
  // Every session captured before its stamped end is suspect for positions and
  // lap counts, whether or not a best lap moved.
  const early = await sql`
    SELECT r.session_id, max(r.heat_name) AS heat_name,
           round(EXTRACT(EPOCH FROM (max(t.ended_at) - min(r.recorded_at))))::int AS early_s
    FROM race_lap_results r
    JOIN race_timings t ON t.session_id = r.session_id
    WHERE r.business_day >= ${since} AND t.ended_at IS NOT NULL
    GROUP BY r.session_id
    HAVING min(r.recorded_at) < max(t.ended_at)
    ORDER BY min(r.recorded_at)`;
  console.log(`\nsessions captured before the stamped end: ${early.length}`);

  let sessionsChanged = 0;
  let rowsChanged = 0;
  let unreachable = 0;
  for (const s of early) {
    const scores = await fetchScores(s.session_id);
    if (!scores) {
      unreachable++;
      continue;
    }
    const rows = await sql`
      SELECT driver_name, position, laps FROM race_lap_results WHERE session_id = ${s.session_id}`;
    const byName = new Map(scores.map((sc) => [scoreName(sc), sc]));
    const changes = [];
    for (const r of rows) {
      const sc = byName.get(r.driver_name);
      if (!sc) continue;
      const position = typeof sc.position === "number" && sc.position > 0 ? sc.position : null;
      const laps = typeof sc.laps === "number" && sc.laps > 0 ? sc.laps : null;
      const posChanged = position !== null && position !== r.position;
      const lapsChanged = laps !== null && laps > (r.laps ?? 0);
      if (posChanged || lapsChanged) {
        changes.push({
          driver: r.driver_name,
          position: posChanged ? position : r.position,
          laps: lapsChanged ? laps : r.laps,
          was: { position: r.position, laps: r.laps },
        });
      }
    }
    if (changes.length === 0) continue;
    sessionsChanged++;
    rowsChanged += changes.length;
    console.log(`  ${s.session_id} ${s.heat_name ?? "?"} (captured ${s.early_s}s early):`);
    for (const c of changes) {
      console.log(`    ${c.driver}: P${c.was.position}/L${c.was.laps} → P${c.position}/L${c.laps}`);
      if (APPLY) {
        await sql`
          UPDATE race_lap_results SET position = ${c.position}, laps = ${c.laps}
          WHERE session_id = ${s.session_id} AND driver_name = ${c.driver}`;
      }
    }
  }
  console.log(
    `\nposition/lap repairs: ${rowsChanged} rows in ${sessionsChanged} sessions` +
      (unreachable ? ` (${unreachable} sessions had no scores in Pandora)` : "") +
      (APPLY ? " — written" : ""),
  );
}

console.log(APPLY ? "\ndone" : "\ndry run only — re-run with --apply to write");

/** Pandora's official scores for one session, ids stripped before parse. */
async function fetchScores(sessionId) {
  try {
    const res = await fetch(
      `${PANDORA_HOST}/v2/bmi/records/scores/${PANDORA_LOCATION}/${sessionId}`,
      {
        headers: { Authorization: `Bearer ${pandoraKey}`, Accept: "application/json" },
        signal: AbortSignal.timeout(8000),
      },
    );
    if (!res.ok) return null;
    const text = (await res.text()).replace(/"(persId|parId)"\s*:\s*(\d+)/g, '"$1":"$2"');
    const parsed = JSON.parse(text);
    return Array.isArray(parsed?.data) && parsed.data.length > 0 ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Same name rule as results-fallback.ts: alias (what the timing screens
 *  show) first, then name. */
function scoreName(row) {
  return String(row.alias || row.name || "").trim();
}
