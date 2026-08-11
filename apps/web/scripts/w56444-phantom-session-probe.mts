/**
 * READ-ONLY probe for W56444 (Victoria Whitley, 2026-07-31) — investigating the
 * empty 9:12–9:19 PM Blue Track planning row + "4 added to session" kiosk
 * check-in memo. Dumps:
 *   1. Neon bowling_reservations rows (booking_metadata.heats = the heat times
 *      the kiosk check-in scheduler POSTs to /bmi/schedule)
 *   2. Pandora /v2/bmi/reservation for the bill (sessions/planning as BMI sees it)
 * NO WRITES.
 *
 * Run from apps/web:  npx tsx scripts/w56444-phantom-session-probe.mts
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
/* eslint-disable @typescript-eslint/no-explicit-any */
import { parseWithRawIds } from "@ft/db";

const PANDORA_BASE = "https://bma-pandora-api.azurewebsites.net";
const FASTTRAX = "LAB52GY480CJF";
const W = "W56444";

const { sql } = await import("@/lib/db");
const q = sql();

console.log("══════ 1. Neon bowling_reservations for", W, "══════");
const rows = (await q`
  SELECT id, product_kind, status, guest_name, guest_email, booked_at,
         bmi_bill_id, bmi_reservation_number, player_count, booking_metadata
  FROM bowling_reservations
  WHERE bmi_reservation_number = ${W}
  ORDER BY id
`) as Array<Record<string, any>>;

let billId: string | null = null;
for (const r of rows) {
  billId = billId ?? (r.bmi_bill_id ? String(r.bmi_bill_id) : null);
  console.log(
    `\n  row #${r.id} kind=${r.product_kind} status=${r.status} players=${r.player_count}` +
      `\n    guest=${r.guest_name} <${r.guest_email}> booked_at=${r.booked_at}` +
      `\n    bill=${r.bmi_bill_id} res=${r.bmi_reservation_number}`,
  );
  const meta = r.booking_metadata ?? {};
  const heats = meta.heats;
  if (Array.isArray(heats)) {
    console.log(`    heats (${heats.length}):`);
    for (const h of heats)
      console.log(
        `      • heatId=${h.heatId} track=${h.track} tier=${h.tier} cat=${h.category}` +
          ` productId=${h.productId} racer=${h.racer ?? "—"} bmiPersonId=${h.bmiPersonId ?? "—"}`,
      );
  }
  const metaKeys = Object.keys(meta).filter((k) => k !== "heats");
  if (metaKeys.length) {
    for (const k of metaKeys) {
      const v = JSON.stringify(meta[k]);
      console.log(`    meta.${k} = ${v && v.length > 400 ? v.slice(0, 400) + "…" : v}`);
    }
  }
}
if (rows.length === 0) console.log("  (no Neon rows found by reservation number)");

console.log("\n══════ 2. Pandora reservation dump ══════");
if (!billId) {
  console.log("  no bmi_bill_id in Neon — cannot fetch Pandora reservation");
} else {
  const key = process.env.SWAGGER_ADMIN_KEY || "";
  const res = await fetch(`${PANDORA_BASE}/v2/bmi/reservation/${FASTTRAX}/${billId}`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(20_000),
  });
  const body = parseWithRawIds<any>(await res.text());
  if (!res.ok || !body?.success) {
    console.log(`  Pandora fetch failed: ${res.status} ${JSON.stringify(body).slice(0, 400)}`);
  } else {
    const d = body.data ?? {};
    const topKeys = Object.keys(d);
    console.log(`  keys: ${topKeys.join(", ")}`);
    for (const k of topKeys) {
      const v = d[k];
      if (Array.isArray(v)) {
        console.log(`\n  ${k} (${v.length}):`);
        for (const item of v) {
          const s = JSON.stringify(item);
          console.log(`    • ${s.length > 600 ? s.slice(0, 600) + "…" : s}`);
        }
      } else {
        const s = JSON.stringify(v);
        console.log(`  ${k} = ${s && s.length > 300 ? s.slice(0, 300) + "…" : s}`);
      }
    }
  }
}

console.log("\n══════ 3. kiosk check-in event + people rows ══════");
try {
  const evs = (await q`
    SELECT * FROM kiosk_checkin_events
    WHERE bill_id = ${billId ?? ""}
    ORDER BY id
  `) as Array<Record<string, any>>;
  for (const e of evs) {
    console.log(
      `  event #${e.id} bill=${e.bill_id} project=${e.project_id} via=${e.verified_via}` +
        ` date=${e.business_date} completed=${e.completed_at} bmi_state=${e.bmi_state_status}` +
        ` kiosk=${e.kiosk_id} created=${e.created_at}`,
    );
    const people = (await q`
      SELECT * FROM kiosk_checkin_people WHERE event_id = ${e.id} ORDER BY id
    `) as Array<Record<string, any>>;
    for (const p of people) {
      console.log(
        `    person #${p.id} slotKey=${p.slot_key} name=${p.display_name}` +
          ` personId=${p.person_id} pandoraId=${p.pandora_person_id} waiver=${p.waiver_valid}` +
          `\n      attach=${p.bmi_attach_status} schedule=${p.schedule_status} qamf=${p.qamf_status}` +
          ` errors=${JSON.stringify(p.errors)}` +
          `\n      boundHeats=${JSON.stringify(p.bound_heats)}`,
      );
    }
  }
  if (evs.length === 0) console.log("  (none)");
} catch (err) {
  console.log(`  table query failed: ${err instanceof Error ? err.message : err}`);
}
process.exit(0);
