/**
 * One-off: populate `nfl_games` so a PREVIEW deploy has a schedule to sell.
 *
 * Production does not need this. The nightly cron
 * (/api/cron/nfl-schedule-sync → features/nfl/espn.server) is the real path and
 * owns flex-kickoff handling, the locked-kickoff guard and the empty-feed guard.
 * But `verifyCron` short-circuits on any non-production VERCEL_ENV, so a preview
 * never syncs itself — and the seed scripts in this repo deliberately do not
 * import from src, because tsx does not resolve the `~/` and `@/` aliases the
 * module graph is built on.
 *
 * So this mirrors the sync's INSERT rather than importing it. Kept deliberately
 * thin, and it inherits the two guards that matter:
 *   - a game whose kickoff is LOCKED (it has a live booking) is never moved;
 *   - an empty feed deactivates nothing, because a 200 carrying no events is
 *     what a healthy off-season request looks like, not a mass cancellation.
 *
 * Usage: node apps/web/scripts/nfl-schedule-bootstrap.mjs [--days 45]
 */

import { readFileSync, existsSync } from "node:fs";
import { neon } from "@neondatabase/serverless";

for (const p of [
  "apps/web/.env.local",
  "../../apps/web/.env.local",
  "C:/GIT/Tools-Website-FT/apps/web/.env.local",
]) {
  if (!existsSync(p)) continue;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    let v = t.slice(i + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    if (!process.env[t.slice(0, i).trim()]) process.env[t.slice(0, i).trim()] = v;
  }
  break;
}

const argv = process.argv.slice(2);
const days = Number(argv[argv.indexOf("--days") + 1]) || 45;
const sql = neon(process.env.DATABASE_URL ?? "");

const etYmd = (d) => d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const compact = (ymd) => ymd.replace(/-/g, "");

const now = new Date();
const from = etYmd(now);
const to = etYmd(new Date(now.getTime() + days * 86400000));

async function ensureSchema() {
  await sql`
    CREATE TABLE IF NOT EXISTS nfl_games (
      game_id      TEXT        PRIMARY KEY,
      kickoff_at   TIMESTAMPTZ NOT NULL,
      date_et      DATE        NOT NULL,
      away_team    TEXT        NOT NULL,
      home_team    TEXT        NOT NULL,
      network      TEXT,
      week         INTEGER,
      season       INTEGER     NOT NULL,
      season_type  SMALLINT    NOT NULL,
      is_active    BOOLEAN     NOT NULL DEFAULT TRUE,
      kickoff_locked BOOLEAN   NOT NULL DEFAULT FALSE,
      synced_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS nfl_games_date ON nfl_games(date_et)`;
}

const teamName = (c) =>
  c?.team?.shortDisplayName || c?.team?.displayName || c?.team?.abbreviation || null;

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("✗ DATABASE_URL not set");
    process.exit(1);
  }
  await ensureSchema();

  const url =
    "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard" +
    `?dates=${compact(from)}-${compact(to)}&limit=400`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) {
    console.error(`✗ ESPN ${res.status}`);
    process.exit(1);
  }
  const events = (await res.json()).events ?? [];

  const games = [];
  for (const e of events) {
    const comp = e.competitions?.[0];
    const away = teamName(comp?.competitors?.find((c) => c.homeAway === "away"));
    const home = teamName(comp?.competitors?.find((c) => c.homeAway === "home"));
    if (!e.id || !e.date || !away || !home) continue;
    const seasonType = e.season?.type ?? 2;
    if (seasonType === 1) continue; // preseason off by default, as in the cron
    games.push({
      id: e.id,
      kickoffIso: new Date(e.date).toISOString(),
      dateEt: etYmd(new Date(e.date)),
      away,
      home,
      network: comp?.broadcasts?.[0]?.names?.join("/") || null,
      week: e.week?.number ?? null,
      season: e.season?.year ?? new Date(e.date).getUTCFullYear(),
      seasonType,
    });
  }

  const lockedRows = await sql`SELECT game_id FROM nfl_games WHERE kickoff_locked = TRUE`;
  const locked = new Set(lockedRows.map((r) => r.game_id));

  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  for (const g of games) {
    if (locked.has(g.id)) {
      skipped++; // a booked game's kickoff is never moved from here
      continue;
    }
    const rows = await sql`
      INSERT INTO nfl_games
        (game_id, kickoff_at, date_et, away_team, home_team, network, week,
         season, season_type, is_active, synced_at)
      VALUES
        (${g.id}, ${g.kickoffIso}, ${g.dateEt}, ${g.away}, ${g.home},
         ${g.network}, ${g.week}, ${g.season}, ${g.seasonType}, TRUE, NOW())
      ON CONFLICT (game_id) DO UPDATE SET
        kickoff_at = EXCLUDED.kickoff_at, date_et = EXCLUDED.date_et,
        away_team = EXCLUDED.away_team, home_team = EXCLUDED.home_team,
        network = EXCLUDED.network, week = EXCLUDED.week,
        season = EXCLUDED.season, season_type = EXCLUDED.season_type,
        is_active = TRUE, synced_at = NOW()
      RETURNING (xmax = 0) AS inserted
    `;
    if (rows[0]?.inserted) inserted++;
    else updated++;
  }

  console.log(
    `range ${from}..${to}  fetched=${games.length} inserted=${inserted} updated=${updated} lockedSkipped=${skipped}`,
  );

  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  const stored = await sql`
    SELECT kickoff_at, away_team, home_team, network
      FROM nfl_games
     WHERE is_active = TRUE AND date_et BETWEEN ${from}::date AND ${to}::date
     ORDER BY kickoff_at LIMIT 12
  `;
  console.log(`\nfirst ${stored.length} stored:`);
  for (const g of stored) {
    console.log(
      `  ${f.format(new Date(g.kickoff_at))}  ${g.away_team} at ${g.home_team}  ${g.network ?? ""}`,
    );
  }
}

main().catch((e) => {
  console.error(`\n✗ ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
