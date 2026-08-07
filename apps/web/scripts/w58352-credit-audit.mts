/**
 * READ-ONLY audit for W58352 (kiosk, 8/6/2026) — "we didn't take race credits
 * off when we booked them; it took off some but not others".
 *
 * Search W-number -> project -> people/products/bills, then pull Office
 * deposit/history for every person on the reservation so we can see exactly
 * which credits were drawn down and which were not.
 * NO WRITES.
 *
 * Run from apps/web:  npx tsx scripts/w58352-credit-audit.mts
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
const W = process.argv[2] || "W58352";

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
    req.setTimeout(20_000, () => {
      req.destroy();
      reject(new Error("timeout"));
    });
  });
}

console.log(`══════ 1. Office search for ${W} ══════`);
const searchRes = await officeHttpsGet(
  `/api/${CLIENT_KEY}/search?token=${encodeURIComponent(W)}&maxResults=5`,
);
if (searchRes.status >= 400) {
  console.log(`  search HTTP ${searchRes.status}: ${searchRes.body.slice(0, 300)}`);
  process.exit(1);
}
const hits = parseWithRawIds<any[]>(searchRes.body);
for (const h of hits ?? [])
  console.log(`  hit kind=${h.kind} localId=${h.localId} desc=${h.description ?? h.name ?? ""}`);
const projHit = (hits ?? []).find((h: any) => h?.kind === 2);
if (!projHit?.localId) {
  console.log("  no kind===2 project hit");
  process.exit(1);
}
const projectId = String(projHit.localId);

console.log(`\n══════ 2. Project ${projectId} ══════`);
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
    console.log(`    • ${s.length > 1200 ? s.slice(0, 1200) + "…" : s}`);
  }
}

// ── 3. Collect every personId referenced anywhere on the project ─────────────
const personIds = new Set<string>();
function harvest(node: any) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    node.forEach(harvest);
    return;
  }
  for (const [k, v] of Object.entries(node)) {
    if (/^person(Id)?$/i.test(k) && (typeof v === "string" || typeof v === "number")) {
      const s = String(v);
      if (/^\d{5,}$/.test(s)) personIds.add(s);
    } else harvest(v);
  }
}
harvest(project);

console.log(`\n══════ 3. Deposit history for ${personIds.size} person(s) ══════`);
for (const pid of personIds) {
  const from = "2026-06-01T00:00:00";
  const until = "2026-08-07T23:59:59";
  const res = await officeHttpsGet(
    `/api/${CLIENT_KEY}/deposit/history?personId=${pid}&from=${encodeURIComponent(from)}&until=${encodeURIComponent(until)}`,
  );
  if (res.status >= 400) {
    console.log(`  ${pid}: HTTP ${res.status} ${res.body.slice(0, 150)}`);
    continue;
  }
  const rows = parseWithRawIds<any[]>(res.body);
  if (!Array.isArray(rows)) {
    console.log(`  ${pid}: non-array ${res.body.slice(0, 200)}`);
    continue;
  }
  const active = rows.filter(
    (h) => Number(h.balance) !== 0 || (Array.isArray(h.history) && h.history.length > 0),
  );
  console.log(`\n  ── person ${pid} ──`);
  if (active.length === 0) {
    console.log("    all kinds zero, no history in window");
    continue;
  }
  for (const h of active) {
    console.log(`    kind ${h.depositKindId} "${h.depositKind}" balance=${h.balance}`);
    for (const e of h.history ?? []) console.log(`      ${JSON.stringify(e)}`);
  }
}
console.log("\n" + "═".repeat(72));
console.log("done (read-only — no writes performed)");
