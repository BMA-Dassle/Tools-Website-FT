/**
 * READ-ONLY dry run of the BMI→Neon race-time sync. Fetches the real BMI
 * schedules and the real Neon heats for a bill, runs the SAME
 * `reconcileHeatTimes` the check-in flow uses, and prints what it WOULD write.
 * Writes nothing.
 *
 * Run from apps/web:  npx tsx scripts/heat-sync-dryrun.mts <billId> [billId...]
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
/* eslint-disable @typescript-eslint/no-explicit-any */
import https from "node:https";
import { randomUUID } from "node:crypto";
import { parseWithRawIds } from "@ft/db";
// Dynamic import: tsx resolves the `~/` alias at runtime, not statically.
const { reconcileHeatTimes, usableSchedules } = await import(
  "~/features/kiosk/checkin/bmi-schedule-sync"
);

const bills = process.argv.slice(2);
if (bills.length === 0) {
  console.log("usage: npx tsx scripts/heat-sync-dryrun.mts <billId> [billId...]");
  process.exit(1);
}

const HOST = "office-api22.sms-timing.com";
const CK = process.env.BMI_CLIENT_KEY || "headpinzftmyers";
const VER = "6251006 202511051229";
const pw = Buffer.from(process.env.BMI_OFFICE_PASSWORD_B64 || "JGMxbjFlbGxv", "base64").toString();
const token = JSON.parse(
  await (
    await fetch(`https://${HOST}/auth/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        clientkey: CK,
        "x-fast-version": VER,
        origin: "https://office.bmileisure.com",
        referer: "https://office.bmileisure.com/",
      },
      body: `grant_type=password&username=${process.env.BMI_OFFICE_USERNAME || "API2"}&password=${encodeURIComponent(pw)}`,
    })
  ).text(),
).access_token;
function get(path: string): Promise<string> {
  return new Promise((res, rej) => {
    const r = https.get(
      {
        hostname: HOST,
        path,
        headers: {
          Authorization: `Bearer ${token}`,
          "x-fast-version": VER,
          clientkey: CK,
          "x-session-id": randomUUID(),
        },
      },
      (x) => {
        let d = "";
        x.on("data", (c) => (d += c));
        x.on("end", () => res(d));
      },
    );
    r.on("error", rej);
    r.setTimeout(20_000, () => {
      r.destroy();
      rej(new Error("timeout"));
    });
  });
}
function projectIdFor(bill: string): string {
  const head = bill.slice(0, -10);
  const tail = bill.slice(-10);
  return head + String(Number(tail) + 1).padStart(10, "0");
}

const { sql } = await import("@/lib/db");
const q = sql();

for (const bill of bills) {
  console.log(`\n══════ bill ${bill} ══════`);
  const proj = parseWithRawIds<any>(await get(`/api/${CK}/project/${projectIdFor(bill)}`));
  const scheds = (proj?.schedules ?? []) as any[];
  const usable = usableSchedules(scheds);
  console.log(`  BMI schedules: ${scheds.length} raw, ${usable.length} usable`);
  for (const s of usable) {
    console.log(`    • start=${String(s.start).slice(0, 19)} persons=${s.persons} "${s.productLines}"`);
  }
  const dropped = scheds.length - usable.length;
  if (dropped > 0) console.log(`    (dropped ${dropped} placeholder row(s): persons<=0 / blank label)`);

  const rows = (await q`
    SELECT id, booking_metadata FROM bowling_reservations
    WHERE bmi_bill_id = ${bill} AND product_kind = 'race'
  `) as Array<Record<string, any>>;

  for (const row of rows) {
    const heats = (row.booking_metadata?.heats ?? []) as any[];
    console.log(`\n  Neon row #${row.id} — ${heats.length} heat row(s):`);
    for (const h of heats) {
      console.log(`    • heatId=${h.heatId} racer="${h.racer ?? ""}" track=${h.track ?? "?"}`);
    }
    const r = reconcileHeatTimes(heats, usable);
    console.log(`\n  RESULT: reason=${r.reason} changed=${r.changed}${r.detail ? ` — ${r.detail}` : ""}`);
    if (r.changed > 0) {
      console.log("  WOULD WRITE:");
      for (const h of r.heats) {
        console.log(`    • heatId=${h.heatId} racer="${(h as any).racer ?? ""}"`);
      }
      console.log("  ✓ the assignment would now match Pandora's session start");
    } else if (r.reason === "ok") {
      console.log("  ✓ already in sync — nothing to write");
    } else {
      console.log("  · left untouched (fail-closed)");
    }
  }
}
console.log("\n(dry run — nothing was written)");
process.exit(0);
