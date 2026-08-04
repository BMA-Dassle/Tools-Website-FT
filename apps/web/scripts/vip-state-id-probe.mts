/**
 * READ-ONLY probe: enumerate BMI Office project STATES for FastTrax
 * (headpinzftmyers) and Naples, to find the id of the new custom
 * "Confirmation - VIP" reservation state. NO WRITES.
 *
 * Run from apps/web:  npx tsx scripts/vip-state-id-probe.mts
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
const SMS_VERSION = "6251006 202511051229";
const OFFICE_USER = process.env.BMI_OFFICE_USERNAME || "API2";
const OFFICE_PASS_B64 = process.env.BMI_OFFICE_PASSWORD_B64 || "JGMxbjFlbGxv";

async function getToken(clientKey: string): Promise<string> {
  const password = Buffer.from(OFFICE_PASS_B64, "base64").toString();
  const res = await fetch(`https://${OFFICE_HOST}/auth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      clientkey: clientKey,
      "x-fast-version": SMS_VERSION,
      origin: "https://office.bmileisure.com",
      referer: "https://office.bmileisure.com/",
    },
    body: `grant_type=password&username=${encodeURIComponent(OFFICE_USER)}&password=${encodeURIComponent(password)}`,
  });
  if (!res.ok) throw new Error(`office auth ${res.status} ${await res.text()}`);
  return JSON.parse(await res.text()).access_token;
}

function officeGet(
  token: string,
  clientKey: string,
  path: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      {
        hostname: OFFICE_HOST,
        path,
        headers: {
          Authorization: `Bearer ${token}`,
          "x-fast-version": SMS_VERSION,
          clientkey: clientKey,
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

for (const clientKey of ["headpinzftmyers", "headpinznaples"]) {
  console.log(`\n══════════ ${clientKey} ══════════`);
  let token: string;
  try {
    token = await getToken(clientKey);
  } catch (e) {
    console.log(`  auth failed: ${(e as Error).message}`);
    continue;
  }
  const r = await officeGet(token, clientKey, `/api/${clientKey}/metadata`);
  if (r.status >= 400) {
    console.log(`  metadata → ${r.status} ${r.body.slice(0, 200)}`);
    continue;
  }
  const blob = JSON.parse(r.body) as Record<string, any>;
  console.log(`  metadata → 200, ${r.body.length}b, top-level keys:`);
  for (const k of Object.keys(blob)) {
    const v = blob[k];
    console.log(`      ${k}${Array.isArray(v) ? ` [${v.length}]` : ` (${typeof v})`}`);
  }
  for (const key of ["states", "projectStates", "stateTypes", "projectStateTypes"]) {
    const arr = blob[key];
    if (!Array.isArray(arr)) continue;
    console.log(`\n  ── ${key} (${arr.length}) ──`);
    for (const s of arr) {
      console.log(`      ${JSON.stringify(s)}`);
    }
  }
}
process.exit(0);
