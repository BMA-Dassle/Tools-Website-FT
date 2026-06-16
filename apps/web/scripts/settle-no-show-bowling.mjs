/**
 * One-time remediation: close out PAST no-show bowling/KBF reservations (the
 * backlog the new bowling-no-show-close cron will handle nightly going forward).
 *
 * A no-show = past-slot (booked_at IS the lane slot) + status 'confirmed' (never
 * checked in, no checkin_method) + open day-of order + non-combo. We apply the
 * prepaid gift card to the order and COMPLETE it WITHOUT a fulfillment, so the
 * forfeited deposit is collected but the KDS/kitchen never fires. $0/free (KBF)
 * orders are just completed. Uses the SAME idempotency key as the cron
 * (no-show-close-<id>) so the two can never double-charge.
 *
 *   node scripts/settle-no-show-bowling.mjs            # dry run
 *   node scripts/settle-no-show-bowling.mjs --apply    # collect + complete + stamp
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
  SELECT id, product_kind pk, guest_name gn, qamf_reservation_id qid,
         square_dayof_order_id oid, square_gift_card_id gc,
         (booked_at AT TIME ZONE 'America/New_York')::date::text d
  FROM bowling_reservations
  WHERE product_kind IN ('open','kbf')
    AND status = 'confirmed'
    AND checkin_method IS NULL
    AND dayof_order_sent_at IS NULL
    AND square_dayof_order_id IS NOT NULL
    AND combo_special_id IS NULL
    AND booked_at < NOW() - INTERVAL '2 hours'
  ORDER BY booked_at`;

async function complete(oid, loc, version) {
  await fetch(`${B}/orders/${oid}`, {
    method: "PUT",
    headers: H,
    body: JSON.stringify({ order: { location_id: loc, version, state: "COMPLETED" } }),
  });
}

let closed = 0,
  collected = 0,
  skipped = 0;
const byDay = {};
for (const r of rows) {
  const o = await fetch(`${B}/orders/${r.oid}`, { headers: H });
  const ord = o.ok ? (await o.json()).order : null;
  if (!ord) {
    skipped++;
    console.log(`#${r.id} order fetch failed`);
    continue;
  }
  const loc = ord.location_id;
  const due =
    ord.state === "COMPLETED"
      ? 0
      : (ord.net_amount_due_money?.amount ?? ord.total_money?.amount ?? 0);
  let charge = 0,
    note;
  if (ord.state === "COMPLETED") {
    note = "already COMPLETED";
  } else if (due <= 0) {
    note = "$0 — complete";
    if (APPLY && ord.version) await complete(r.oid, loc, ord.version);
  } else {
    if (!r.gc) {
      skipped++;
      console.log(`#${r.id} ${r.d} due $${(due / 100).toFixed(2)} but NO gift card — skip`);
      continue;
    }
    const g = await fetch(`${B}/gift-cards/${r.gc}`, { headers: H });
    const bal = g.ok ? ((await g.json()).gift_card?.balance_money?.amount ?? 0) : 0;
    if (bal <= 0) {
      skipped++;
      console.log(`#${r.id} ${r.d} gift card $0 balance — skip`);
      continue;
    }
    charge = Math.min(bal, due);
    note = `collect $${(charge / 100).toFixed(2)}`;
    if (APPLY) {
      const pr = await fetch(`${B}/payments`, {
        method: "POST",
        headers: H,
        body: JSON.stringify({
          idempotency_key: `no-show-close-${r.id}`,
          source_id: r.gc,
          amount_money: { amount: charge, currency: "USD" },
          order_id: r.oid,
          location_id: loc,
          autocomplete: true,
          note: `No-show deposit forfeited — ${r.qid ?? `#${r.id}`}`,
        }),
      });
      if (!pr.ok) {
        const e = await pr.json().catch(() => ({}));
        console.log(`#${r.id} PAY FAIL: ${e.errors?.[0]?.detail || pr.status}`);
        continue;
      }
      try {
        const f = await fetch(`${B}/orders/${r.oid}`, { headers: H });
        const v = f.ok ? (await f.json()).order?.version : null;
        if (v) await complete(r.oid, loc, v);
      } catch {}
    }
  }
  if (APPLY)
    await sql`UPDATE bowling_reservations SET dayof_order_sent_at = NOW(), dayof_order_source = 'no-show' WHERE id = ${r.id} AND dayof_order_sent_at IS NULL`;
  closed++;
  collected += charge;
  byDay[r.d] = byDay[r.d] || { n: 0, amt: 0 };
  byDay[r.d].n++;
  byDay[r.d].amt += charge;
  console.log(`${APPLY ? "CLOSED" : "would close"} #${r.id} ${r.d} ${r.pk} "${r.gn}" — ${note}`);
}
console.log(`\nby slot date:`);
for (const d of Object.keys(byDay).sort())
  console.log(`  ${d}: ${byDay[d].n} orders, collect $${(byDay[d].amt / 100).toFixed(2)}`);
console.log(
  `\n${APPLY ? "CLOSED" : "WOULD close"} ${closed} no-shows; collect $${(collected / 100).toFixed(2)}; skipped ${skipped}.${APPLY ? "" : " Re-run --apply to execute."}`,
);
