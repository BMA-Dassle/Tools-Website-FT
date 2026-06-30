/**
 * Execute the bowling-leg plan from combo-bowling-complete-plan.mts.
 *   COMPLETE-ONLY → re-fetch, if OPEN & paid ($0 due) PUT state=COMPLETED
 *   CHARGE+COMPLETE → charge gift card (autocomplete) for exact due, then complete
 * Also flips the Neon row status → 'completed'. Idempotent (re-running is safe:
 * already-COMPLETED orders are skipped; payment idempotency_key is per-order).
 * DRY RUN by default; pass --live to execute.
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
const LIVE = process.argv.includes("--live");
const TOKEN = process.env.SQUARE_ACCESS_TOKEN!;
const BASE = "https://connect.squareup.com/v2";
const H = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", "Square-Version": "2024-12-18" };
const D = (c?: number) => `$${(((c ?? 0)) / 100).toFixed(2)}`;
const { sql } = await import("@/lib/db");
const q = sql();

type Item = { id: number; oid: string; locationId: string; action: "complete" | "charge"; due: number; gc: string | null };
const plan: Item[] = JSON.parse(readFileSync("scripts/.combo-bowling-plan.json", "utf8"));

const get = async (oid: string) => (await (await fetch(`${BASE}/orders/${oid}`, { headers: H })).json().catch(() => ({}))).order;
const TERMINAL_FUL = new Set(["COMPLETED", "CANCELED", "FAILED"]);
const complete = async (oid: string, locationId: string) => {
  const fresh = await get(oid);
  if (!fresh) return "fetch-fail";
  if (fresh.state === "COMPLETED") return "already-completed";
  if (!fresh.version) return "no-version";
  // Square blocks order→COMPLETED while any fulfillment (the KDS ticket) is open.
  // Transition open fulfillments → COMPLETED in the same PUT, then complete the order.
  const openFuls = (fresh.fulfillments ?? []).filter((f: any) => !TERMINAL_FUL.has(f.state));
  const order: any = { location_id: locationId, version: fresh.version, state: "COMPLETED" };
  if (openFuls.length) order.fulfillments = openFuls.map((f: any) => ({ uid: f.uid, state: "COMPLETED" }));
  const res = await fetch(`${BASE}/orders/${oid}`, { method: "PUT", headers: H, body: JSON.stringify({ order }) });
  if (!res.ok) return `complete-fail ${JSON.stringify((await res.json().catch(() => ({}))).errors ?? res.status)}`;
  return openFuls.length ? `completed (+${openFuls.length} ful)` : "completed";
};

console.log(LIVE ? "=== LIVE ===\n" : "=== DRY RUN (pass --live) ===\n");
let charged = 0;
for (const it of plan) {
  const o = await get(it.oid);
  if (!o) { console.log(`res#${it.id} ${it.oid.slice(0, 8)} FETCH_FAIL`); continue; }
  if (o.state === "COMPLETED") { console.log(`res#${it.id} ${it.oid.slice(0, 8)} already COMPLETED — skip`); continue; }
  const due = o.net_amount_due_money?.amount ?? o.total_money?.amount ?? 0;

  if (it.action === "charge") {
    if (due <= 0) { console.log(`res#${it.id} ${it.oid.slice(0, 8)} now $0 due — completing only`); }
    else {
      if (!it.gc) { console.log(`res#${it.id} ${it.oid.slice(0, 8)} CHARGE due ${D(due)} but NO gift card — skip`); continue; }
      const bal = (await (await fetch(`${BASE}/gift-cards/${it.gc}`, { headers: H })).json().catch(() => ({}))).gift_card?.balance_money?.amount ?? 0;
      if (bal < due) { console.log(`res#${it.id} ${it.oid.slice(0, 8)} CHARGE due ${D(due)} but card ${D(bal)} short — skip`); continue; }
      console.log(`res#${it.id} ${it.oid.slice(0, 8)} CHARGE ${D(due)} from card ${D(bal)}${LIVE ? "" : " (dry)"}`);
      if (LIVE) {
        const pay = await fetch(`${BASE}/payments`, { method: "POST", headers: H, body: JSON.stringify({ idempotency_key: `combo-bowl-settle-${it.oid.slice(-16)}`, source_id: it.gc, amount_money: { amount: due, currency: "USD" }, order_id: it.oid, location_id: it.locationId, autocomplete: true, note: "VIP combo bowling leg settle (gift card)" }) });
        const pd = await pay.json();
        if (!pay.ok || pd.errors) { console.log(`  ‼ payment FAILED: ${JSON.stringify(pd.errors ?? pd)}`); continue; }
        charged += due;
        console.log(`  ✓ paid ${D(due)} (pay ${String(pd.payment?.id).slice(0, 8)})`);
      }
    }
  } else {
    console.log(`res#${it.id} ${it.oid.slice(0, 8)} COMPLETE-ONLY (total ${D(o.total_money?.amount)}, due ${D(due)}, tenders ${o.tenders?.length ?? 0})${LIVE ? "" : " (dry)"}`);
  }

  if (LIVE) {
    const r = await complete(it.oid, it.locationId);
    console.log(`  state→ ${r}`);
    await q`UPDATE bowling_reservations SET status = 'completed' WHERE id = ${it.id} AND status <> 'completed'`;
  }
}
console.log(`\n${LIVE ? "DONE" : "DRY RUN COMPLETE"} — ${plan.length} items, ${D(charged)} charged.`);
process.exit(0);
