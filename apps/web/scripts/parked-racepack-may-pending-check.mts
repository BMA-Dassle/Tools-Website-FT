/**
 * READ-ONLY: for the 5 pre-queue sales_log rows (5/1–5/2) still
 * deposit_credit_pending=TRUE, check whether the recorded person exists
 * and whether race credits ever landed (Office person + deposit/history).
 *
 * Run from apps/web:  npx tsx scripts/parked-racepack-may-pending-check.mts
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
import https from "node:https";
import { randomUUID } from "node:crypto";
import { parseWithRawIds } from "@ft/db";
/* eslint-disable @typescript-eslint/no-explicit-any */

const OFFICE_HOST = "office-api22.sms-timing.com";
const CLIENT_KEY = process.env.BMI_CLIENT_KEY || "headpinzftmyers";
const SMS_VERSION = "6251006 202511051229";
const OFFICE_USER = process.env.BMI_OFFICE_USERNAME || "API2";
const OFFICE_PASS_B64 = process.env.BMI_OFFICE_PASSWORD_B64 || "JGMxbjFlbGxv";

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
const headers = {
  Authorization: `Bearer ${token}`,
  "x-fast-version": SMS_VERSION,
  clientkey: CLIENT_KEY,
};

function officeHttpsGet(path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      { hostname: OFFICE_HOST, path, headers: { ...headers, "x-session-id": randomUUID() } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode || 500, body: data }));
      },
    );
    req.on("error", reject);
    req.setTimeout(15_000, () => {
      req.destroy();
      reject(new Error("timeout"));
    });
  });
}

async function depositHistory(personId: string): Promise<any[] | string> {
  const res = await officeHttpsGet(
    `/api/${CLIENT_KEY}/deposit/history?personId=${personId}&from=${encodeURIComponent("2026-01-01T00:00:00")}&until=${encodeURIComponent("2026-07-31T23:59:59")}`,
  );
  if (res.status >= 400) return `HTTP ${res.status} ${res.body.slice(0, 120)}`;
  const rows = parseWithRawIds<any[]>(res.body);
  return Array.isArray(rows) ? rows : `non-array: ${res.body.slice(0, 200)}`;
}

const CASES = [
  { bill: "pack-1777679112182-a3ml", person: "46150255", bought: "5/1 7:47p", email: "wendylou4@gmail.com" },
  { bill: "pack-1777702598544-ap00", person: "18209514", bought: "5/2 2:17a", email: "marco03zap@gmail.com" },
  { bill: "pack-1777702746605-j9wm", person: "46188787", bought: "5/2 2:19a", email: "isabelzapucioiu@icloud.com" },
  { bill: "pack-1777731978042-e2l8", person: "46202425", bought: "5/2 10:48a", email: "ionzapucioiu@yahoo.com" },
  { bill: "pack-1777735100807-8j9w", person: "46206582", bought: "5/2 11:18a", email: "zapucioiuluminita@yahoo.com" },
];

for (const c of CASES) {
  console.log("═".repeat(70));
  console.log(`${c.bill}  bought ${c.bought}  ${c.email}`);
  const pres = await officeHttpsGet(`/api/${CLIENT_KEY}/person/${c.person}`);
  if (pres.status >= 400) {
    console.log(`  person ${c.person}: HTTP ${pres.status} — record gone`);
    continue;
  }
  const p = parseWithRawIds<any>(pres.body);
  const addr = p.addresses?.[0] ?? {};
  console.log(
    `  person ${c.person}: ${p.firstName ?? ""} ${p.name ?? ""}  email=${addr.email ?? "-"} mobile=${addr.mobile ?? addr.phone ?? "-"}  lastLineUp=${p.lastLineUp ?? "-"}`,
  );
  const hist = await depositHistory(c.person);
  if (typeof hist === "string") {
    console.log(`  history: ${hist}`);
    continue;
  }
  const active = hist.filter(
    (h) => Number(h.balance) !== 0 || (Array.isArray(h.history) && h.history.length > 0),
  );
  if (active.length === 0) {
    console.log(`  history: all kinds zero, no 2026 activity`);
    continue;
  }
  for (const h of active) {
    console.log(`  kind ${h.depositKindId} "${h.depositKind}" balance=${h.balance}`);
    for (const e of h.history ?? []) console.log(`    ${JSON.stringify(e)}`);
  }
}
console.log("═".repeat(70));
console.log("done (read-only — no writes performed)");
