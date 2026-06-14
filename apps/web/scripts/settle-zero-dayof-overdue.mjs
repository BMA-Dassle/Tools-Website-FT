/**
 * One-time remediation: close + mark-sent overdue $0-model race/attraction
 * day-of orders that the race-dayof-pay cron skips (it requires a gift card,
 * which $0 races don't have). NO money is charged — these owe $0 (paid at
 * booking). Completes the open Square order and stamps dayof_order_sent_at so
 * they stop showing "Pending". Excludes combos (settled at lane-open).
 *   node scripts/settle-zero-dayof-overdue.mjs           # dry run
 *   node scripts/settle-zero-dayof-overdue.mjs --apply   # close + stamp
 */
import { neon } from "@neondatabase/serverless";
import { readFileSync } from "fs";
const APPLY = process.argv.includes("--apply");
const env = readFileSync(".env.local", "utf8");
const url = (env.match(/DATABASE_URL\s*=\s*"?([^"\n]+)"?/) || [])[1];
const tok = (env.match(/SQUARE_ACCESS_TOKEN\s*=\s*"?([^"\n]+)"?/) || [])[1];
const sql = neon(url);
const H = {
  Authorization: `Bearer ${tok}`,
  "Content-Type": "application/json",
  "Square-Version": "2024-12-18",
};
const B = "https://connect.squareup.com/v2";
const rows = await sql`
  SELECT r.id, r.product_kind pk, r.total_cents, r.square_dayof_order_id oid,
         r.booking_metadata->'heats' heats, r.booking_metadata->'attractions' attrs
  FROM bowling_reservations r
  WHERE r.product_kind IN ('race','attraction') AND r.status='confirmed' AND r.dayof_order_sent_at IS NULL
    AND r.square_dayof_order_id IS NOT NULL AND r.combo_special_id IS NULL
    AND NOT EXISTS(SELECT 1 FROM bowling_reservations b WHERE b.square_dayof_order_id=r.square_dayof_order_id AND b.product_kind IN ('open','kbf'))`;
function earliest(h, a) {
  const ts = [];
  if (Array.isArray(h)) for (const x of h) if (typeof x.heatId === "string") ts.push(x.heatId);
  if (Array.isArray(a)) for (const x of a) if (typeof x.slot === "string") ts.push(x.slot);
  if (!ts.length) return null;
  let e = Infinity;
  for (const t of ts) {
    const m = Number(t.slice(5, 7));
    const off = m >= 3 && m <= 11 ? "-04:00" : "-05:00";
    const ms = Date.parse(t.replace(/Z$/, "") + off);
    if (ms < e) e = ms;
  }
  return Number.isFinite(e) ? e : null;
}
const past = rows.filter((r) => {
  const e = earliest(r.heats, r.attrs);
  return e != null && Date.now() > e;
});
let closed = 0,
  stamped = 0,
  skippedMoney = 0;
for (const r of past) {
  const o = await fetch(`${B}/orders/${r.oid}`, { headers: H });
  const ord = o.ok ? (await o.json()).order : null;
  const due = ord ? (ord.net_amount_due_money?.amount ?? 0) : 0;
  const st = ord?.state ?? "ERR";
  if (due > 0) {
    skippedMoney++;
    console.log(`#${r.id} ${r.pk} HAS DUE $${(due / 100).toFixed(2)} — SKIP (needs review)`);
    continue;
  }
  console.log(
    `#${r.id} ${r.pk} oid=${(r.oid || "").slice(-6)} state=${st} due=$0 -> ${APPLY ? "closing+stamping" : "(dry)"}`,
  );
  if (!APPLY) continue;
  if (st && st !== "COMPLETED" && st !== "CANCELED" && ord?.version != null) {
    const put = await fetch(`${B}/orders/${r.oid}`, {
      method: "PUT",
      headers: H,
      body: JSON.stringify({
        order: { location_id: ord.location_id, version: ord.version, state: "COMPLETED" },
      }),
    });
    if (put.ok) closed++;
  }
  await sql`UPDATE bowling_reservations SET dayof_order_sent_at=NOW(), dayof_order_source='zero-dayof-remediation' WHERE id=${r.id} AND dayof_order_sent_at IS NULL`;
  stamped++;
}
console.log(
  `\npast-start overdue: ${past.length} | skippedMoney: ${skippedMoney} | ${APPLY ? `closed=${closed} stamped=${stamped}` : "DRY RUN — re-run with --apply"}`,
);
