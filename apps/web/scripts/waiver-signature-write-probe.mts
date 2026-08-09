/**
 * NON-DESTRUCTIVE discovery: is there a WRITE endpoint for the person signature
 * slot (image/picture kind=5)?
 *
 * Why: POST /v2/bmi/waiver (Pandora) creates a waiver RECORD but never stores
 * the signature image — proven 2026-08-08 by correlating Office's waiver list
 * with its image endpoint across 11 waivers / 5 people:
 *
 *   desk-signed waiver  → number != NULL → image/picture kind=5 = 200
 *   Pandora waiver      → number == NULL → image/picture kind=5 = 404
 *
 * If Office exposes a write for kind=5 we can attach the signature ourselves
 * after Pandora creates the record, instead of waiting on a vendor fix.
 *
 * Sends NO image data — method discovery only (405 vs 404 vs 400 tells us what
 * exists). Nothing here can overwrite a stored signature.
 *
 * Run from apps/web:  npx tsx scripts/waiver-signature-write-probe.mts
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
/* eslint-disable @typescript-eslint/no-explicit-any */
import https from "node:https";
import { randomUUID } from "node:crypto";

const HOST = "office-api22.sms-timing.com";
const CLIENT_KEY = process.env.BMI_CLIENT_KEY || "headpinzftmyers";
const SMS_VERSION = "6251006 202511051229";
const USER = process.env.BMI_OFFICE_USERNAME || "API2";
const PASS = Buffer.from(process.env.BMI_OFFICE_PASSWORD_B64 || "JGMxbjFlbGxv", "base64").toString();
const TEST_PERSON = "63000000002660482"; // "tester headpinz" — never a real guest

const res0 = await fetch(`https://${HOST}/auth/token`, {
  method: "POST",
  headers: {
    "Content-Type": "application/x-www-form-urlencoded",
    clientkey: CLIENT_KEY,
    "x-fast-version": SMS_VERSION,
    origin: "https://office.bmileisure.com",
    referer: "https://office.bmileisure.com/",
  },
  body: `grant_type=password&username=${encodeURIComponent(USER)}&password=${encodeURIComponent(PASS)}`,
});
const TOKEN = (JSON.parse(await res0.text()) as { access_token: string }).access_token;

function req(method: string, path: string): Promise<{ status: number; body: string; allow?: string }> {
  return new Promise((resolve, reject) => {
    const r = https.request(
      {
        hostname: HOST,
        path,
        method,
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "x-fast-version": SMS_VERSION,
          "x-session-id": randomUUID(),
          clientkey: CLIENT_KEY,
        },
      },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () =>
          resolve({
            status: res.statusCode || 500,
            body: d,
            allow: (res.headers["allow"] as string) || undefined,
          }),
        );
      },
    );
    r.on("error", reject);
    r.setTimeout(15_000, () => {
      r.destroy();
      reject(new Error("timeout"));
    });
    r.end(); // NO BODY — discovery only
  });
}

const paths = [
  `/api/${CLIENT_KEY}/image/picture?personId=${TEST_PERSON}&kind=5`,
  `/api/${CLIENT_KEY}/image/picture`,
  `/api/${CLIENT_KEY}/image/signature?personId=${TEST_PERSON}`,
  `/api/${CLIENT_KEY}/person/${TEST_PERSON}/signature`,
  `/api/${CLIENT_KEY}/waivers?personId=${TEST_PERSON}`,
  `/api/${CLIENT_KEY}/waiver?personId=${TEST_PERSON}`,
];

for (const p of paths) {
  const line: string[] = [];
  for (const m of ["OPTIONS", "POST", "PUT"]) {
    try {
      const r = await req(m, p);
      line.push(`${m}=${r.status}${r.allow ? `(allow:${r.allow})` : ""}`);
    } catch (e) {
      line.push(`${m}=ERR`);
    }
  }
  console.log(`  ${p}\n     ${line.join("  ")}`);
}
process.exit(0);
