/**
 * READ-ONLY probe: the population of Ultimate VIP Experience reservations and
 * the CURRENT BMI project state of each — the input to the "Confirmation - VIP"
 * (55466363) backfill. NO WRITES.
 *
 * Run from apps/web:  npx tsx scripts/vip-state-population-probe.mts
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
import https from "node:https";
import { randomUUID } from "node:crypto";
/* eslint-disable @typescript-eslint/no-explicit-any */

const OFFICE_HOST = "office-api22.sms-timing.com";
const CLIENT_KEY = "headpinzftmyers";
const SMS_VERSION = "6251006 202511051229";
const OFFICE_USER = process.env.BMI_OFFICE_USERNAME || "API2";
const OFFICE_PASS_B64 = process.env.BMI_OFFICE_PASSWORD_B64 || "JGMxbjFlbGxv";

const STATE_NAMES: Record<string, string> = {
  "-1": "Unknown",
  "-2": "Pending Quote",
  "-3": "Confirmation",
  "-4": "Cancellation",
  "-5": "Temporary/Arrived",
  "-100": "Pending online",
  "-101": "Payment started",
  "-102": "Paid online",
  "55397028": "Confirmation - Kiosk",
  "55466363": "Confirmation - VIP",
  "3274635": "Confirmation + Waiver",
};

async function getToken(): Promise<string> {
  const password = Buffer.from(OFFICE_PASS_B64, "base64").toString();
  const res = await fetch(`https://${OFFICE_HOST}/auth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      clientkey: CLIENT_KEY,
      "x-fast-version": SMS_VERSION,
      origin: "https://office.bmileisure.com",
      referer: "https://office.bmileisure.com/",
    },
    body: `grant_type=password&username=${encodeURIComponent(OFFICE_USER)}&password=${encodeURIComponent(password)}`,
  });
  if (!res.ok) throw new Error(`office auth ${res.status}`);
  return JSON.parse(await res.text()).access_token;
}

const token = await getToken();

function officeGet(path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      {
        hostname: OFFICE_HOST,
        path,
        headers: {
          Authorization: `Bearer ${token}`,
          "x-fast-version": SMS_VERSION,
          clientkey: CLIENT_KEY,
          "x-session-id": randomUUID(),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode || 500, body: data }));
      },
    );
    req.on("error", reject);
    req.setTimeout(20_000, () => {
      req.destroy();
      reject(new Error("timeout"));
    });
  });
}

/** project id = bill id + 1, last-10-digit math (17-digit-safe). */
function projectIdFromBillId(billId: string): string {
  const tail = (Number(billId.slice(-10)) + 1).toString();
  return billId.slice(0, -tail.length) + tail;
}

const { sql } = await import("@/lib/db");
const q = sql();

// The BMI-bearing leg of a VIP combo is the RACE row (bowling legs are QAMF).
const rows = (await q`
  SELECT id, combo_special_id, product_kind, guest_name, guest_email, player_count,
         status, bmi_bill_id, bmi_reservation_number, center_code,
         booking_metadata
  FROM bowling_reservations
  WHERE combo_special_id IS NOT NULL
  ORDER BY id
`) as Array<Record<string, any>>;

console.log(`=== bowling_reservations with combo_special_id: ${rows.length} rows ===\n`);

const byCombo = new Map<string, number>();
const byKind = new Map<string, number>();
for (const r of rows) {
  byCombo.set(r.combo_special_id, (byCombo.get(r.combo_special_id) ?? 0) + 1);
  byKind.set(
    `${r.combo_special_id}/${r.product_kind}`,
    (byKind.get(`${r.combo_special_id}/${r.product_kind}`) ?? 0) + 1,
  );
}
console.log("by combo id:", Object.fromEntries(byCombo));
console.log("by combo/product_kind:", Object.fromEntries(byKind));
console.log();

const withBill = rows.filter((r) => r.product_kind === "race" && r.bmi_bill_id);
console.log(`=== race legs carrying a BMI bill: ${withBill.length} ===\n`);

const stateTally = new Map<string, number>();
for (const r of withBill) {
  const projectId = projectIdFromBillId(String(r.bmi_bill_id));
  const res = await officeGet(`/api/${CLIENT_KEY}/project/${projectId}`);
  let stateId = "?";
  let projDate = "?";
  let projNum = "?";
  if (res.status >= 400) {
    stateId = `HTTP${res.status}`;
  } else {
    // Read-only: we take stateId/date/number and never write this object back.
    const p = JSON.parse(res.body);
    stateId = p?.stateId != null ? String(p.stateId) : "null";
    projDate = String(p?.date ?? "?").slice(0, 16);
    projNum = String(p?.number ?? "?");
  }
  stateTally.set(stateId, (stateTally.get(stateId) ?? 0) + 1);
  console.log(
    `#${String(r.id).padEnd(6)} ${String(r.combo_special_id).padEnd(13)} ` +
      `${String(r.bmi_reservation_number ?? projNum).padEnd(8)} ${projDate.padEnd(16)} ` +
      `neon=${String(r.status).padEnd(10)} state=${stateId.padEnd(9)} ${STATE_NAMES[stateId] ?? ""} ` +
      `| ${String(r.guest_name ?? "").slice(0, 24)}`,
  );
}

console.log(`\n=== current BMI state tally (race legs) ===`);
for (const [id, n] of [...stateTally].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${id.padEnd(10)} ${String(n).padStart(3)}  ${STATE_NAMES[id] ?? ""}`);
}
process.exit(0);
