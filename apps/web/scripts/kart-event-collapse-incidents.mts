/**
 * ONE-OFF: collapse the duplicate incident rows already in `kart_event`.
 *
 * The first night of driver-view ingest fanned every `CrashNotification` out to
 * every kart in the heat, and the venue re-fires crash detect every second or
 * two while a kart sits stopped. Result: 8,615 caution rows, 2,239 of them in a
 * single session across nine karts — and the public race history printed every
 * one. The ingest no longer does this (see incident-session.ts), and the report
 * collapses on read as a safety net, but the rows themselves are still there
 * and a race history is a permanent record a guest can open whenever.
 *
 * THE SAME RULE, ONCE. This imports `collapseIncidents` from the feature rather
 * than reimplementing the clustering, so the cleanup and the read path can
 * never disagree about what "the same incident" means.
 *
 * DRY RUN BY DEFAULT. Nothing is deleted without `--apply`.
 *
 *   cd apps/web
 *   npx tsx scripts/kart-event-collapse-incidents.mts            # report only
 *   npx tsx scripts/kart-event-collapse-incidents.mts --apply    # delete
 */
import { readFileSync } from "node:fs";

// `.env.local` is gitignored, so it is absent in a worktree. An already-set
// DATABASE_URL is a perfectly good way to run this; only fail when there is
// neither.
try {
  for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^"|"$/g, "");
  }
} catch {
  /* fall through to the check below */
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set and .env.local was not found. Refusing to guess.");
  process.exit(1);
}

const APPLY = process.argv.includes("--apply");

const { neon } = await import("@neondatabase/serverless");
const { collapseIncidents } = await import("../src/features/racing/driver-view/report.ts");

const sql = neon(process.env.DATABASE_URL!);

type Row = { event_id: string; kind: string; kart: string | null; occurred_at: string | Date };

const before = (await sql`
  SELECT kind, count(*)::int AS n FROM kart_event GROUP BY kind ORDER BY n DESC
`) as { kind: string; n: number }[];
console.log("BEFORE, by kind:");
for (const r of before) console.log(`  ${String(r.n).padStart(6)}  ${r.kind}`);

const sessions = (await sql`
  SELECT DISTINCT session_id FROM kart_event
  WHERE kind IN ('caution','crash','red') AND session_id IS NOT NULL
`) as { session_id: string }[];
console.log(`\nsessions with condition rows: ${sessions.length}`);

let examined = 0;
const doomed: string[] = [];
/** Per-session before/after, so a human can see the history is actually
 *  readable afterwards rather than trusting a single percentage. */
const perSession: { session: string; before: number; after: number }[] = [];

for (const { session_id } of sessions) {
  const rows = (await sql`
    SELECT event_id, kind, kart, occurred_at
    FROM kart_event
    WHERE session_id = ${session_id} AND kind IN ('caution','crash','red')
    ORDER BY occurred_at ASC
  `) as Row[];
  examined += rows.length;

  const asEvents = rows.map((r) => ({
    eventId: r.event_id,
    kind: r.kind,
    kart: r.kart,
    note: null,
    value: null,
    atMs: new Date(r.occurred_at).getTime(),
  }));

  const keep = new Set(collapseIncidents(asEvents).map((e) => e.eventId));
  for (const r of rows) if (!keep.has(r.event_id)) doomed.push(r.event_id);
  perSession.push({ session: session_id, before: rows.length, after: keep.size });
}

perSession.sort((a, b) => b.before - a.before);
console.log("\nworst sessions, before -> after:");
for (const s of perSession.slice(0, 8)) {
  console.log(`  session ${s.session}  ${String(s.before).padStart(5)} -> ${s.after}`);
}

console.log(`\ncondition rows examined : ${examined}`);
console.log(`rows to KEEP            : ${examined - doomed.length}`);
console.log(`rows to DELETE          : ${doomed.length}`);

if (!APPLY) {
  console.log("\nDRY RUN — nothing deleted. Re-run with --apply.");
  process.exit(0);
}

// Delete in batches: a 8k-element IN list is not a thing to hand a database.
const BATCH = 500;
let deleted = 0;
for (let i = 0; i < doomed.length; i += BATCH) {
  const batch = doomed.slice(i, i + BATCH);
  const res = (await sql`DELETE FROM kart_event WHERE event_id = ANY(${batch})`) as unknown;
  deleted += batch.length;
  void res;
  process.stdout.write(`\r  deleted ${deleted}/${doomed.length}`);
}
console.log("");

const after = (await sql`
  SELECT kind, count(*)::int AS n FROM kart_event GROUP BY kind ORDER BY n DESC
`) as { kind: string; n: number }[];
console.log("\nAFTER, by kind:");
for (const r of after) console.log(`  ${String(r.n).padStart(6)}  ${r.kind}`);
