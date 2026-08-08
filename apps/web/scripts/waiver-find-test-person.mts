/**
 * READ-ONLY: find a TEST person in BMI to verify the signature fix against, so
 * no real guest's legal record collects proof marks.
 *
 * Run from apps/web:  npx tsx scripts/waiver-find-test-person.mts [token]
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

const HOST = "office-api22.sms-timing.com";
const CLIENT_KEY = process.env.BMI_CLIENT_KEY || "headpinzftmyers";
const SMS_VERSION = "6251006 202511051229";
const USER = process.env.BMI_OFFICE_USERNAME || "API2";
const PASS = Buffer.from(process.env.BMI_OFFICE_PASSWORD_B64 || "JGMxbjFlbGxv", "base64").toString();
const PANDORA = "https://bma-pandora-api.azurewebsites.net/v2";
const KEY = process.env.SWAGGER_ADMIN_KEY || "";
const LOC = "LAB52GY480CJF";

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
function get(path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      {
        hostname: HOST,
        path,
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "x-fast-version": SMS_VERSION,
          "x-session-id": randomUUID(),
          clientkey: CLIENT_KEY,
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
  });
}

for (const token of process.argv.slice(2).length ? process.argv.slice(2) : ["Test", "Tester", "Osborn"]) {
  const r = await get(`/api/${CLIENT_KEY}/search?token=${encodeURIComponent(token)}&maxResults=25`);
  const hits = r.status < 400 ? (parseWithRawIds<any[]>(r.body) ?? []) : [];
  // kind===1 is a PERSON hit (kind===2 is a project/reservation).
  const people = hits.filter((h) => h?.kind === 1);
  console.log(`\n══ "${token}" → ${r.status}, ${people.length} person hit(s) ══`);
  for (const p of people.slice(0, 12)) {
    let expiry: string | null = null;
    try {
      const pr = await fetch(`${PANDORA}/bmi/person/${LOC}/${p.localId}?picture=false&allRelated=false`, {
        headers: { Authorization: `Bearer ${KEY}` },
        signal: AbortSignal.timeout(10000),
      });
      expiry = ((await pr.json().catch(() => null)) as any)?.data?.waiverExpiry ?? null;
    } catch {
      /* unreadable */
    }
    console.log(
      `   id=${String(p.localId).padEnd(18)} "${p.description ?? p.name ?? ""}" waiverExpiry=${expiry ?? "none"}`,
    );
  }
}
process.exit(0);
