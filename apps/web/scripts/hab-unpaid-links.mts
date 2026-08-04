/**
 * READ-ONLY: dump every UNPAID Have-A-Ball invoice with its Square links —
 * the dashboard URL for staff and the `public_url` payment link for the guest.
 *
 * Companion to hab-unpaid-sweep.mts (2026-07-28 dunning blind spot).
 *
 * Usage: npx tsx scripts/hab-unpaid-links.mts
 */
import { readFileSync } from "node:fs";

const envRaw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
function envVal(key: string): string {
  if (process.env[key]) return process.env[key] as string;
  const m = envRaw.match(new RegExp(`^${key}=(.+)$`, "m"));
  return m ? m[1].trim().replace(/^"|"$/g, "") : "";
}
const HEADERS = {
  Authorization: `Bearer ${envVal("SQUARE_ACCESS_TOKEN")}`,
  "Content-Type": "application/json",
  "Square-Version": "2024-12-18",
};
const BASE = "https://connect.squareup.com/v2";
const usd = (c?: number) => `$${((c ?? 0) / 100).toFixed(2)}`;

async function sq(path: string, init?: RequestInit) {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: HEADERS });
  const t = await res.text();
  try {
    return JSON.parse(t);
  } catch {
    return { raw: t };
  }
}

/** The five members with a disabled subscription card (from the sweep). */
const TARGETS = [
  { name: "Sonia Hunt", sub: "792888e3-120d-4b7f-a019-400ffdaa63d6", cust: "D33RP0R0CNGQP2S41402N7ERNC" },
  { name: "Ryan Reiff", sub: "4d72fc03-094a-4079-87e7-36f4028deffe", cust: "NMM1MRB8JF2B036ZAWJY8QCCXR" },
  { name: "Jacob Elliott", sub: "157729bc-0270-44c8-8c4f-47f47847e51e", cust: "1K5SM5ZZEWVR3054XVB3K56J74" },
  { name: "Bonnie Zaino", sub: "cb08afe0-e183-4034-bcb1-ac1e9fcf6c0d", cust: "5WQJRHEDE585WQQ5760SKVFTK4" },
  { name: "Brian Gibbons", sub: "a67b2828-ab2b-4de8-98ed-3a23f1c92146", cust: "2GBC73GJ2J2NSKZ0197WKQT5YC" },
];

let total = 0;
for (const t of TARGETS) {
  const sub = (await sq(`/subscriptions/${t.sub}`)).subscription;
  const unpaid: any[] = [];
  for (const invId of sub?.invoice_ids ?? []) {
    const inv = (await sq(`/invoices/${encodeURIComponent(invId)}`)).invoice;
    if (!inv || inv.status === "PAID" || inv.status === "CANCELED") continue;
    unpaid.push(inv);
  }
  unpaid.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));

  console.log("\n" + "=".repeat(78));
  console.log(`${t.name} — ${unpaid.length} unpaid`);
  console.log(`  customer: https://app.squareup.com/dashboard/customers/directory/customer/${t.cust}`);
  console.log("=".repeat(78));

  for (const inv of unpaid) {
    const due = (inv.payment_requests ?? []).reduce(
      (s: number, r: any) =>
        s + (r.computed_amount_money?.amount ?? 0) - (r.total_completed_amount_money?.amount ?? 0),
      0,
    );
    total += due;
    console.log(
      `\n  #${inv.invoice_number}  week of ${String(inv.created_at).slice(0, 10)}  ${inv.status}  ${usd(due)}`,
    );
    console.log(`     invoice id : ${inv.id}`);
    console.log(`     PAY LINK   : ${inv.public_url ?? "(none — invoice not published)"}`);
    console.log(`     order      : ${inv.order_id}`);
    console.log(`     delivery   : ${inv.delivery_method ?? "-"}  due=${inv.payment_requests?.[0]?.due_date ?? "-"}`);
  }
}
console.log("\n" + "=".repeat(78));
console.log(`TOTAL UNPAID: ${usd(total)}`);
console.log("=".repeat(78));
