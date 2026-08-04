/**
 * READ-ONLY recon for the unlinked-refund retest (2026-07-28).
 *
 * Square told the owner unlinked refunds are now enabled. The 7/27 probe
 * (gc-refund-probe-followup.mts) got REFUND_ERROR/REFUND_DECLINED with a
 * fully-valid request, so the entitlement was off then.
 *
 * This script writes NOTHING. It resolves the three inputs the live probe
 * needs:
 *   1. the owner's Square customer + enabled card on file (destination_id)
 *   2. a real SODA catalog item + variation + price (for the itemized line)
 *   3. whether the probe location can see that item
 *
 * Run from apps/web:  npx tsx scripts/unlinked-refund-recon.mts
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
// Owner rule: probes ALWAYS use this non-accounting location.
const LOCATION = "6MZJFTGAYD7TC";
const OWNER_EMAIL = "eric@headpinz.com";

/* eslint-disable @typescript-eslint/no-explicit-any */
async function sq(method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: H,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
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

if (!process.env.SQUARE_ACCESS_TOKEN) {
  console.log("no SQUARE_ACCESS_TOKEN in apps/web/.env.local — cannot recon");
  process.exit(2);
}

// ── 1. owner customer + card on file ────────────────────────────────────────
console.log("═══ 1. owner customer + card on file ═══");
const cust = await sq("POST", "/customers/search", {
  limit: 20,
  query: { filter: { email_address: { exact: OWNER_EMAIL } } },
});
if (!cust.ok) {
  console.log(`customer search failed: ${errStr(cust)}`);
} else {
  const list = cust.json.customers ?? [];
  console.log(`${list.length} customer(s) for ${OWNER_EMAIL}`);
  for (const c of list) {
    console.log(
      `  ${c.id}  ${c.given_name ?? ""} ${c.family_name ?? ""}`.trimEnd() +
        `  created=${c.created_at?.slice(0, 10)}`,
    );
    const cards = await sq("GET", `/cards?customer_id=${c.id}`);
    const cs = cards.json?.cards ?? [];
    if (!cs.length) console.log("    (no cards on file)");
    for (const cd of cs) {
      console.log(
        `    card ${cd.id}  ${cd.card_brand} …${cd.last_4}  exp ${cd.exp_month}/${cd.exp_year}` +
          `  enabled=${cd.enabled}  type=${cd.card_type ?? "?"}`,
      );
    }
  }
}

// ── 2. soda catalog item ────────────────────────────────────────────────────
console.log("\n═══ 2. soda catalog items ═══");
const search = await sq("POST", "/catalog/search-catalog-items", {
  text_filter: "soda",
  limit: 30,
});
if (!search.ok) {
  console.log(`catalog search failed: ${errStr(search)}`);
} else {
  const items = search.json.items ?? [];
  console.log(`${items.length} item(s) matching "soda"`);
  for (const it of items) {
    const d = it.item_data ?? {};
    console.log(`  ITEM ${it.id}  "${d.name}"  present_at_all=${it.present_at_all_locations}`);
    for (const v of d.variations ?? []) {
      const vd = v.item_variation_data ?? {};
      const price = vd.price_money?.amount;
      const at =
        v.present_at_all_locations === true
          ? "all locations"
          : (v.present_at_location_ids ?? []).includes(LOCATION)
            ? `includes ${LOCATION}`
            : `NOT at ${LOCATION}`;
      console.log(
        `    VAR ${v.id}  "${vd.name ?? "-"}"  ${price === undefined ? "variable price" : `${price}¢`}  ${at}`,
      );
    }
  }
}

// ── 3. sanity: does the probe location still exist / take orders? ───────────
console.log("\n═══ 3. probe location ═══");
const loc = await sq("GET", `/locations/${LOCATION}`);
console.log(
  loc.ok
    ? `${LOCATION} = "${loc.json.location?.name}" status=${loc.json.location?.status} ` +
        `capabilities=[${(loc.json.location?.capabilities ?? []).join(", ")}]`
    : `location read failed: ${errStr(loc)}`,
);
