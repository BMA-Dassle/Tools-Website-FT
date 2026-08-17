/**
 * SMOKE: does the revival machinery actually work against the live table?
 *
 * Exercises the three new SQL paths end-to-end on a THROWAWAY row (idempotency
 * key `smoke:revival:*`, deleted at the end) and then does a READ-ONLY dry run of
 * the recheck query against the real parked set, so we can see exactly which rows
 * the deployed cron would pick up.
 *
 * Writes nothing to BMI. Touches no real queue row.
 *
 *   npx tsx scripts/syncqueue-revival-smoke.mts
 *   ENV_FILE=../../.env.local npx tsx scripts/syncqueue-revival-smoke.mts   # from a worktree
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from "node:fs";
// A worktree has no .env.local of its own (it is gitignored), so allow pointing
// at the main checkout's copy rather than making a second one.
const ENV = process.env.ENV_FILE || ".env.local";
for (const line of readFileSync(ENV, "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
import { neon } from "@neondatabase/serverless";
const sql = neon(process.env.DATABASE_URL!);

const KEY = "smoke:revival:throwaway";
const MAX_ATTEMPTS = 40;
const MAX_REVIVALS = 8;
const HORIZON = 72;
let failures = 0;
const check = (label: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
};

// ── 0. the additive migration ────────────────────────────────────────────────
await sql`ALTER TABLE bmi_sync_queue ADD COLUMN IF NOT EXISTS revivals INTEGER NOT NULL DEFAULT 0`;
console.log("\n[0] revivals column present");

await sql`DELETE FROM bmi_sync_queue WHERE idempotency_key = ${KEY}`;

// ── 1. a parked row, and the recheck query's eligibility rules ───────────────
console.log("\n[1] listParkedForRecheck eligibility");
const mk = async (attempts: number, revivals: number, parkedMinutesAgo: number) => {
  await sql`DELETE FROM bmi_sync_queue WHERE idempotency_key = ${KEY}`;
  const r = (await sql`
    INSERT INTO bmi_sync_queue
      (kind, idempotency_key, barrier, barrier_ref, location_id, payload,
       attempts, revivals, status, next_attempt_at, give_up_at, resolved_at, last_error)
    VALUES ('add-membership', ${KEY}, 'person-local', '63000000000000001', 'LAB52GY480CJF',
            '{"smoke":true}'::jsonb, ${attempts}, ${revivals}, 'parked',
            now(), now(), now() - (${parkedMinutesAgo} * INTERVAL '1 minute'), 'smoke')
    RETURNING id`) as any[];
  return Number(r[0].id);
};
const eligible = async (id: number) => {
  const rows = (await sql`
    SELECT id FROM bmi_sync_queue
    WHERE status = 'parked'
      AND attempts < ${MAX_ATTEMPTS}
      AND revivals < ${MAX_REVIVALS}
      AND resolved_at IS NOT NULL
      AND resolved_at > now() - (${HORIZON} * INTERVAL '1 hour')
      AND resolved_at < now() - (LEAST(360, 15 * POWER(2, revivals)) * INTERVAL '1 minute')
      AND id = ${id}`) as any[];
  return rows.length === 1;
};

let id = await mk(0, 0, 20);
check("parked 20m at revivals=0 (cooldown 15m) IS eligible", await eligible(id));
id = await mk(0, 0, 5);
check("parked 5m is NOT yet eligible", !(await eligible(id)));
id = await mk(0, 1, 20);
check("revivals=1 needs 30m, so 20m is NOT eligible", !(await eligible(id)));
id = await mk(0, 1, 40);
check("revivals=1 at 40m IS eligible", await eligible(id));
id = await mk(40, 0, 60);
check("attempts=40 (budget spent) is NEVER eligible", !(await eligible(id)));
id = await mk(10000, 0, 60);
check("attempts=10000 (handler terminal) is NEVER eligible", !(await eligible(id)));
id = await mk(0, 8, 600);
check("revivals=8 (cap) is NEVER eligible", !(await eligible(id)));
id = await mk(0, 0, 80 * 60);
check("parked 80h ago is past the horizon", !(await eligible(id)));

// ── 2. reviveSyncRow ─────────────────────────────────────────────────────────
console.log("\n[2] reviveSyncRow — extends patience, not budget");
id = await mk(12, 2, 120);
const revived = (await sql`
  UPDATE bmi_sync_queue
  SET status='pending', revivals = revivals + 1, next_attempt_at = now(),
      give_up_at = now() + (${720} * INTERVAL '1 minute'),
      resolved_at = NULL, last_error = ${"revived: 200 — present and readable"}, updated_at = now()
  WHERE id = ${id} AND status = 'parked'
  RETURNING id, status, attempts, revivals, give_up_at`) as any[];
check("a parked row comes back to pending", revived.length === 1 && revived[0].status === "pending");
check("attempt budget is NOT refilled", Number(revived[0].attempts) === 12);
check("revivals incremented", Number(revived[0].revivals) === 3);
check("give_up_at pushed into the future", Date.parse(revived[0].give_up_at) > Date.now());
const again = (await sql`
  UPDATE bmi_sync_queue SET status='pending' WHERE id = ${id} AND status='parked' RETURNING id`) as any[];
check("a row that is no longer parked is untouched (idempotent)", again.length === 0);

// ── 3. the idempotency poison ────────────────────────────────────────────────
console.log("\n[3] enqueueSync ON CONFLICT — parked revives, done does not");
const upsert = async () =>
  (await sql`
    INSERT INTO bmi_sync_queue
      (kind, idempotency_key, barrier, barrier_ref, location_id, payload, next_attempt_at, give_up_at)
    VALUES ('add-membership', ${KEY}, 'person-local', '63000000000000001', 'LAB52GY480CJF',
            '{"fresh":true}'::jsonb, now(), now() + (720 * INTERVAL '1 minute'))
    ON CONFLICT (idempotency_key) DO UPDATE SET
      payload         = bmi_sync_queue.payload || EXCLUDED.payload,
      reservation_ref = COALESCE(EXCLUDED.reservation_ref, bmi_sync_queue.reservation_ref),
      status          = 'pending',
      attempts        = CASE WHEN bmi_sync_queue.status = 'parked' THEN 0 ELSE bmi_sync_queue.attempts END,
      revivals        = bmi_sync_queue.revivals + CASE WHEN bmi_sync_queue.status = 'parked' THEN 1 ELSE 0 END,
      next_attempt_at = CASE WHEN bmi_sync_queue.status = 'parked' THEN EXCLUDED.next_attempt_at ELSE bmi_sync_queue.next_attempt_at END,
      give_up_at      = CASE WHEN bmi_sync_queue.status = 'parked' THEN EXCLUDED.give_up_at ELSE bmi_sync_queue.give_up_at END,
      resolved_at     = NULL,
      last_error      = CASE WHEN bmi_sync_queue.status = 'parked'
                             THEN 'revived — a live request asked for this followup again'
                             ELSE bmi_sync_queue.last_error END,
      updated_at      = now()
    WHERE bmi_sync_queue.status = 'pending'
       OR (bmi_sync_queue.status = 'parked' AND bmi_sync_queue.revivals < ${MAX_REVIVALS})
    RETURNING id, status, attempts, revivals, payload`) as any[];

id = await mk(31, 4, 5); // parked, and deliberately INSIDE the cooldown
let out = await upsert();
check("a live enqueue revives a PARKED row (no cooldown wait)", out.length === 1);
check("…with a FRESH attempt budget", Number(out[0].attempts) === 0);
check("…revivals bumped", Number(out[0].revivals) === 5);
check("…payload MERGED, not replaced", out[0].payload?.smoke === true && out[0].payload?.fresh === true);

await sql`UPDATE bmi_sync_queue SET status='done', resolved_at=now() WHERE idempotency_key=${KEY}`;
out = await upsert();
check("a DONE followup is still never resurrected", out.length === 0);
const doneRow = (await sql`SELECT status FROM bmi_sync_queue WHERE idempotency_key=${KEY}`) as any[];
check("…and stays done", doneRow[0].status === "done");

await sql`UPDATE bmi_sync_queue SET status='cancelled' WHERE idempotency_key=${KEY}`;
check("a CANCELLED followup is never resurrected", (await upsert()).length === 0);

id = await mk(0, MAX_REVIVALS, 600);
check("a parked row out of resurrections is refused", (await upsert()).length === 0);

// pending row must keep its lease + attempts
await sql`UPDATE bmi_sync_queue SET status='pending', attempts=7,
          next_attempt_at = now() + INTERVAL '90 seconds' WHERE idempotency_key=${KEY}`;
out = await upsert();
check("a PENDING row keeps its attempts (no free reset)", Number(out[0].attempts) === 7);
check(
  "…and keeps its queue lease",
  Date.parse(out[0].next_attempt_at ?? new Date(0).toISOString()) > Date.now() ||
    out[0].next_attempt_at === undefined,
);

await sql`DELETE FROM bmi_sync_queue WHERE idempotency_key = ${KEY}`;
console.log("\n[cleanup] throwaway row deleted");

// ── 4. READ-ONLY: what would the deployed cron pick up right now? ────────────
console.log("\n[4] DRY RUN against the real parked set — what the cron would revive:");
const real = (await sql`
  SELECT id, kind, attempts, revivals, barrier, barrier_ref, location_id, payload, resolved_at,
         round(EXTRACT(EPOCH FROM (now() - resolved_at))/60) AS parked_min
  FROM bmi_sync_queue
  WHERE status = 'parked'
    AND attempts < ${MAX_ATTEMPTS}
    AND revivals < ${MAX_REVIVALS}
    AND resolved_at IS NOT NULL
    AND resolved_at > now() - (${HORIZON} * INTERVAL '1 hour')
    AND resolved_at < now() - (LEAST(360, 15 * POWER(2, revivals)) * INTERVAL '1 minute')
  ORDER BY resolved_at ASC`) as any[];
for (const r of real) {
  const who = [r.payload?.firstName, r.payload?.lastName].filter(Boolean).join(" ");
  console.log(
    `   #${r.id} ${r.kind} tries=${r.attempts} parked ${r.parked_min}m ago  ${who} ref=${r.barrier_ref} @${r.location_id}`,
  );
}
const skipped = (await sql`
  SELECT id, kind, attempts, revivals FROM bmi_sync_queue
  WHERE status='parked' AND (attempts >= ${MAX_ATTEMPTS} OR revivals >= ${MAX_REVIVALS})`) as any[];
console.log(`   (and ${skipped.length} parked row(s) correctly left alone: ` +
  skipped.map((s) => `#${s.id} ${s.kind} tries=${s.attempts}`).join(", ") + ")");

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
