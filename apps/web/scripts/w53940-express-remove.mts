/**
 * TEMP FIX — strip the false "Express Lane" from ONE reservation (W53940,
 * bill 63000000005919831, Adam Houghtaling, 7/28 1:10 PM Mega).
 *
 * Adam booked online 7/24 and the booking record carries `fastLane: true`, so
 * BMI's reservation memo tells the front desk "all waivers valid; skip Guest
 * Services". Live Pandora says otherwise: waiverExpiry is NULL on personId
 * 56177017 → no valid waiver. He must be checked in normally.
 *
 * Two writes, both scoped to this one bill:
 *   1. Redis booking record  — `"fastLane":true` → `"fastLane":false` (surgical
 *      string edit on the raw JSON, TTL preserved; no parse/stringify so the
 *      17-digit ids can't be touched).
 *   2. BMI booking memo      — rewritten WITHOUT the express line and WITH an
 *      explicit no-waiver warning, keeping the booking link + amount paid.
 *      `booking/memo` OVERWRITES the single memo field, so the full text is
 *      composed here (see features/booking/service/reservation-memo.ts).
 *
 * Usage (from apps/web):  npx tsx scripts/w53940-express-remove.mts [--apply]
 * Without --apply this prints exactly what it would write and touches nothing.
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const APPLY = process.argv.includes("--apply");
const BILL_ID = "63000000005919831";
const RES = "W53940";
const CLIENT_KEY = "headpinzftmyers"; // FastTrax racing books under the FM client
const NEW_MEMO = [
  `** NO VALID WAIVER ** ${RES} — waiver NOT on file (Pandora waiverExpiry is empty).`,
  `Guest must sign a waiver at Guest Services / kiosk before racing. The earlier`,
  `"EXPRESS LANE" note on this reservation was wrong — do NOT skip check-in.`,
  `Booking: https://fasttraxent.com/s/Aa2gTQED`,
  `Paid online: $53.23`,
].join("\n");

const { default: redis } = await import("@/lib/redis");

// ── 1. Redis booking record ────────────────────────────────────────────
const key = `bookingrecord:${BILL_ID}`;
const raw = await redis.get(key);
if (!raw) throw new Error(`${key} missing`);
const ttl = await redis.ttl(key);
const hits = raw.match(/"fastLane":\s*true/g) ?? [];
console.log(`\n${key}  (ttl ${ttl}s)`);
console.log(`  "fastLane":true occurrences → ${hits.length}`);
if (hits.length !== 1) throw new Error("expected exactly one fastLane:true — aborting");
const next = raw.replace(/"fastLane":\s*true/, '"fastLane":false');
console.log(`  → ${next.match(/"fastLane":\s*\w+/)?.[0]}`);
console.log(`  length ${raw.length} → ${next.length} (ids untouched: ${next.includes(`"billId":"${BILL_ID}"`)})`);

console.log(`\nBMI memo for ${RES} (${CLIENT_KEY}) would become:\n${"─".repeat(70)}\n${NEW_MEMO}\n${"─".repeat(70)}`);

if (!APPLY) {
  console.log("\nDRY RUN — nothing written. Re-run with --apply.\n");
  process.exit(0);
}

if (ttl > 0) await redis.set(key, next, "EX", ttl);
else await redis.set(key, next);
const check = await redis.get(key);
console.log(`\n✔ Redis written — now ${check?.match(/"fastLane":\s*\w+/)?.[0]} (ttl ${await redis.ttl(key)}s)`);

// ── 2. BMI booking memo ────────────────────────────────────────────────
const BMI_URL = process.env.BMI_API_URL || "https://api.bmileisure.com";
const SUB = process.env.BMI_SUBSCRIPTION_KEY || "";
const authRes = await fetch(`${BMI_URL}/auth/${CLIENT_KEY}/publicbooking`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "BMI-Subscription-Key": SUB },
  body: JSON.stringify({ Username: process.env.BMI_USERNAME, Password: process.env.BMI_PASSWORD }),
});
if (!authRes.ok) throw new Error(`BMI auth failed: ${authRes.status} ${await authRes.text()}`);
const auth = (await authRes.json()) as { AccessToken?: string; accessToken?: string };
const token = auth.AccessToken || auth.accessToken;

// orderId raw-injected — 17-digit BMI id, never Number()/parse it.
const memoRes = await fetch(`${BMI_URL}/public-booking/${CLIENT_KEY}/booking/memo`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${token}`,
    "BMI-Subscription-Key": SUB,
    "Content-Type": "application/json",
    "Accept-Language": "en",
  },
  body: `{"orderId":${BILL_ID},"memo":${JSON.stringify(NEW_MEMO)}}`,
});
console.log(`✔ BMI booking/memo → ${memoRes.status} ${memoRes.ok ? "OK" : await memoRes.text()}`);
process.exit(memoRes.ok ? 0 : 1);
