/**
 * READ-ONLY: is BMI `project.schedules[].persons` the seat count for THAT RACE,
 * or the reservation's headcount? NO WRITES.
 *
 * This decides how check-in models races. A reservation of 2 does NOT mean two
 * people on every heat (owner 2026-08-07) — one racer may take a second race
 * alone — so the kiosk needs a PER-RACE seat count. If `persons` varies between
 * schedules on the same project, it is per-race and authoritative; if it always
 * equals the project headcount, it is useless and seats must come from
 * elsewhere.
 *
 * Also reports where Neon's heat rows DISAGREE with BMI on time or count, which
 * is the staleness that made an assignment fail live (BMI 23:12, Neon 22:12).
 *
 * Run from apps/web:  npx tsx scripts/bmi-schedule-shape-audit.mts [limit]
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

const LIMIT = Number(process.argv[2] || 25);
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
const rows = (await q`
  SELECT r.bmi_bill_id AS bill, r.booking_metadata AS md
  FROM bowling_reservations r
  WHERE r.product_kind = 'race' AND r.status = 'confirmed'
    AND r.bmi_bill_id IS NOT NULL
    AND jsonb_typeof(r.booking_metadata::jsonb->'heats') = 'array'
    AND r.booked_at > now() - interval '20 days'
  ORDER BY r.booked_at DESC
  LIMIT ${LIMIT}
`) as Array<Record<string, any>>;

let multiRace = 0;
let personsVaries = 0;
let timeMismatch = 0;
let countMismatch = 0;

for (const r of rows) {
  const bill = String(r.bill);
  let proj: any = null;
  try {
    proj = parseWithRawIds<any>(await get(`/api/${CK}/project/${projectIdFor(bill)}`));
  } catch {
    continue;
  }
  const scheds = (proj?.schedules ?? []) as any[];
  if (scheds.length === 0) continue;
  const heats = (r.md?.heats ?? []) as any[];

  // Neon: how many heat rows per distinct start time.
  const neonByStart = new Map<string, number>();
  for (const h of heats) {
    const k = String(h.heatId ?? "").slice(0, 19);
    neonByStart.set(k, (neonByStart.get(k) ?? 0) + 1);
  }
  const bmiByStart = new Map<string, number>();
  for (const s of scheds) {
    const k = String(s.start ?? "").slice(0, 19);
    bmiByStart.set(k, (bmiByStart.get(k) ?? 0) + Number(s.persons ?? 0));
  }

  const personsSet = new Set(scheds.map((s) => Number(s.persons ?? 0)));
  if (scheds.length > 1) multiRace++;
  if (personsSet.size > 1) personsVaries++;

  const starts = [...new Set([...neonByStart.keys(), ...bmiByStart.keys()])].sort();
  const badTime = starts.some((s) => !neonByStart.has(s) || !bmiByStart.has(s));
  const badCount = starts.some((s) => (neonByStart.get(s) ?? 0) !== (bmiByStart.get(s) ?? 0));
  if (badTime) timeMismatch++;
  if (badCount && !badTime) countMismatch++;

  if (scheds.length > 1 || badTime || badCount) {
    console.log(
      `\nbill=${bill}  schedules=${scheds.length}  personsPerSchedule=[${scheds.map((s) => s.persons).join(",")}]${badTime ? "  ⚠TIME-MISMATCH" : ""}${badCount && !badTime ? "  ⚠COUNT-MISMATCH" : ""}`,
    );
    for (const s of scheds) {
      console.log(
        `   BMI  start=${String(s.start).slice(0, 19)} persons=${s.persons} "${String(s.productLines ?? "").slice(0, 34)}"`,
      );
    }
    for (const [k, n] of [...neonByStart.entries()].sort()) {
      console.log(`   NEON start=${k} heatRows=${n}`);
    }
  }
}

console.log(`\n══════ ${rows.length} reservations ══════`);
console.log(`  multi-schedule projects            : ${multiRace}`);
console.log(`  persons VARIES between schedules   : ${personsVaries}   ← proves per-RACE if > 0`);
console.log(`  BMI/Neon start-time mismatch       : ${timeMismatch}`);
console.log(`  same times, different seat counts  : ${countMismatch}`);
process.exit(0);
