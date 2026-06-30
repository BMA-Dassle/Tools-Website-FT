/**
 * TEST: complete a small batch of paid-in-full, past-event bowling day-of orders
 * so we can watch how QuickBooks dates the revenue (original day vs today).
 *
 * Safety: only touches state=OPEN, net_amount_due=$0, total>$0, event date in the
 * PAST, product_kind in (open,kbf,race,attraction), combos excluded. Completes any
 * open fulfillment first (KDS no longer needs it for a past event), then sets the
 * order COMPLETED — mirroring completeOrderNoFulfillment in bowling-no-show-close.
 *
 *   DRY RUN:  node --env-file=apps/web/.env.local apps/web/scripts/complete-test-batch.mts 2026-06-09 10
 *   EXECUTE:  node --env-file=apps/web/.env.local apps/web/scripts/complete-test-batch.mts 2026-06-09 10 --execute
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

const DAY = process.argv[2] ?? "2026-06-09";
const LIMIT = Number(process.argv[3] ?? "10");
const EXECUTE = process.argv.includes("--execute");
const TODAY = "2026-06-16";
if (DAY >= TODAY) {
  console.error(`Refusing: ${DAY} is not in the past (today=${TODAY}).`);
  process.exit(1);
}

const rows = (await sql`
  SELECT id, product_kind, status, guest_name, square_dayof_order_id
  FROM bowling_reservations
  WHERE (booked_at AT TIME ZONE 'America/New_York')::date = ${DAY}::date
    AND product_kind IN ('open','kbf','race','attraction') AND combo_special_id IS NULL
    AND square_dayof_order_id IS NOT NULL AND square_dayof_order_id <> ''
  ORDER BY id
`) as any[];

const D = (c: number) => `$${(c / 100).toFixed(2)}`;
async function getOrder(id: string) {
  const res = await fetch(`${BASE}/orders/${id}`, { headers: H });
  return (await res.json().catch(() => ({}))).order;
}

type Cand = { resId: number; guest: string; kind: string; orderId: string; total: number; version: number; paidAt?: string; fulfillments: any[] };
const cands: Cand[] = [];
for (const r of rows) {
  if (cands.length >= LIMIT) break;
  let id: string = r.square_dayof_order_id;
  try {
    const p = JSON.parse(r.square_dayof_order_id);
    if (Array.isArray(p) && p.length) id = p[0];
  } catch {
    /* bare */
  }
  const o = await getOrder(id);
  if (!o) continue;
  const total = o.total_money?.amount ?? 0;
  const due = o.net_amount_due_money?.amount ?? 0;
  if (o.state !== "OPEN" || due !== 0 || total <= 0) continue;
  const paidAt = (o.tenders ?? [])[0]?.created_at ?? o.created_at;
  cands.push({
    resId: r.id,
    guest: r.guest_name,
    kind: r.product_kind,
    orderId: id,
    total,
    version: o.version,
    paidAt,
    fulfillments: o.fulfillments ?? [],
  });
}

console.log(`${EXECUTE ? "EXECUTE" : "DRY RUN"} — ${cands.length} paid-but-OPEN orders from ${DAY} (limit ${LIMIT}):\n`);
let sum = 0;
for (const c of cands) {
  sum += c.total;
  console.log(
    `  res#${c.resId} ${c.kind.padEnd(10)} ${D(c.total).padStart(9)}  paid_at=${(c.paidAt ?? "").slice(0, 10)}  order=${c.orderId}  ${c.guest}`,
  );
}
console.log(`\n  TOTAL: ${D(sum)} across ${cands.length} orders\n`);

if (!EXECUTE) {
  console.log("Dry run only. Re-run with --execute to complete these.");
  process.exit(0);
}

console.log("Completing...\n");
let done = 0;
for (const c of cands) {
  try {
    // 1. Complete any non-terminal fulfillments (KDS no longer needs them).
    const openFuls = c.fulfillments.filter((f) => f.state && f.state !== "COMPLETED" && f.state !== "CANCELED");
    let version = c.version;
    if (openFuls.length) {
      const o = await getOrder(c.orderId);
      version = o.version;
      const r1 = await fetch(`${BASE}/orders/${c.orderId}`, {
        method: "PUT",
        headers: H,
        body: JSON.stringify({
          order: {
            location_id: o.location_id,
            version,
            fulfillments: openFuls.map((f) => ({ uid: f.uid, state: "COMPLETED" })),
          },
        }),
      });
      const j1 = await r1.json().catch(() => ({}));
      if (!r1.ok || j1.errors) {
        console.log(`  ✗ res#${c.resId} fulfillment complete failed: ${JSON.stringify(j1.errors ?? r1.status)}`);
        continue;
      }
      version = j1.order?.version ?? version;
    }
    // 2. Complete the order.
    const fresh = await getOrder(c.orderId);
    const r2 = await fetch(`${BASE}/orders/${c.orderId}`, {
      method: "PUT",
      headers: H,
      body: JSON.stringify({ order: { location_id: fresh.location_id, version: fresh.version, state: "COMPLETED" } }),
    });
    const j2 = await r2.json().catch(() => ({}));
    if (!r2.ok || j2.errors) {
      console.log(`  ✗ res#${c.resId} complete failed: ${JSON.stringify(j2.errors ?? r2.status)}`);
      continue;
    }
    done++;
    console.log(
      `  ✓ res#${c.resId} ${c.guest} → state=${j2.order?.state} closed_at=${(j2.order?.closed_at ?? "").slice(0, 19)} (${D(c.total)})`,
    );
  } catch (err) {
    console.log(`  ✗ res#${c.resId} threw: ${err instanceof Error ? err.message : String(err)}`);
  }
}
console.log(`\nCompleted ${done}/${cands.length}. Original sale day=${DAY}. Check this day vs ${TODAY} in QuickBooks.`);
process.exit(0);
