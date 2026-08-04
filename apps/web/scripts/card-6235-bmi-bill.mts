/**
 * READ-ONLY: dump BMI bill 63000000006501987 (Natalie Torres, ****6235) —
 * the racers/party and line items behind the $346.12 that captured but never
 * reserved. Bigint-safe (parseWithRawIds). NO WRITES.
 *
 * Run from apps/web:  npx tsx scripts/card-6235-bmi-bill.mts
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
import { parseWithRawIds } from "@ft/db";
/* eslint-disable @typescript-eslint/no-explicit-any */

const BMI_API_URL = process.env.BMI_API_URL || "https://api.bmileisure.com";
const SUB = process.env.BMI_SUBSCRIPTION_KEY || "";
const BILL = "63000000006501987";

// FastTrax / HeadPinz client keys — try each until the bill resolves.
const CANDIDATE_KEYS = Array.from(
  new Set(
    [
      process.env.BMI_CLIENT_KEY,
      process.env.BMI_CLIENT_KEY_FT,
      process.env.BMI_CLIENT_KEY_HPFM,
      "fasttrax",
      "headpinz",
    ].filter(Boolean) as string[],
  ),
);
console.log(`env keys present: ${CANDIDATE_KEYS.join(", ")}`);

async function token(clientKey: string) {
  const res = await fetch(`${BMI_API_URL}/auth/${clientKey}/publicbooking`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "BMI-Subscription-Key": SUB },
    body: JSON.stringify({ Username: process.env.BMI_USERNAME, Password: process.env.BMI_PASSWORD }),
  });
  if (!res.ok) throw new Error(`auth ${clientKey}: ${res.status} ${await res.text()}`);
  const d = await res.json();
  return d.AccessToken || d.accessToken;
}

for (const key of CANDIDATE_KEYS) {
  let t: string;
  try {
    t = await token(key);
  } catch (e) {
    console.log(`\n── ${key}: ${(e as Error).message.slice(0, 160)}`);
    continue;
  }
  for (const path of [
    `/public-booking/${key}/order/${BILL}/overview`,
    `/public-booking/${key}/order/${BILL}`,
  ]) {
    const res = await fetch(`${BMI_API_URL}${path}`, {
      headers: {
        Authorization: `Bearer ${t}`,
        "BMI-Subscription-Key": SUB,
        "Accept-Language": "en",
      },
    });
    const text = await res.text();
    console.log(`\n══════ ${key} ${path} → HTTP ${res.status} ══════`);
    if (!res.ok) {
      console.log(`  ${text.slice(0, 400)}`);
      continue;
    }
    const j = parseWithRawIds(text) as any;
    console.log(JSON.stringify(j, null, 2));
  }
}
process.exit(0);
