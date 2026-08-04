/** READ-ONLY verify of the comped VIP booking W57087 / bill 63000000007006612. */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
const { sql } = await import("@/lib/db");
const q = sql();
const BILL = "63000000007006612";

// 1. Neon reservation rows
const rows = (await q`
  SELECT id, product_kind, status, combo_special_id, guest_name, guest_email, player_count,
         total_cents, deposit_cents, promo_code, promo_savings_cents, bmi_bill_id,
         bmi_reservation_number, qamf_reservation_id, square_dayof_order_id,
         square_deposit_order_id, square_gift_card_id, short_code, booked_at, notes
  FROM bowling_reservations WHERE id IN (18546, 18547) ORDER BY id
`) as Array<Record<string, unknown>>;
console.log("=== Neon rows ===");
for (const r of rows) {
  console.log(
    `#${r.id} ${r.product_kind} ${r.status} combo=${r.combo_special_id} ${r.guest_name} <${r.guest_email}> ppl=${r.player_count}\n` +
      `   total=$${(Number(r.total_cents) / 100).toFixed(2)} deposit=$${(Number(r.deposit_cents) / 100).toFixed(2)} promo=${r.promo_code} saved=$${(Number(r.promo_savings_cents ?? 0) / 100).toFixed(2)}\n` +
      `   bill=${r.bmi_bill_id ?? "-"} res#=${r.bmi_reservation_number ?? "-"} qamf=${r.qamf_reservation_id ?? "-"} dayof=${r.square_dayof_order_id} deposit_order=${r.square_deposit_order_id ?? "NONE"} gc=${r.square_gift_card_id ?? "NONE"} short=${r.short_code}\n` +
      `   booked_at=${r.booked_at}\n   notes: ${String(r.notes ?? "").slice(0, 180).replace(/\n/g, " | ")}`,
  );
}

// 2. Voucher
const vouchers = (await q`
  SELECT * FROM vouchers WHERE bill_id = ${BILL}
`) as Array<Record<string, unknown>>;
console.log("\n=== Voucher ===");
for (const v of vouchers) {
  const { items: rawItems, ...rest } = v;
  console.log(
    Object.entries(rest)
      .filter(([, val]) => val !== null)
      .map(([k, val]) => `${k}=${String(val).slice(0, 60)}`)
      .join(" "),
  );
  const items = Array.isArray(rawItems) ? (rawItems as Array<Record<string, unknown>>) : [];
  console.log(`items=${items.length}`);
  const counts = new Map<string, number>();
  for (const it of items) {
    const k = `${it.kind ?? "?"}:${it.label ?? it.slug ?? JSON.stringify(it).slice(0, 50)}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  for (const [k, n] of counts) console.log(`   ${n} × ${k}`);
}

// 3. Promo redemption
const promo = (await q`
  SELECT c.code, c.uses_count, c.max_uses, r.domain, r.external_ref, r.amount_off_cents, r.redeemed_at
  FROM discount_codes c LEFT JOIN discount_redemptions r ON r.code_id = c.id
  WHERE UPPER(c.code) = 'VIPCOMP-HG-0802'
`) as Array<Record<string, unknown>>;
console.log("\n=== Promo ===");
for (const p of promo) {
  console.log(`${p.code} uses ${p.uses_count}/${p.max_uses} — redemption: ${p.domain ?? "-"} ref=${p.external_ref ?? "-"} off=$${(Number(p.amount_off_cents ?? 0) / 100).toFixed(2)} at=${p.redeemed_at ?? "-"}`);
}

// 4. Square day-of orders — totals + state
const token = process.env.SQUARE_ACCESS_TOKEN!;
const orderIds = [...new Set(rows.map((r) => String(r.square_dayof_order_id)).filter(Boolean))];
console.log("\n=== Square orders ===");
for (const oid of orderIds) {
  const res = await fetch(`https://connect.squareup.com/v2/orders/${oid}`, {
    headers: { Authorization: `Bearer ${token}`, "Square-Version": "2025-01-23" },
  });
  const data = (await res.json()) as { order?: Record<string, unknown>; errors?: unknown };
  const o = data.order as { state?: string; total_money?: { amount?: number }; location_id?: string; line_items?: Array<{ name?: string; quantity?: string; total_money?: { amount?: number } }> } | undefined;
  if (!o) {
    console.log(`${oid}: ERROR ${JSON.stringify(data.errors).slice(0, 200)}`);
    continue;
  }
  console.log(`${oid} loc=${o.location_id} state=${o.state} total=$${((o.total_money?.amount ?? 0) / 100).toFixed(2)}`);
  for (const li of o.line_items ?? []) {
    console.log(`   ${li.quantity} × ${li.name} = $${((li.total_money?.amount ?? 0) / 100).toFixed(2)}`);
  }
}
