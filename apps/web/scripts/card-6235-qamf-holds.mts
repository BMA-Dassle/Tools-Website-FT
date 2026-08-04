/**
 * READ-ONLY: is the orphaned QAMF lane hold from Natalie Torres' failed 17:29
 * attempt still sitting on a lane tonight?
 *
 *   X160982 — the FAILED attempt's hold (no Neon row, BMI bill stripped to -4)
 *   X160990 — the GOOD booking's hold (Neon 17193, BMI W55673)
 *
 * Also re-reads all three BMI bills so we can say whether BMI failed FIRST
 * (cause) or was stripped AFTER (consequence). NO WRITES — no deleteReservation,
 * no status change.
 *
 * Run from apps/web:  npx tsx scripts/card-6235-qamf-holds.mts
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
/* eslint-disable @typescript-eslint/no-explicit-any */
import { parseWithRawIds } from "@ft/db";

// QAMF is NOT queried here: QAMF_BOWLING_SUBSCRIPTION_KEY is Vercel-only, so a
// local read of holds X160982 / X160990 returns 401. Check those from the
// deployed app, not from this script.
console.log("QAMF holds X160982 / X160990: NOT CHECKED (no local subscription key)\n");

// ── BMI bills, current state ──
const KEY = "headpinzftmyers";
const SUB = process.env.BMI_SUBSCRIPTION_KEY || "";
const API = process.env.BMI_API_URL || "https://api.bmileisure.com";
const tok = (
  await (
    await fetch(`${API}/auth/${KEY}/publicbooking`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "BMI-Subscription-Key": SUB },
      body: JSON.stringify({ Username: process.env.BMI_USERNAME, Password: process.env.BMI_PASSWORD }),
    })
  ).json()
).AccessToken;

console.log("\n\n══════ BMI BILLS — current state ══════");
for (const [label, bill] of [
  ["#1 orphan  (17:28, card charged)", "63000000006501987"],
  ["#2 abandoned (18:18)", "63000000006502063"],
  ["#3 GOOD    (18:19)", "63000000006502272"],
] as const) {
  const res = await fetch(`${API}/public-booking/${KEY}/order/${bill}/overview`, {
    headers: { Authorization: `Bearer ${tok}`, "BMI-Subscription-Key": SUB, "Accept-Language": "en" },
  });
  const text = await res.text();
  if (!res.ok) {
    console.log(`\n  ${label} ${bill} → HTTP ${res.status}`);
    continue;
  }
  const o = parseWithRawIds(text) as any;
  console.log(
    `\n  ${label}  ${bill}` +
      `\n    reservation=${o.reservationNumber} statusId=${o.statusId} date=${o.date}` +
      `\n    created=${o.created}  updated=${o.updated}` +
      `\n    lines=${o.lines?.length ?? 0} scheduleDays=${o.scheduleDays?.length ?? 0} totalPaid=${o.totalPaid} totalToDeposit=${o.totalToDeposit}`,
  );
  for (const l of o.lines ?? [])
    console.log(`      • ${l.quantity ?? ""}× ${l.description ?? l.name ?? ""}`);
}
process.exit(0);
