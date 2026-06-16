/**
 * Close ALL paid-in-full, PAST-event, state=OPEN web day-of orders
 * (open/kbf/race/attraction; combos excluded). Idempotent: re-fetches each order
 * live and skips anything not OPEN / not $0-due. Completes open fulfillments first
 * (KDS no longer needs them for a past session), then sets order COMPLETED.
 * Mirrors completeOrderNoFulfillment in bowling-no-show-close.
 *
 *   DRY:      node --env-file=apps/web/.env.local apps/web/scripts/close-all-open-paid-past.mts
 *   EXECUTE:  node --env-file=apps/web/.env.local apps/web/scripts/close-all-open-paid-past.mts --execute
 *   Optional 2nd arg restricts by month prefix, e.g. 2026-06 (June only).
 */
import { readFileSync } from "node:fs";
for (const path of ["apps/web/.env.local", ".env.local"]) {
  try {
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
    }
    break;
  } catch {
    /* next */
  }
}
const { neon } = await import("@neondatabase/serverless");
const sql = neon(process.env.DATABASE_URL!);
const TOKEN = process.env.SQUARE_ACCESS_TOKEN!;
const BASE = "https://connect.squareup.com/v2";
const H = { Authorization: `Bearer ${TOKEN}`, "Square-Version": "2024-12-18", "Content-Type": "application/json" };
const EXECUTE = process.argv.includes("--execute");
const MONTH = process.argv.find((a) => /^\d{4}-\d{2}$/.test(a)); // optional YYYY-MM filter
const TODAY = "2026-06-16";
const CONCURRENCY = 6;

const rows = (await sql`
  SELECT id, product_kind, guest_name, square_dayof_order_id,
         to_char((booked_at AT TIME ZONE 'America/New_York')::date, 'YYYY-MM-DD') AS day
  FROM bowling_reservations
  WHERE (booked_at AT TIME ZONE 'America/New_York')::date < ${TODAY}::date
    AND product_kind IN ('open','kbf','race','attraction') AND combo_special_id IS NULL
    AND square_dayof_order_id IS NOT NULL AND square_dayof_order_id <> ''
    ${MONTH ? sql`AND to_char((booked_at AT TIME ZONE 'America/New_York')::date, 'YYYY-MM') = ${MONTH}` : sql``}
  ORDER BY id
`) as any[];

const work: { resId: number; guest: string; kind: string; orderId: string; day: string }[] = [];
const seen = new Set<string>();
for (const r of rows) {
  let id: string = r.square_dayof_order_id;
  try {
    const p = JSON.parse(r.square_dayof_order_id);
    if (Array.isArray(p) && p.length) id = p[0];
  } catch {
    /* bare */
  }
  if (id && !seen.has(id)) {
    seen.add(id);
    work.push({ resId: r.id, guest: r.guest_name ?? "", kind: r.product_kind, orderId: id, day: String(r.day) });
  }
}

const e = (s: string) => process.stderr.write(s + "\n");
e(`${EXECUTE ? "EXECUTE" : "DRY RUN"}${MONTH ? ` [${MONTH}]` : ""} — ${work.length} candidate orders (pre-verify).`);

async function getOrder(id: string) {
  const res = await fetch(`${BASE}/orders/${id}`, { headers: H });
  return (await res.json().catch(() => ({}))).order;
}

type Result = { resId: number; status: "completed" | "skipped" | "failed"; cents: number; note: string };
async function process_(w: (typeof work)[number]): Promise<Result> {
  try {
    const o = await getOrder(w.orderId);
    if (!o) return { resId: w.resId, status: "failed", cents: 0, note: "order not found" };
    const total = o.total_money?.amount ?? 0;
    const due = o.net_amount_due_money?.amount ?? 0;
    if (o.state === "COMPLETED") return { resId: w.resId, status: "skipped", cents: total, note: "already COMPLETED" };
    if (o.state === "CANCELED") return { resId: w.resId, status: "skipped", cents: 0, note: "CANCELED" };
    if (o.state !== "OPEN") return { resId: w.resId, status: "skipped", cents: 0, note: `state ${o.state}` };
    if (due !== 0) return { resId: w.resId, status: "skipped", cents: 0, note: `due $${(due / 100).toFixed(2)}` };
    if (total <= 0) return { resId: w.resId, status: "skipped", cents: 0, note: "total $0" };

    if (!EXECUTE) return { resId: w.resId, status: "completed", cents: total, note: "would complete" };

    // 1. Complete open fulfillments (if any).
    const openFuls = (o.fulfillments ?? []).filter(
      (f: any) => f.state && f.state !== "COMPLETED" && f.state !== "CANCELED",
    );
    let version = o.version;
    let locationId = o.location_id;
    if (openFuls.length) {
      const r1 = await fetch(`${BASE}/orders/${w.orderId}`, {
        method: "PUT",
        headers: H,
        body: JSON.stringify({
          order: { location_id: locationId, version, fulfillments: openFuls.map((f: any) => ({ uid: f.uid, state: "COMPLETED" })) },
        }),
      });
      const j1 = await r1.json().catch(() => ({}));
      if (!r1.ok || j1.errors) return { resId: w.resId, status: "failed", cents: 0, note: `fulfill: ${JSON.stringify(j1.errors ?? r1.status)}` };
      version = j1.order?.version ?? version;
    }
    // 2. Complete the order (re-fetch version to be safe).
    const fresh = await getOrder(w.orderId);
    const r2 = await fetch(`${BASE}/orders/${w.orderId}`, {
      method: "PUT",
      headers: H,
      body: JSON.stringify({ order: { location_id: fresh.location_id, version: fresh.version, state: "COMPLETED" } }),
    });
    const j2 = await r2.json().catch(() => ({}));
    if (!r2.ok || j2.errors) return { resId: w.resId, status: "failed", cents: 0, note: `complete: ${JSON.stringify(j2.errors ?? r2.status)}` };
    return { resId: w.resId, status: "completed", cents: total, note: `closed_at ${(j2.order?.closed_at ?? "").slice(0, 19)}` };
  } catch (err) {
    return { resId: w.resId, status: "failed", cents: 0, note: err instanceof Error ? err.message : String(err) };
  }
}

// Run with a fixed-size pool.
const results: Result[] = [];
let idx = 0;
let completedCents = 0;
let nDone = 0;
async function worker() {
  while (idx < work.length) {
    const my = idx++;
    const res = await process_(work[my]);
    results.push(res);
    if (res.status === "completed") completedCents += res.cents;
    nDone++;
    if (nDone % 100 === 0) e(`  ...${nDone}/${work.length} processed ($${(completedCents / 100).toFixed(2)} so far)`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

const completed = results.filter((r) => r.status === "completed");
const skipped = results.filter((r) => r.status === "skipped");
const failed = results.filter((r) => r.status === "failed");
e(`\n──────── ${EXECUTE ? "CLOSED" : "WOULD CLOSE"} ────────`);
e(`Completed: ${completed.length}   $${(completed.reduce((s, r) => s + r.cents, 0) / 100).toFixed(2)}`);
e(`Skipped:   ${skipped.length}`);
e(`Failed:    ${failed.length}`);
if (failed.length) {
  e(`\nFailures:`);
  for (const f of failed.slice(0, 40)) e(`  res#${f.resId}: ${f.note}`);
  if (failed.length > 40) e(`  ...and ${failed.length - 40} more`);
}
process.exit(0);
