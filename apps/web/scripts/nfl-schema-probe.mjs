/**
 * Runs the EXACT DDL and upsert from features/nfl against real Postgres, on
 * `_verify`-suffixed copies that are dropped afterwards. Nothing here touches
 * the real nfl_games / nfl_lane_block_claims / bowling_reservations.
 *
 * Two things need proving beyond the constraint mechanics (already covered by
 * nfl-claims-probe.mjs):
 *
 *   1. The DDL as written actually parses — a DATE column fed an ET date string,
 *      a SMALLINT season type, TSTZRANGE, and the EXCLUDE clause together.
 *   2. `RETURNING (xmax = 0) AS inserted` really does distinguish an INSERT from
 *      an ON CONFLICT UPDATE. It is a genuine Postgres idiom but an easy one to
 *      get subtly wrong, and the sync's inserted/updated counts are what tell
 *      ops whether a nightly run did anything.
 *
 * Usage: node apps/web/scripts/nfl-schema-probe.mjs
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

const sql = neon(process.env.DATABASE_URL);
const G = "nfl_games_verify";
const C = "nfl_lane_block_claims_verify";

let pass = 0;
let fail = 0;
const check = (label, ok, detail = "") => {
  if (ok) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
};

async function upsert(game) {
  const rows = await sql`
    INSERT INTO ${sql.unsafe(G)}
      (game_id, kickoff_at, date_et, away_team, home_team, network, week,
       season, season_type, is_active, synced_at)
    VALUES
      (${game.id}, ${game.kickoffIso}, ${game.dateEt}, ${game.awayTeam}, ${game.homeTeam},
       ${game.network}, ${game.week}, ${game.season}, ${game.seasonType}, TRUE, NOW())
    ON CONFLICT (game_id) DO UPDATE SET
      kickoff_at  = EXCLUDED.kickoff_at,
      date_et     = EXCLUDED.date_et,
      away_team   = EXCLUDED.away_team,
      home_team   = EXCLUDED.home_team,
      network     = EXCLUDED.network,
      week        = EXCLUDED.week,
      season      = EXCLUDED.season,
      season_type = EXCLUDED.season_type,
      is_active   = TRUE,
      synced_at   = NOW()
    RETURNING (xmax = 0) AS inserted
  `;
  return rows[0]?.inserted;
}

const GAME = {
  id: "401872925",
  kickoffIso: "2026-09-13T17:00:00.000Z",
  dateEt: "2026-09-13",
  awayTeam: "Buccaneers",
  homeTeam: "Bengals",
  network: "FOX",
  week: 1,
  season: 2026,
  seasonType: 2,
};

try {
  console.log("1. DDL as written in claims.server.ts");
  await sql`DROP TABLE IF EXISTS ${sql.unsafe(C)}`;
  await sql`DROP TABLE IF EXISTS ${sql.unsafe(G)}`;
  await sql`
    CREATE TABLE ${sql.unsafe(G)} (
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
  await sql`CREATE INDEX IF NOT EXISTS nfl_games_verify_date ON ${sql.unsafe(G)}(date_et)`;
  check("nfl_games DDL + index accepted", true);

  await sql`CREATE EXTENSION IF NOT EXISTS btree_gist`;
  await sql`
    CREATE TABLE ${sql.unsafe(C)} (
      id              SERIAL      PRIMARY KEY,
      center_id       INTEGER     NOT NULL,
      block_id        TEXT        NOT NULL,
      game_id         TEXT        NOT NULL,
      window_range    TSTZRANGE   NOT NULL,
      hold_expires_at TIMESTAMPTZ,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT nfl_block_one_game_per_window_verify
        EXCLUDE USING gist (center_id WITH =, block_id WITH =, window_range WITH &&)
    )
  `;
  check("nfl_lane_block_claims DDL accepted", true);

  console.log("\n2. insert vs update is reported correctly");
  const first = await upsert(GAME);
  check("a fresh row reports inserted = true", first === true, `got ${JSON.stringify(first)}`);

  const second = await upsert({ ...GAME, network: "CBS" });
  check("the same id again reports inserted = false", second === false, `got ${JSON.stringify(second)}`);

  const [row] = await sql`SELECT network, date_et, season_type FROM ${sql.unsafe(G)} WHERE game_id = ${GAME.id}`;
  check("the update actually took", row.network === "CBS", `network=${row.network}`);
  // The driver returns a DATE column as a JS Date at LOCAL midnight, so read
  // local parts. toISOString() here would roll back a day on a UTC+n host —
  // which is exactly the bug this check caught in rowToGame.
  const d = row.date_et instanceof Date ? row.date_et : new Date(String(row.date_et));
  const localYmd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
  check(
    "an ET date string lands on the DATE column unshifted",
    localYmd === "2026-09-13",
    `date_et=${row.date_et} localYmd=${localYmd}`,
  );
  check("season_type round-trips as a number", Number(row.season_type) === 2);

  console.log("\n3. the empty-feed guard");
  const seenEmpty = [];
  const wouldDeactivate = await sql`
    SELECT count(*)::int AS n FROM ${sql.unsafe(G)}
     WHERE is_active = TRUE AND NOT (game_id = ANY(${seenEmpty}))
  `;
  check(
    "an EMPTY seen-list matches every row — which is why the sweep is guarded",
    wouldDeactivate[0].n === 1,
    `matched ${wouldDeactivate[0].n}`,
  );

  const seenReal = [GAME.id];
  const withReal = await sql`
    SELECT count(*)::int AS n FROM ${sql.unsafe(G)}
     WHERE is_active = TRUE AND NOT (game_id = ANY(${seenReal}))
  `;
  check("a populated seen-list spares the games it names", withReal[0].n === 0);
} catch (err) {
  fail++;
  console.log(`\nFATAL: ${err.message}`);
} finally {
  try {
    await sql`DROP TABLE IF EXISTS ${sql.unsafe(C)}`;
    await sql`DROP TABLE IF EXISTS ${sql.unsafe(G)}`;
    console.log(`\ncleanup: dropped ${G}, ${C}`);
  } catch (e) {
    console.log(`\ncleanup FAILED — drop ${G} / ${C} by hand: ${e.message}`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
