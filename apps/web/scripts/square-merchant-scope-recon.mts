/**
 * READ-ONLY: which Square merchant/locations does our token actually act for?
 *
 * The rep says unlinked refunds are enabled (2026-07-28) but the API declines
 * them. Before blaming either side, establish scope — an entitlement granted
 * on one merchant account or one location says nothing about the account+
 * location our token hits.
 *
 * Writes nothing. Run from apps/web:
 *   npx tsx scripts/square-merchant-scope-recon.mts
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const BASE = "https://connect.squareup.com/v2";
const H = {
  Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
  "Square-Version": "2025-01-23",
  "Content-Type": "application/json",
};
const PROBE_LOCATION = "6MZJFTGAYD7TC";

/* eslint-disable @typescript-eslint/no-explicit-any */
async function sq(method: string, path: string) {
  const res = await fetch(`${BASE}${path}`, { method, headers: H });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* empty */
  }
  return { ok: res.ok && !(json?.errors?.length > 0), status: res.status, json };
}
const errStr = (r: { status: number; json: any }) =>
  `HTTP ${r.status} ${JSON.stringify(r.json?.errors ?? r.json).slice(0, 300)}`;

console.log("═══ merchant(s) this token acts for ═══");
const m = await sq("GET", "/merchants");
if (!m.ok) console.log(errStr(m));
for (const mer of m.json?.merchant ?? []) {
  console.log(
    `  ${mer.id}  "${mer.business_name}"  country=${mer.country} currency=${mer.currency} ` +
      `status=${mer.status} main_location=${mer.main_location_id}`,
  );
}

console.log("\n═══ locations ═══");
const l = await sq("GET", "/locations");
if (!l.ok) console.log(errStr(l));
for (const loc of l.json?.locations ?? []) {
  const mark = loc.id === PROBE_LOCATION ? "  ← PROBE LOCATION" : "";
  console.log(
    `  ${loc.id}  "${loc.name}"  status=${loc.status} type=${loc.type ?? "?"} ` +
      `merchant=${loc.merchant_id} created=${loc.created_at?.slice(0, 10)}`,
  );
  console.log(
    `      capabilities=[${(loc.capabilities ?? []).join(", ")}] ` +
      `currency=${loc.currency} country=${loc.country}${mark}`,
  );
}

// Any refund the account has EVER produced without a payment_id would prove the
// feature has worked at least once, and where. Read-only scan of recent refunds.
console.log("\n═══ have we ever landed an unlinked refund? (recent refunds scan) ═══");
const since = "2026-06-01T00:00:00Z";
const r = await sq(
  "GET",
  `/refunds?begin_time=${encodeURIComponent(since)}&sort_order=DESC&limit=100`,
);
if (!r.ok) {
  console.log(errStr(r));
} else {
  const refunds = r.json?.refunds ?? [];
  const unlinked = refunds.filter((x: any) => !x.payment_id);
  console.log(`  ${refunds.length} refunds since ${since.slice(0, 10)}; ${unlinked.length} with no payment_id`);
  for (const x of unlinked.slice(0, 10)) {
    console.log(
      `    ${x.id} ${x.amount_money?.amount}¢ status=${x.status} loc=${x.location_id} ` +
        `dest=${x.destination_type ?? "?"} ${x.created_at?.slice(0, 19)} reason="${x.reason ?? ""}"`,
    );
  }
}
