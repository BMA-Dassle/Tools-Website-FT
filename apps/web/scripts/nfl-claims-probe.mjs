/**
 * Proves the NFL block-claim ledger works on the REAL database before anything
 * is built on top of it. Three things have to be true and none of them are
 * things to assume:
 *
 *   1. `btree_gist` is available on this Neon instance (an EXCLUDE constraint
 *      mixing `=` on the block with `&&` on the window needs it).
 *   2. Bare `ON CONFLICT DO NOTHING` actually catches an EXCLUSION violation.
 *      Postgres only accepts a NAMED conflict target for UNIQUE constraints, so
 *      the untargeted form is the only one that can work here — and if it
 *      didn't, two guests could each be sold the same block.
 *   3. Half-open `[start,end)` ranges treat end-to-start as NOT overlapping,
 *      which is what lets a block turn over between the Sunday early and late
 *      slates (12:45-15:45 then 15:50-18:50).
 *
 * SAFETY: operates entirely on `nfl_claim_probe`, its own throwaway table,
 * dropped in a finally block. It never creates or touches the real
 * nfl_lane_block_claims / nfl_games tables. The only lasting effect is
 * CREATE EXTENSION IF NOT EXISTS btree_gist, which is required anyway.
 *
 * Usage: node apps/web/scripts/nfl-claims-probe.mjs
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
const T = "nfl_claim_probe";

let pass = 0;
let fail = 0;
function check(label, ok, detail = "") {
  if (ok) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Windows for a real Nov 8 2026 slate (EST), as the app would build them. */
const W = {
  early: ["2026-11-08T17:45:00Z", "2026-11-08T20:45:00Z"], // 12:45-15:45 ET
  late405: ["2026-11-08T20:50:00Z", "2026-11-08T23:50:00Z"], // 15:50-18:50 ET
  late425: ["2026-11-08T21:10:00Z", "2026-11-09T00:10:00Z"], // 16:10-19:10 ET
};
const range = ([a, b]) => `[${a},${b})`;

async function claim(block, gameId, win) {
  const rows = await sql`
    INSERT INTO ${sql.unsafe(T)} (center_id, block_id, game_id, window_range)
    VALUES (9172, ${block}, ${gameId}, ${range(win)}::tstzrange)
    ON CONFLICT DO NOTHING
    RETURNING id
  `;
  return rows.length > 0 ? rows[0].id : null;
}

try {
  console.log("1. btree_gist + EXCLUDE constraint");
  await sql`CREATE EXTENSION IF NOT EXISTS btree_gist`;
  check("btree_gist available", true);

  await sql`DROP TABLE IF EXISTS ${sql.unsafe(T)}`;
  await sql`
    CREATE TABLE ${sql.unsafe(T)} (
      id           SERIAL PRIMARY KEY,
      center_id    INTEGER NOT NULL,
      block_id     TEXT NOT NULL,
      game_id      TEXT NOT NULL,
      window_range TSTZRANGE NOT NULL,
      EXCLUDE USING gist (center_id WITH =, block_id WITH =, window_range WITH &&)
    )
  `;
  check("EXCLUDE USING gist accepted", true);

  console.log("\n2. one game per block per overlapping window");
  const a1 = await claim("fm-vip-a", "game-chiefs", W.late405);
  check("first claim on block A lands", a1 !== null);

  const a2 = await claim("fm-vip-a", "game-bills", W.late425);
  check(
    "a DIFFERENT game cannot take block A in an overlapping window",
    a2 === null,
    a2 !== null ? `inserted id ${a2} — BLOCK WOULD BE DOUBLE SOLD` : "",
  );

  const b1 = await claim("fm-vip-b", "game-bills", W.late425);
  check("that game spills onto block B instead", b1 !== null);

  const c1 = await claim("fm-vip-a", "game-49ers", W.late425);
  check("a third game is refused — both blocks are committed", c1 === null);

  console.log("\n3. half-open ranges let a block turn over");
  const earlyOnA = await claim("fm-vip-a", "game-early", W.early);
  check(
    "the 1:00 slate fits block A even though the 4:05 slate holds it later",
    earlyOnA !== null,
    earlyOnA === null ? "12:45-15:45 wrongly collides with 15:50-18:50" : "",
  );

  // On a block of its own: blocks A and B are both committed by now, and a
  // claim that overlaps an existing one SHOULD be refused (proven above).
  const touchBlock = "fm-touch-probe";
  await claim(touchBlock, "game-early", W.early); // 17:45-20:45Z
  const touching = await claim(
    touchBlock,
    "game-touch",
    ["2026-11-08T20:45:00Z", "2026-11-08T23:45:00Z"], // starts exactly when early ends
  );
  check("a window starting exactly when another ends is allowed", touching !== null);

  console.log("\n4. concurrent race for the last free block");
  await sql`DELETE FROM ${sql.unsafe(T)}`;
  const racers = await Promise.all([
    claim("fm-vip-a", "race-game-1", W.late405),
    claim("fm-vip-a", "race-game-2", W.late405),
    claim("fm-vip-a", "race-game-3", W.late405),
    claim("fm-vip-a", "race-game-4", W.late405),
  ]);
  const winners = racers.filter((r) => r !== null);
  check(
    "exactly ONE of four simultaneous claims wins",
    winners.length === 1,
    `${winners.length} winners: ${JSON.stringify(racers)}`,
  );

  console.log("\n5. same game re-claiming is a no-op, not a second block");
  await sql`DELETE FROM ${sql.unsafe(T)}`;
  await claim("fm-vip-a", "same-game", W.late405);
  const dup = await claim("fm-vip-a", "same-game", W.late405);
  check("re-inserting the same game on the same block is refused", dup === null);
} catch (err) {
  fail++;
  console.log(`\nFATAL: ${err.message}`);
} finally {
  try {
    await sql`DROP TABLE IF EXISTS ${sql.unsafe(T)}`;
    console.log(`\ncleanup: dropped ${T}`);
  } catch (e) {
    console.log(`\ncleanup FAILED — drop ${T} by hand: ${e.message}`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
