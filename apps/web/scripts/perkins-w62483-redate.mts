/**
 * Robert Perkins W62483 — re-point the race leg at today.
 *
 * The whole VIP visit moved from 2026-08-29 to 2026-09-05. The BOWL leg (24369)
 * moved; the RACE leg (24370) did not, so it still carries Aug 29 heats
 * (16:00 starter / 19:00 intermediate) and status 'completed'. combo-board retires
 * a group 30 min past its LAST SCHEDULED STEP, so an Aug-29 schedule makes the whole
 * combo read as finished and it drops off today's board — which is exactly what the
 * owner sees as "the racing leg isn't linked".
 *
 * Today (owner, reading BMI): races 2pm and 5pm ET, bowls 3:15pm. That matches the
 * combo's own visit plan in the notes — Starter -> VIP bowling -> Intermediate.
 *
 * heatId is ET WALL CLOCK (combo-board reads it via etWallMs), so 2pm = T14:00:00.
 *
 * DELIBERATELY NOT TOUCHED: square_dayof_order_id, dayof_order_sent_at, deposit /
 * total cents, and the Aug-29 POV codes. Those are money and vendor artefacts from
 * the original date; re-firing them is a separate decision and not needed to put the
 * leg back on the board.
 *
 * Dry run by default. APPLY=1 to write.
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
import { neon } from "@neondatabase/serverless";
/* eslint-disable @typescript-eslint/no-explicit-any */
const sql = neon(process.env.DATABASE_URL!);
const APPLY = process.env.APPLY === "1";

const REMAP: Record<string, string> = {
  "2026-08-29T16:00:00": "2026-09-05T14:00:00", // Starter  → 2pm ET
  "2026-08-29T19:00:00": "2026-09-05T17:00:00", // Intermediate → 5pm ET
};

const row = ((await sql`
  SELECT id, status, booking_metadata FROM bowling_reservations WHERE id = 24370`) as any[])[0];
const meta = row.booking_metadata as any;
const heats: any[] = Array.isArray(meta?.heats) ? meta.heats : [];

console.log(`row 24370 status=${row.status}  heats=${heats.length}`);
const unknown = heats.filter((h) => !REMAP[h.heatId]);
if (unknown.length > 0) {
  console.log(`\n⚠ ${unknown.length} heat(s) with an unexpected heatId — REFUSING to guess:`);
  for (const h of unknown) console.log(`   ${h.heatId}  ${h.tier}/${h.racer}`);
  process.exit(1);
}

const next = heats.map((h) => ({ ...h, heatId: REMAP[h.heatId] }));
console.log("\n=== heat remap ===");
for (let i = 0; i < heats.length; i++) {
  console.log(`  ${heats[i].tier.padEnd(13)} ${heats[i].racer.padEnd(9)} ${heats[i].heatId} → ${next[i].heatId}`);
}

if (!APPLY) {
  console.log("\nDRY RUN — APPLY=1 to write (heats + status only).");
  process.exit(0);
}

await sql`
  UPDATE bowling_reservations
  SET booking_metadata = jsonb_set(booking_metadata, '{heats}', ${JSON.stringify(next)}::jsonb, true),
      status = 'confirmed',
      notes = COALESCE(NULLIF(notes,'') || E'\n', '') ||
        '── FastTrax Web ──' || E'\n' ||
        '[09/05/2026] Race leg re-pointed from 08/29 to TODAY: Starter 2:00 PM, Intermediate 5:00 PM ' ||
        '(bowling 3:15 PM unchanged). The visit moved but only the bowl leg was re-dated, so the combo ' ||
        'read as retired and W62483 dropped off the day board. Day-of order and POV codes from 08/29 left as-is.' || E'\n' ||
        '── End FastTrax Web ──'
  WHERE id = 24370
`;

const after = (await sql`
  SELECT id, product_kind, status, guest_name, player_count, bmi_bill_id,
         bmi_reservation_number, combo_special_id,
         to_char(booked_at,'MM-DD HH24:MI') booked_utc,
         booking_metadata->'heats' heats
  FROM bowling_reservations WHERE id IN (24369,24370) ORDER BY id`) as any[];
console.log("\n=== AFTER ===");
for (const r of after) {
  console.log(
    `  #${r.id} ${String(r.product_kind).padEnd(5)} ${String(r.status).padEnd(10)} ` +
      `${r.guest_name} pax=${r.player_count} bill=${r.bmi_bill_id ?? "—"} ${r.bmi_reservation_number ?? ""}`,
  );
  const hs = Array.isArray(r.heats) ? [...new Set(r.heats.map((h: any) => h.heatId))] : [];
  if (hs.length) console.log(`        heats: ${hs.join(", ")}`);
}
