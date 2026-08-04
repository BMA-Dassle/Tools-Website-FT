/**
 * READ-ONLY: full objects for the three FAILED unlinked refunds.
 *
 * The scope recon turned up something the HTTP 400 hid: every unlinked refund
 * attempt (7/27 ×2 at TXBSQN0FEKQ11, 7/28 ×1 at 6MZJFTGAYD7TC) actually
 * EXISTS as a Refund object with `destination_type=CARD` and `status=FAILED`.
 * A request rejected on entitlement would normally never become an object at
 * all — so this looks less like "not permitted" and more like "permitted,
 * attempted, and the card push failed."
 *
 * Dump everything Square will tell us about them.
 *
 * Run from apps/web:  npx tsx scripts/unlinked-refund-failure-detail.mts
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

const IDS = [
  "D1I13IpuEamuT7U2G2NvJVhQ2JVZY_1u3oXyyrrjQXGZITOjBfd2SVz6LgxQL9GMMMOIkawvd",
  "5OJCBYftHvoDBvjdHDv42xFSClTZY_KYX8Hm08Qj2lrFdNYy7IqtXHB4pD15CburiEVwWtiMK",
  "5YoTve78bV06jgIIjOXLmRblrkNZY_3Y83Z0di7MQzFPcmZirK01f7pZopcCNx4zTGboLCklD",
];

/* eslint-disable @typescript-eslint/no-explicit-any */
async function sq(path: string) {
  const res = await fetch(`${BASE}${path}`, { headers: H });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* empty */
  }
  return { ok: res.ok && !(json?.errors?.length > 0), status: res.status, json };
}

for (const id of IDS) {
  console.log(`\n═══ refund ${id.slice(0, 40)}… ═══`);
  const r = await sq(`/refunds/${id}`);
  if (!r.ok) {
    console.log(`  read failed: HTTP ${r.status} ${JSON.stringify(r.json?.errors ?? r.json)}`);
    continue;
  }
  console.log(JSON.stringify(r.json.refund, null, 2));

  // An unlinked refund gets its OWN order per Square's docs — see what it holds.
  const oid = r.json.refund?.order_id;
  if (oid) {
    const o = await sq(`/orders/${oid}`);
    const ord = o.json?.order;
    console.log(
      `  → its refund order ${oid}: state=${ord?.state} total=${ord?.total_money?.amount}¢ ` +
        `lines=${(ord?.line_items ?? []).length} returns=${(ord?.returns ?? []).length} ` +
        `return_amounts.total=${ord?.return_amounts?.total_money?.amount ?? "-"}¢`,
    );
    for (const li of ord?.line_items ?? []) {
      console.log(`     line "${li.name}" ${li.total_money?.amount}¢ uid=${li.uid}`);
    }
  }
}
