/**
 * READ-ONLY: Probe the portal-closed orders that had NO Neon match — pull each
 * from Square and print reference_id / note / metadata / created_at / source so
 * we can identify where they came from. Also samples the 30 most recent
 * bowling_reservations deposit orders to see whether staying OPEN is normal.
 *   npx tsx apps/web/scripts/portal-closed-orphans-probe.mts
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

const ORPHANS = [
  // Oct 2025 "Web Reservation" deposits — HPFM
  "nhhaPMj4j53VsagEyHfT1w1W1USZY", "nNb6S2pN9hWanNjNhyIusZoKsmZZY", "VqW6mNeeqV8ASrysBf9rCkfjjAFZY",
  "ZYivZ27LaGvaQZMKgFbeQ6Chx77YY", "RW18BzCP4S6FihXOkcRPEFPUPLSZY", "zp6WB3oHyJ2qTrOgMq0WzSfpJK7YY",
  "98HtR6F7H28ZM7GHtllLCEHWpdHZY", "54ulTo66IDqMjClc2URG1gL6d9MZY", "bF8DgdkfJj2Tmv7VU2MTLSHn4pWZY",
  "Bc0IH2gEHILQRXnUZh46qqnoZr9YY",
  // June 2026 "Ultimate Qualifier" orders — HPFM
  "pAgMBo9DRiJNPIMA4Q9JvYFOkxAZY", "9u6QxALDQenCoqQmg4ywXOhmXacZY", "jLRbsTuQkqLmK9kun44U4ydfwRQZY",
  // Oct 2025 deposits — HPN
  "xkgwK6HWeuxh3TI06QN0XaozFuVZY", "vHwNpMv4cmZ7MiB3WBpFkQHBxKYZY", "lgJUSqhnVJsXNpZO7rHOZTFYtSBZY",
  "fLQAUg9FDVqSlHzAuGB6JYsrmZTZY", "Z2rEpclAPGfIk1mXUoZzgT73UqaZY", "dKoCjoNv84cKuSTZP1Czmkt0zqOZY",
  "d2Wsa26ZT2iYyVNZAm1S6Fhu2aKZY", "jX58RET4NyJsMtvRDtGCTNX9NGXZY",
];

console.log("── Orphan orders (no Neon match) ──────────────────────────────");
for (const id of ORPHANS) {
  const res = await fetch(`${BASE}/orders/${id}`, { headers: H });
  const o = (await res.json().catch(() => ({}))).order;
  if (!o) {
    console.log(`${id}: FETCH FAIL ${res.status}`);
    continue;
  }
  const li = (o.line_items ?? []).map((l: any) => `${l.quantity}x ${l.name}`).join("; ");
  const tender = (o.tenders ?? []).map((t: any) => `${t.type} $${((t.amount_money?.amount ?? 0) / 100).toFixed(2)}`).join(", ");
  console.log(`\n${id}`);
  console.log(`  created=${(o.created_at ?? "").slice(0, 16)} state=${o.state} closed=${(o.closed_at ?? "").slice(0, 16)} src=${o.source?.name ?? "-"}`);
  console.log(`  ref=${o.reference_id ?? "-"} customer=${o.customer_id ?? "-"} ticket=${o.ticket_name ?? "-"}`);
  console.log(`  items: ${li.slice(0, 130)}`);
  console.log(`  tenders: ${tender || "-"}  note=${(o.tenders?.[0]?.note ?? "").slice(0, 90)}`);
  if (o.metadata) console.log(`  metadata: ${JSON.stringify(o.metadata).slice(0, 160)}`);
}

console.log("\n── Recent deposit orders: is OPEN normal? ─────────────────────");
const recent = (await sql`
  SELECT id, square_deposit_order_id, status,
         to_char((inserted_at AT TIME ZONE 'America/New_York'), 'MM-DD HH24:MI') AS created
  FROM bowling_reservations
  WHERE square_deposit_order_id IS NOT NULL AND square_deposit_order_id <> ''
    AND status IN ('confirmed','completed')
  ORDER BY id DESC LIMIT 30
`) as any[];
const stateCount: Record<string, number> = {};
for (const r of recent) {
  let id: string = r.square_deposit_order_id;
  try {
    const p = JSON.parse(id);
    if (Array.isArray(p) && p.length) id = p[0];
  } catch { /* bare */ }
  const res = await fetch(`${BASE}/orders/${id}`, { headers: H });
  const o = (await res.json().catch(() => ({}))).order;
  const st = o?.state ?? "FETCH_FAIL";
  stateCount[st] = (stateCount[st] ?? 0) + 1;
  if (st !== "COMPLETED") console.log(`  res#${r.id} (${r.created}, ${r.status}): deposit order ${st} — ${id}`);
}
console.log(`  states: ${JSON.stringify(stateCount)}`);
process.exit(0);
