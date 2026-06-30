/** For each combo-tagged order, dump Square day-of line items → real combo vs regular cart. READ-ONLY. */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
const TOKEN = process.env.SQUARE_ACCESS_TOKEN!;
const H = { Authorization: `Bearer ${TOKEN}`, "Square-Version": "2024-12-18" };
const { sql } = await import("@/lib/db");
const q = sql();

const rows = (await q`
  SELECT id, product_kind, square_dayof_order_id AS dayof, square_deposit_order_id AS deposit,
         player_count, guest_name, booked_at, combo_special_id
  FROM bowling_reservations WHERE combo_special_id IS NOT NULL
  ORDER BY booked_at, id
`) as Array<Record<string, unknown>>;

// group by deposit order (the durable combo key)
const byDeposit = new Map<string, Array<Record<string, unknown>>>();
for (const r of rows) {
  const k = String(r.deposit ?? `none-${r.id}`);
  (byDeposit.get(k) ?? byDeposit.set(k, []).get(k)!).push(r);
}

const COMBO_RE = /Ultimate|VIP Experience|Starter Race|Intermediate Race|Race \+ Bowl/i;
for (const [dep, legs] of byDeposit) {
  const names = new Set<string>();
  const orderIds = [...new Set(legs.map((l) => String(l.dayof)).filter((x) => x && x !== "null"))];
  for (const oid of orderIds) {
    const o = (await (await fetch(`https://connect.squareup.com/v2/orders/${oid}`, { headers: H })).json()).order;
    for (const liItem of o?.line_items ?? []) names.add(liItem.name ?? "?");
  }
  const isCombo = [...names].some((n) => COMBO_RE.test(n));
  const who = String(legs[0].guest_name ?? "").slice(0, 18);
  const when = String(legs[0].booked_at).slice(0, 10);
  console.log(
    `${isCombo ? "✓ COMBO  " : "✗ NOT-COMBO"} dep=${dep.slice(0, 8)} ${who.padEnd(18)} ${when} rows=[${legs.map((l) => `#${l.id}`).join(",")}]\n     lines: ${[...names].join(" | ")}`,
  );
}
