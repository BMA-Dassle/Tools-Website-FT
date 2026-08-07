/**
 * READ-ONLY audit of every wallet racing licence: does the time we last wrote
 * onto the pass agree with the racer's real heat?
 *
 * The 2026-08-06 defect: a booking record's `heatStart` is CENTRE-LOCAL with no
 * zone marker, and it was resolved through `new Date()` — which on Vercel (UTC)
 * lands four hours early. Passes written by that path carry a wrong time in
 * three fields at once (nextRace, nextRaceLong, raceLabel is unaffected).
 *
 * Prints one line per pass. Nothing is written, nothing is pushed.
 *
 *   node --env-file=apps/web/.env.local apps/web/scripts/wallet-time-audit.mts
 */
import { readFileSync } from "node:fs";
for (const path of ["apps/web/.env.local", ".env.local"]) {
  try {
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
    }
    break;
  } catch {}
}
const { neon } = await import("@neondatabase/serverless");
const q = neon(process.env.DATABASE_URL!);

const rows = (await q`
  SELECT person_id, member_id, next_race, next_race_session_id, checkin_status, meta
    FROM racer_wallet_passes
   ORDER BY person_id
`) as Array<{
  person_id: string;
  member_id: string;
  next_race: string | null;
  next_race_session_id: string | null;
  checkin_status: string | null;
  meta: Record<string, string> | null;
}>;

console.log(`${rows.length} wallet passes\n`);
for (const r of rows) {
  const m = r.meta ?? {};
  console.log(
    [
      `person ${r.person_id}`,
      `member ${r.member_id}`,
      `name ${m.memberName ?? "—"}`,
      `session ${r.next_race_session_id ?? "—"}`,
    ].join("  "),
  );
  console.log(`    col.next_race   ${JSON.stringify(r.next_race)}`);
  console.log(`    meta.nextRace   ${JSON.stringify(m.nextRace ?? null)}`);
  console.log(`    meta.nextLong   ${JSON.stringify(m.nextRaceLong ?? null)}`);
  console.log(`    meta.raceLabel  ${JSON.stringify(m.raceLabel ?? null)}`);
  console.log(`    checkin         ${JSON.stringify(r.checkin_status ?? null)}`);
  console.log("");
}
