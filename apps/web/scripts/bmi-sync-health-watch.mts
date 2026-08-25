/**
 * Did the 2026-08-25 sync fixes hold? Read-only, safe to run any time.
 *
 * Four changes shipped that morning and every one of them is a claim about what
 * production will now do. This asks whether it did — comparing the hours SINCE
 * the deploy against the fortnight before it, so a quiet hour is not mistaken
 * for a fix working.
 *
 *   1. DUPLICATE MINTS      the kiosk no longer re-mints a guest we have already
 *                           identified. Baseline: ~20 excess records/day.
 *   2. PARKED ROWS          the widened party-seated gate should stop parking
 *                           check-ins whose racers were simply moved. Baseline:
 *                           ~5/day, 28% of stamp rows.
 *   3. NO-DOB MINTS         a person is never created without a birth date, so
 *                           no new record can answer Pandora with 500.
 *   4. WAIVER PUSHES        failures should stay flat; a rise means the mint
 *                           change broke signing, which is guest-facing.
 *
 * WHAT IT DOES NOT DO: write anything, or judge a single hour. Karting is spiky
 * — one quiet Tuesday proves nothing, and one busy Saturday is not a regression.
 * It reports RATES against the baseline and says plainly when a number is too
 * small to mean anything yet.
 *
 *   npx tsx scripts/bmi-sync-health-watch.mts        # since the deploy
 *   HOURS=3 npx tsx scripts/bmi-sync-health-watch.mts  # just the last 3 hours
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL!);

/** When the fixes went live (prod deploy of 52adcc377). */
const DEPLOYED_AT = "2026-08-25T05:15:00Z";
/** The fortnight the fixes were measured against, so "better" has a meaning. */
const BASE_FROM = "2026-08-12";
const BASE_TO = "2026-08-25";

const HOURS = Number(process.env.HOURS || 0);
const since = HOURS > 0 ? `now() - INTERVAL '${HOURS} hours'` : `'${DEPLOYED_AT}'::timestamptz`;

const pct = (n: number, d: number) => (d === 0 ? "—" : `${Math.round((n / d) * 100)}%`);
const rate = (n: number, hours: number) => (hours <= 0 ? 0 : (n / hours) * 24);

type Line = { ok: boolean | null; text: string };
const lines: Line[] = [];
const say = (ok: boolean | null, text: string) => lines.push({ ok, text });

async function main() {
  const [{ hrs }] = (await sql`
    SELECT EXTRACT(EPOCH FROM (now() - ${HOURS > 0 ? sql`now() - (${HOURS} * INTERVAL '1 hour')` : sql`${DEPLOYED_AT}::timestamptz`})) / 3600 AS hrs
  `) as any[];
  const hours = Number(hrs);
  const window = HOURS > 0 ? `the last ${HOURS}h` : `the ${hours.toFixed(1)}h since the deploy`;

  console.log(`\n════ BMI sync health — ${window} ════`);
  console.log(`    (baseline = ${BASE_FROM} → ${BASE_TO}, before the fixes)\n`);

  // ── 1. Duplicate mints ────────────────────────────────────────────────────
  // A duplicate is the same name at the same center inside 30 minutes: the
  // guardian loop, which is what the fix targeted. Two people genuinely sharing
  // a name walk in days apart, not minutes.
  const dupes = (await sql`
    WITH m AS (
      SELECT payload->>'firstName' f, payload->>'lastName' l, location_id loc, created_at
      FROM bmi_sync_queue
      WHERE kind = 'add-membership' AND created_at > ${sql.unsafe(since)}
    ),
    pairs AS (
      SELECT a.f, a.l, a.loc
      FROM m a JOIN m b
        ON a.f = b.f AND a.l = b.l AND a.loc = b.loc
       AND b.created_at > a.created_at
       AND b.created_at < a.created_at + INTERVAL '30 minutes'
      GROUP BY 1, 2, 3
    )
    SELECT (SELECT count(*) FROM m)::int AS mints,
           (SELECT count(*) FROM pairs)::int AS dupe_guests
  `) as any[];
  const { mints, dupe_guests } = dupes[0];

  const baseDupe = (await sql`
    WITH m AS (
      SELECT payload->>'firstName' f, payload->>'lastName' l, location_id loc, created_at
      FROM bmi_sync_queue
      WHERE kind = 'add-membership'
        AND created_at >= ${BASE_FROM}::date AND created_at < ${BASE_TO}::date
    ),
    pairs AS (
      SELECT a.f, a.l, a.loc FROM m a JOIN m b
        ON a.f = b.f AND a.l = b.l AND a.loc = b.loc
       AND b.created_at > a.created_at AND b.created_at < a.created_at + INTERVAL '30 minutes'
      GROUP BY 1, 2, 3
    )
    SELECT (SELECT count(*) FROM m)::int AS mints, (SELECT count(*) FROM pairs)::int AS dupe_guests
  `) as any[];
  const baseRate = baseDupe[0].mints ? baseDupe[0].dupe_guests / baseDupe[0].mints : 0;
  const nowRate = mints ? dupe_guests / mints : 0;

  if (mints < 20) {
    say(
      null,
      `DUPLICATE MINTS: ${dupe_guests} of ${mints} mints — too few mints to judge yet (need ~20)`,
    );
  } else if (nowRate <= baseRate / 2) {
    say(
      true,
      `DUPLICATE MINTS: ${dupe_guests}/${mints} (${pct(dupe_guests, mints)}) vs ${pct(baseDupe[0].dupe_guests, baseDupe[0].mints)} before — HOLDING`,
    );
  } else {
    say(
      false,
      `DUPLICATE MINTS: ${dupe_guests}/${mints} (${pct(dupe_guests, mints)}) vs ${pct(baseDupe[0].dupe_guests, baseDupe[0].mints)} before — NOT improving, the loop may still be open`,
    );
  }

  // Which surface? The mint fix added this tag, so a duplicate now names its own
  // origin instead of leaving us to infer it from waiver rows.
  const surfaces = (await sql`
    SELECT coalesce(payload->>'surface', '(untagged)') s, count(*)::int n
    FROM bmi_sync_queue
    WHERE kind = 'add-membership' AND created_at > ${sql.unsafe(since)}
    GROUP BY 1 ORDER BY n DESC
  `) as any[];
  if (surfaces.length) {
    say(null, `   mints by surface: ${surfaces.map((r) => `${r.s}=${r.n}`).join(", ")}`);
  }

  // ── 2. Parked rows ────────────────────────────────────────────────────────
  const parked = (await sql`
    SELECT count(*) FILTER (WHERE status = 'parked')::int AS parked,
           count(*) FILTER (WHERE status = 'lapsed')::int AS lapsed,
           count(*) FILTER (WHERE status = 'done')::int AS done,
           count(*) FILTER (WHERE kind = 'stamp-confirmation-state')::int AS stamps
    FROM bmi_sync_queue WHERE created_at > ${sql.unsafe(since)}
  `) as any[];
  const p = parked[0];
  const parkedPerDay = rate(p.parked, hours);
  if (p.parked === 0) {
    say(true, `PARKED: none in this window (was ~5/day) — ${p.lapsed} lapsed, ${p.done} done`);
  } else if (parkedPerDay < 2) {
    say(
      true,
      `PARKED: ${p.parked} (~${parkedPerDay.toFixed(1)}/day, was ~5) — ${p.lapsed} lapsed, ${p.done} done`,
    );
  } else {
    say(
      false,
      `PARKED: ${p.parked} (~${parkedPerDay.toFixed(1)}/day, was ~5) — still parking, look at why`,
    );
  }

  // The total standing on the board, which is what staff actually see.
  const [standing] = (await sql`
    SELECT count(*)::int n FROM bmi_sync_queue WHERE status = 'parked'
  `) as any[];
  say(
    standing.n === 0 ? true : null,
    `   board right now: ${standing.n} parked row(s) standing in total`,
  );

  // ── 3. Mints with no birth date ───────────────────────────────────────────
  // A repair row is only ever enqueued when the mint had no DOB, so its
  // existence IS the signal — no need to ask the vendor.
  const [nodob] = (await sql`
    SELECT count(*)::int n FROM bmi_sync_queue
    WHERE kind = 'repair-person-details' AND created_at > ${sql.unsafe(since)}
  `) as any[];
  say(
    nodob.n === 0,
    nodob.n === 0
      ? `NO-DOB MINTS: none — the guard is holding`
      : `NO-DOB MINTS: ${nodob.n} new — a rail is still minting without a birth date, find it`,
  );

  // ── 4. Waiver pushes ──────────────────────────────────────────────────────
  const [w] = (await sql`
    SELECT count(*)::int total,
           count(*) FILTER (WHERE outcome = 'failed')::int failed,
           count(*) FILTER (WHERE outcome IN ('signed','salvaged'))::int ok,
           count(*) FILTER (WHERE outcome IS NULL AND ts < now() - INTERVAL '30 minutes')::int unsettled
    FROM waiver_signatures WHERE ts > ${sql.unsafe(since)}
  `) as any[];
  if (w.total === 0) {
    say(null, `WAIVERS: none signed in this window`);
  } else if (w.failed === 0 && w.unsettled === 0) {
    say(true, `WAIVERS: ${w.ok}/${w.total} landed, no failures — signing is healthy`);
  } else {
    say(
      w.failed === 0,
      `WAIVERS: ${w.ok}/${w.total} landed, ${w.failed} failed, ${w.unsettled} unsettled >30min` +
        (w.failed > 0 ? " — check whether the mint change broke signing" : ""),
    );
  }

  // ── Verdict ───────────────────────────────────────────────────────────────
  console.log(
    lines
      .map((l) => `  ${l.ok === true ? "OK  " : l.ok === false ? "WARN" : "    "} ${l.text}`)
      .join("\n"),
  );

  const bad = lines.filter((l) => l.ok === false);
  console.log(
    bad.length === 0
      ? `\n  → nothing to act on.\n`
      : `\n  → ${bad.length} thing(s) to look at:\n${bad.map((b) => `      • ${b.text}`).join("\n")}\n`,
  );
}

await main();
