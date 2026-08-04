/**
 * READ-ONLY probe #3 for the 9 PARKED race-pack rows: pull Office
 * deposit/history for every candidate person record per guest to see
 * whether staff already loaded the missing credits by hand.
 *
 * Run from apps/web:  npx tsx scripts/parked-racepack-deposit-history.mts
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
  const from = "2026-01-01T00:00:00";
  const until = "2026-07-31T23:59:59";
  const res = await officeHttpsGet(
    `/api/${CLIENT_KEY}/deposit/history?personId=${personId}&from=${encodeURIComponent(from)}&until=${encodeURIComponent(until)}`,
  );
  if (res.status >= 400) return `HTTP ${res.status} ${res.body.slice(0, 120)}`;
  const rows = parseWithRawIds<any[]>(res.body);
  return Array.isArray(rows) ? rows : `non-array: ${res.body.slice(0, 200)}`;
}

// Every candidate record per guest (from probe #2), purchase date noted.
const CHECKS: Array<{ row: number; guest: string; bought: string; persons: string[] }> = [
  { row: 3, guest: "Mitchell Hepburn (+3 Anytime, 5/24)", bought: "2026-05-24", persons: ["63000000003507822"] },
  { row: 9, guest: "Jonah Sutton (+5 Mon-Thu, 6/14)", bought: "2026-06-14", persons: ["63000000003855311"] },
  {
    row: 12,
    guest: "Arcadio Arzola (+3 Anytime, 6/21)",
    bought: "2026-06-21",
    persons: ["45104787", "63000000003971871", "63000000003971976", "63000000003971982", "51895953", "51895962"],
  },
  {
    row: 14,
    guest: "Scott Ribble (REFUNDED 7/13 — expect desk pack purchase)",
    bought: "2026-06-30",
    persons: ["63000000004093242", "63000000004093239", "63000000004086103", "63000000004086058"],
  },
  { row: 15, guest: "Marilu Yates (+3 Mon-Thu, 7/1)", bought: "2026-07-01", persons: ["63000000004116763"] },
  {
    row: 20,
    guest: "Christian Searle (+3 Mon-Thu, 7/7)",
    bought: "2026-07-07",
    persons: ["54032540", "54036311", "63000000004198113", "63000000004183222", "63000000004183202"],
  },
  {
    row: 24,
    guest: "Dumas family (+3 Anytime, 7/9)",
    bought: "2026-07-09",
    persons: [
      "63000000000441333",
      "63000000000325128",
      "5270472",
      "63000000005387513",
      "56459525",
      "56459531",
      "56459507",
      "63000000005617503",
    ],
  },
  { row: 25, guest: "Eduard Tsepordey (+3 Anytime, 7/11)", bought: "2026-07-11", persons: ["63000000004250286", "63000000004250263"] },
  { row: 31, guest: "Nabil Bassil (+3 Mon-Thu, 7/15)", bought: "2026-07-15", persons: ["55060087", "63000000004542827"] },
];

let shownShape = false;
for (const c of CHECKS) {
  console.log("═".repeat(72));
  console.log(`row #${c.row}  ${c.guest}`);
  for (const pid of c.persons) {
    const hist = await depositHistory(pid);
    if (typeof hist === "string") {
      console.log(`  ${pid}: ${hist}`);
      continue;
    }
    const active = hist.filter(
      (h) => Number(h.balance) !== 0 || (Array.isArray(h.history) && h.history.length > 0),
    );
    if (active.length === 0) {
      console.log(`  ${pid}: all kinds zero, no history in 2026`);
      continue;
    }
    console.log(`  ${pid}:`);
    for (const h of active) {
      console.log(`    kind ${h.depositKindId} "${h.depositKind}" balance=${h.balance}`);
      for (const e of h.history ?? []) {
        console.log(`      ${JSON.stringify(e)}`);
      }
    }
  }
}
console.log("═".repeat(72));
console.log("done (read-only — no writes performed)");
