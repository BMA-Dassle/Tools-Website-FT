/**
 * READ-ONLY: Have-A-Ball dunning sweep — which members have UNPAID weeks, and
 * whose subscription card_id points at a card Square has DISABLED.
 *
 * Motivated by Ryan Reiff (2026-07-28): his card went dead after 6/30, Square
 * retried the same disabled token ~10 times, and nobody knew until he asked.
 * We have no dunning alert and no admin roster UI, so this is the only way to
 * see it. Checks every HAB subscription at HeadPinz FM.
 *
 * Usage: npx tsx scripts/hab-unpaid-sweep.mts
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
const LOCATION = "TXBSQN0FEKQ11";
const usd = (c?: number) => `$${((c ?? 0) / 100).toFixed(2)}`;

const HAB_VARIATIONS = new Set([
  "VGQZDMULELNJNVLC3SUSY2R3", "3J7LPA4KLZ25BOOYPBJBCLJM", "ZERDVGN2OHTR4PFV67DSD2IH",
  "7LUSLN3DHFSHRRCXTLN56SWY", "TVLPFCHCPHGVZNFEXMG5X35O", "2ULH65AUVNG4D2EX4PAUC5GL",
  "LQIT4BG2FFS5ZQEO4433545U", "GWX46J37YAPSSKQC2W6J4YEG", "2POXMBXRGHEVEGZMWDMCZI5D",
  "NVQBYL5ATAEVB3CM6EIYBA45", "HAQ4JRDW3N7WJROQTR77XFGA", "664QU2SYYHXJMH2M5TOUTSWH",
]);

async function sq(path: string, init?: RequestInit) {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: HEADERS });
  const text = await res.text();
  let j: any = {};
  try {
    j = JSON.parse(text);
  } catch {
    j = { raw: text };
  }
  if (!res.ok && res.status !== 404) console.error(`  ! ${res.status} ${path}: ${text.slice(0, 200)}`);
  return j;
}

// ---- all ACTIVE HAB subscriptions ----------------------------------------
const subs: any[] = [];
let c: string | undefined;
do {
  const body: any = { query: { filter: { location_ids: [LOCATION] } }, limit: 200 };
  if (c) body.cursor = c;
  const d = await sq("/subscriptions/search", { method: "POST", body: JSON.stringify(body) });
  subs.push(...(d.subscriptions ?? []));
  c = d.cursor;
} while (c);

const active = subs.filter((s) => HAB_VARIATIONS.has(s.plan_variation_id) && s.status === "ACTIVE");
console.log(`${active.length} ACTIVE Have-A-Ball subscription(s)\n`);

const cardCache = new Map<string, any>();
async function card(id: string) {
  if (!id) return null;
  if (!cardCache.has(id)) {
    const d = await sq(`/cards/${encodeURIComponent(id)}`);
    cardCache.set(id, d.card ?? null);
  }
  return cardCache.get(id);
}

let grandTotal = 0;
const problems: string[] = [];

for (const s of active) {
  const cust = (await sq(`/customers/${s.customer_id}`)).customer;
  const name = `${cust?.given_name ?? ""} ${cust?.family_name ?? ""}`.trim() || "(no name)";
  const subCard = await card(s.card_id);
  const custCards = ((await sq(`/cards?customer_id=${s.customer_id}`)).cards ?? []).filter(
    (x: any) => x.enabled,
  );

  let unpaid = 0;
  let unpaidCount = 0;
  const detail: string[] = [];
  for (const invId of s.invoice_ids ?? []) {
    const inv = (await sq(`/invoices/${encodeURIComponent(invId)}`)).invoice;
    if (!inv || inv.status === "PAID" || inv.status === "CANCELED") continue;
    const due = (inv.payment_requests ?? []).reduce(
      (t: number, r: any) =>
        t + (r.computed_amount_money?.amount ?? 0) - (r.total_completed_amount_money?.amount ?? 0),
      0,
    );
    unpaid += due;
    unpaidCount++;
    detail.push(`${String(inv.created_at).slice(0, 10)} ${inv.status} ${usd(due)} #${inv.invoice_number}`);
  }
  grandTotal += unpaid;

  const cardDead = subCard && subCard.enabled === false;
  const cardMissing = !subCard;
  const flag =
    unpaidCount || cardDead || cardMissing
      ? `  <<< ${[
          unpaidCount ? `${unpaidCount} UNPAID ${usd(unpaid)}` : "",
          cardDead ? "SUB CARD DISABLED" : "",
          cardMissing ? "SUB CARD MISSING" : "",
        ]
          .filter(Boolean)
          .join(" + ")}`
      : "";

  console.log(
    `${name.padEnd(20)} sub=${s.id}  subcard=${subCard ? `••${subCard.last_4} enabled=${subCard.enabled}` : "UNRESOLVABLE"}  ` +
      `enabled_cards_on_cust=${custCards.length}  ${cust?.email_address ?? ""}${flag}`,
  );
  for (const d of detail) console.log(`     unpaid: ${d}`);

  if (flag) {
    problems.push(
      `${name} (${cust?.email_address ?? "?"}) sub=${s.id} — ${flag.replace("  <<< ", "")}` +
        (custCards.length
          ? `; newest enabled card on customer: ${custCards[custCards.length - 1].id} ••${custCards[custCards.length - 1].last_4}`
          : "; NO enabled card on customer"),
    );
  }
}

console.log("\n" + "=".repeat(78));
console.log(`TOTAL OUTSTANDING across active Have-A-Ball members: ${usd(grandTotal)}`);
console.log("=".repeat(78));
for (const p of problems) console.log(` - ${p}`);
console.log("\ndone.");
