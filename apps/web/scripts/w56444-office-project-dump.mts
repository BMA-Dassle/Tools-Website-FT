/**
 * READ-ONLY Office API dump for W56444 — the planning rows (schedules) behind
 * the phantom 9:12–9:19 PM Blue Track row. Search W-number → project →
 * dump schedules/products/people with every timestamp the API returns.
 * NO WRITES.
 *
 * Run from apps/web:  npx tsx scripts/w56444-office-project-dump.mts
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
const W = "W56444";

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
const authHeaders = {
  Authorization: `Bearer ${token}`,
  "x-fast-version": SMS_VERSION,
  clientkey: CLIENT_KEY,
};

function officeHttpsGet(path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      { hostname: OFFICE_HOST, path, headers: { ...authHeaders, "x-session-id": randomUUID() } },
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

console.log("══════ 1. Office search for", W, "══════");
const searchRes = await officeHttpsGet(
  `/api/${CLIENT_KEY}/search?token=${encodeURIComponent(W)}&maxResults=5`,
);
if (searchRes.status >= 400) {
  console.log(`  search HTTP ${searchRes.status}: ${searchRes.body.slice(0, 300)}`);
  process.exit(1);
}
const hits = parseWithRawIds<any[]>(searchRes.body);
for (const h of hits ?? []) console.log(`  hit kind=${h.kind} localId=${h.localId} desc=${h.description ?? h.name ?? ""}`);
const projHit = (hits ?? []).find((h: any) => h?.kind === 2);
if (!projHit?.localId) {
  console.log("  no kind===2 project hit");
  process.exit(1);
}
const projectId = String(projHit.localId);

console.log(`\n══════ 2. Project ${projectId} full dump ══════`);
const projRes = await officeHttpsGet(`/api/${CLIENT_KEY}/project/${projectId}`);
if (projRes.status >= 400) {
  console.log(`  project HTTP ${projRes.status}: ${projRes.body.slice(0, 300)}`);
  process.exit(1);
}
const project = parseWithRawIds<any>(projRes.body);
const arrKeys: string[] = [];
for (const k of Object.keys(project)) {
  const v = project[k];
  if (Array.isArray(v)) {
    arrKeys.push(k);
    continue;
  }
  const s = JSON.stringify(v);
  console.log(`  ${k} = ${s && s.length > 200 ? s.slice(0, 200) + "…" : s}`);
}
for (const k of arrKeys) {
  const v = project[k] as any[];
  console.log(`\n  ── ${k} (${v.length}) ──`);
  for (const item of v) {
    const s = JSON.stringify(item);
    console.log(`    • ${s.length > 900 ? s.slice(0, 900) + "…" : s}`);
  }
}
process.exit(0);
