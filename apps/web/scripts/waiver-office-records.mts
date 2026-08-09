/**
 * READ-ONLY: list the waiver RECORDS BMI Office holds for a person, and whether
 * a signature IMAGE exists alongside them.
 *
 *   POST /api/{clientKey}/waivers?personId={id}   body {"validOn":ISO,"showAll":bool}
 *     → [{ valid, number, name, signedBy, signed, validTill, id }]
 *   GET  /api/{clientKey}/image/picture?personId={id}&kind=5   (no auth)
 *     → the signature JPEG, or 404 when none is stored
 *
 * Both discovered from an Office HAR (owner, 2026-08-08). Together they are the
 * first way we have EVER been able to ask "does BMI hold this guest's
 * signature?" — Pandora has no such read-back.
 *
 * Hypothesis under test: `number` is non-null exactly when a signature image
 * exists, and waivers submitted through Pandora's POST /bmi/waiver come back
 * with number=null and no image.
 *
 * Run from apps/web:  npx tsx scripts/waiver-office-records.mts <personId>...
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

function post(path: string, payload: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: HOST,
        path,
        method: "POST",
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "x-fast-version": SMS_VERSION,
          "x-session-id": randomUUID(),
          clientkey: CLIENT_KEY,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (r) => {
        let d = "";
        r.on("data", (c) => (d += c));
        r.on("end", () => resolve({ status: r.statusCode || 500, body: d }));
      },
    );
    req.on("error", reject);
    req.setTimeout(20_000, () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    req.end(payload);
  });
}

async function hasSignatureImage(id: string): Promise<string> {
  try {
    const r = await fetch(
      `https://${HOST}/api/${CLIENT_KEY}/image/picture?personId=${id}&kind=5`,
      { headers: { referer: "https://office.bmileisure.com/" }, signal: AbortSignal.timeout(15000) },
    );
    if (!r.ok) return `NO (HTTP ${r.status})`;
    const b = Buffer.from(await r.arrayBuffer());
    return `YES (${b.length}B)`;
  } catch {
    return "ERR";
  }
}

const IDS = process.argv.slice(2);
const body = JSON.stringify({ validOn: new Date().toISOString(), showAll: true });

for (const id of IDS) {
  const r = await post(`/api/${CLIENT_KEY}/waivers?personId=${id}`, body);
  const img = await hasSignatureImage(id);
  console.log(`\n════ person ${id} ════   signature image: ${img}`);
  if (r.status >= 400) {
    console.log(`  waivers HTTP ${r.status}: ${r.body.slice(0, 200)}`);
    continue;
  }
  let list: any[] = [];
  try {
    list = JSON.parse(r.body);
  } catch {
    console.log(`  unparseable: ${r.body.slice(0, 200)}`);
    continue;
  }
  if (list.length === 0) console.log("  (no waiver records)");
  for (const w of list) {
    console.log(
      `  • id=${String(w.id).padEnd(12)} number=${String(w.number ?? "NULL").padEnd(8)} ${String(w.name).padEnd(6)} ` +
        `valid=${w.valid} signedBy="${w.signedBy ?? ""}" signed=${String(w.signed).slice(0, 19)} till=${String(w.validTill).slice(0, 10)}`,
    );
  }
}
process.exit(0);
