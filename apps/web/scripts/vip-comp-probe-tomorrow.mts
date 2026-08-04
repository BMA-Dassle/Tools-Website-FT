/** READ-ONLY probe: tomorrow's (2026-08-02) VIP combos + evening race heats. */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
const { sql } = await import("@/lib/db");
const q = sql();

const DATE = "2026-08-02";

// 1) Combo reservations whose event date is tomorrow
const combos = (await q`
  SELECT id, product_kind, combo_special_id, guest_name, guest_email, player_count,
         status, total_cents, deposit_cents, bmi_bill_id,
         booking_metadata
  FROM bowling_reservations
  WHERE combo_special_id IS NOT NULL
    AND (
      booking_metadata::text LIKE ${"%" + DATE + "%"}
    )
  ORDER BY id
`) as Array<Record<string, unknown>>;

console.log(`=== VIP combo rows touching ${DATE}: ${combos.length} ===`);
for (const r of combos) {
  const meta = (r.booking_metadata ?? {}) as Record<string, unknown>;
  const heats = Array.isArray(meta.heats) ? (meta.heats as Array<Record<string, unknown>>) : [];
  const attractions = Array.isArray(meta.attractions)
    ? (meta.attractions as Array<Record<string, unknown>>)
    : [];
  console.log(
    `\n#${r.id} ${r.product_kind} combo=${r.combo_special_id} ${r.guest_name} <${r.guest_email}> ppl=${r.player_count} status=${r.status} bill=${r.bmi_bill_id ?? "-"} tot=$${(Number(r.total_cents ?? 0) / 100).toFixed(2)}`,
  );
  for (const h of heats) {
    console.log(
      `   heat ${h.heatId} track=${h.track ?? "?"} tier=${h.tier ?? h.productLabel ?? "?"} cat=${h.category ?? "?"} racer=${h.racer ?? h.racerName ?? "?"} pid=${h.bmiPersonId ?? "-"} heat#=${h.heatNumber ?? "-"}`,
    );
  }
  for (const a of attractions) {
    console.log(`   attraction slot=${a.slot} label=${a.label ?? a.name ?? "?"} qty=${a.qty ?? "-"}`);
  }
  if (!heats.length && !attractions.length) {
    console.log("   (no heats/attractions in metadata) keys=", Object.keys(meta).join(","));
  }
}

// 2) Every reservation (any kind) with a heat starting tomorrow 17:00–23:00 — the evening grid as booked
const evening = (await q`
  SELECT r.id, r.product_kind, r.combo_special_id, r.guest_name, r.player_count, r.status,
         t.e->>'heatId' AS heat_at, t.e->>'track' AS track, t.e->>'category' AS category,
         t.e->>'tier' AS tier, t.e->>'productLabel' AS label, t.e->>'racer' AS racer,
         t.e->>'heatNumber' AS heat_no
  FROM bowling_reservations r,
       jsonb_array_elements(CASE WHEN jsonb_typeof(r.booking_metadata->'heats')='array' THEN r.booking_metadata->'heats' ELSE '[]'::jsonb END) AS t(e)
  WHERE t.e->>'heatId' >= ${DATE + "T17:00"}
    AND t.e->>'heatId' <= ${DATE + "T23:00"}
  ORDER BY t.e->>'heatId', r.id
`) as Array<Record<string, unknown>>;

console.log(`\n=== Booked heats ${DATE} 17:00–23:00: ${evening.length} ===`);
for (const r of evening) {
  console.log(
    `${r.heat_at} track=${String(r.track ?? "?").padEnd(10)} cat=${String(r.category ?? "?").padEnd(8)} tier=${String(r.tier ?? r.label ?? "?").padEnd(22)} #${r.id} ${String(r.guest_name ?? "").slice(0, 18).padEnd(18)} ${r.combo_special_id ?? ""} ${String(r.racer ?? "")} status=${r.status}`,
  );
}
