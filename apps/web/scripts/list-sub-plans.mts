/** List all Square subscription plans + their variations (id, name, cadence,
 *  price). Read-only. Run from apps/web:  npx tsx scripts/list-sub-plans.mts */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
const TOKEN = process.env.SQUARE_ACCESS_TOKEN!;
const H = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

type Phase = {
  ordinal?: number;
  cadence?: string;
  periods?: number | null;
  recurring_price_money?: { amount?: number };
  pricing?: { type?: string; price_money?: { amount?: number } };
};
type Obj = {
  id: string;
  type: string;
  is_deleted?: boolean;
  subscription_plan_data?: { name?: string; subscription_plan_variations?: Obj[] };
  subscription_plan_variation_data?: {
    name?: string;
    subscription_plan_id?: string;
    phases?: Phase[];
  };
};

function usd(a?: number) {
  return a == null ? "relative" : `$${(a / 100).toFixed(2)}`;
}
function phaseStr(ph?: Phase[]) {
  if (!ph?.length) return "(no phases)";
  return ph
    .map((p) => {
      const price = p.recurring_price_money?.amount ?? p.pricing?.price_money?.amount;
      const per = p.periods != null ? ` ×${p.periods}` : "";
      return `${p.cadence ?? "?"}${per} ${usd(price)}`;
    })
    .join(" | ");
}

// Pull all pages of SUBSCRIPTION_PLAN + SUBSCRIPTION_PLAN_VARIATION.
const objects: Obj[] = [];
let cursor: string | undefined;
do {
  const url = new URL("https://connect.squareup.com/v2/catalog/list");
  url.searchParams.set("types", "SUBSCRIPTION_PLAN,SUBSCRIPTION_PLAN_VARIATION");
  if (cursor) url.searchParams.set("cursor", cursor);
  const r = await fetch(url, { headers: H });
  const d = (await r.json()) as { objects?: Obj[]; cursor?: string; errors?: unknown };
  if (d.errors) {
    console.log("ERRORS:", JSON.stringify(d.errors));
    break;
  }
  objects.push(...(d.objects ?? []));
  cursor = d.cursor;
} while (cursor);

const plans = objects.filter((o) => o.type === "SUBSCRIPTION_PLAN" && !o.is_deleted);
const vars = objects.filter((o) => o.type === "SUBSCRIPTION_PLAN_VARIATION" && !o.is_deleted);

console.log(`\n=== ${plans.length} plan(s), ${vars.length} variation(s) ===\n`);
for (const plan of plans) {
  console.log(`PLAN ${plan.id}  "${plan.subscription_plan_data?.name ?? "?"}"`);
  const mine = vars.filter(
    (v) => v.subscription_plan_variation_data?.subscription_plan_id === plan.id,
  );
  for (const v of mine) {
    const vd = v.subscription_plan_variation_data!;
    console.log(`   VAR ${v.id}  "${vd.name ?? "?"}"  [${phaseStr(vd.phases)}]`);
  }
  if (!mine.length) console.log("   (no variations)");
  console.log("");
}

// Any orphan variations not matched above (defensive).
const orphans = vars.filter(
  (v) =>
    !plans.some((p) => p.id === v.subscription_plan_variation_data?.subscription_plan_id),
);
if (orphans.length) {
  console.log("=== variations with no matching plan in result ===");
  for (const v of orphans) {
    const vd = v.subscription_plan_variation_data!;
    console.log(`   VAR ${v.id}  "${vd.name ?? "?"}"  plan=${vd.subscription_plan_id}  [${phaseStr(vd.phases)}]`);
  }
}
