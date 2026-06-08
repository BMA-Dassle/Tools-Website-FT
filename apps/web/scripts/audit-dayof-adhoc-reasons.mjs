// READ-ONLY: for every day-of order with ad-hoc line items, classify WHY each
// quote line item is (or would be) ad-hoc, so we know what the fix actually is.
// Makes NO changes.
import fs from "fs";
import { neon } from "@neondatabase/serverless";

const env = fs.readFileSync("c:/GIT/Tools-Website-FT/apps/web/.env.local", "utf8");
const tok = env
  .match(/^SQUARE_ACCESS_TOKEN=(.+)$/m)[1]
  .trim()
  .replace(/^["']|["']$/g, "");
const sql = neon(
  "postgresql://neondb_owner:npg_j2dvUJEB0STo@ep-odd-frog-am0i4stu-pooler.c-5.us-east-1.aws.neon.tech/neondb?sslmode=require",
);
const BASE = "https://connect.squareup.com/v2";
const H = {
  Authorization: `Bearer ${tok}`,
  "Content-Type": "application/json",
  "Square-Version": "2024-12-18",
};
const d = (c) => `$${((c || 0) / 100).toFixed(2)}`;

const rows = await sql`
  SELECT id, event_number, event_name, center_code, event_date, status,
         square_location_id, square_dayof_order_id, line_items, tax_cents
  FROM group_function_quotes
  WHERE square_dayof_order_id IS NOT NULL AND square_dayof_order_id <> ''
    AND status NOT IN ('cancelled', 'denied')
  ORDER BY event_date ASC
`;

// Collect every PLU across all quotes, batch-retrieve catalog pricing once.
const allPlus = new Set();
for (const q of rows) {
  const li = typeof q.line_items === "string" ? JSON.parse(q.line_items) : q.line_items || [];
  for (const it of li) if (it.plu && it.plu.length > 10) allPlus.add(it.plu);
}
const catInfo = new Map();
const ids = [...allPlus];
for (let i = 0; i < ids.length; i += 100) {
  const chunk = ids.slice(i, i + 100);
  const res = await fetch(`${BASE}/catalog/batch-retrieve`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ object_ids: chunk }),
  });
  const data = await res.json();
  for (const obj of data.objects ?? []) {
    const v =
      obj.type === "ITEM_VARIATION"
        ? obj.item_variation_data
        : obj.item_data?.variations?.[0]?.item_variation_data;
    if (!v) continue;
    catInfo.set(obj.id, {
      pricingType: v.pricing_type ?? "FIXED_PRICING",
      priceCents: v.price_money?.amount ?? 0,
      name: v.name || obj.item_data?.name,
    });
  }
}

// Classify a quote line item the same way buildSquareLineItem would.
function classify(it) {
  const quoteCents = Math.round(it.price * 100);
  const hasPlu = !!it.plu && it.plu.length > 10;
  if (!hasPlu) return { code: "NO_PLU", detail: "no catalog id on product" };
  const ci = catInfo.get(it.plu);
  if (!ci) return { code: "PLU_UNRESOLVED", detail: `plu ${it.plu} not found in catalog` };
  if (ci.pricingType === "VARIABLE_PRICING")
    return { code: "SHOULD_LINK", detail: `variable pricing (plu ${it.plu})` };
  if (ci.priceCents === quoteCents)
    return {
      code: "SHOULD_LINK",
      detail: `fixed price matches ${d(ci.priceCents)} (plu ${it.plu})`,
    };
  return {
    code: "OVERRIDE",
    detail: `fixed catalog ${d(ci.priceCents)} != quote ${d(quoteCents)} (plu ${it.plu})`,
  };
}

const tally = {};
for (const q of rows) {
  const li = typeof q.line_items === "string" ? JSON.parse(q.line_items) : q.line_items || [];
  // fetch order to know which are actually ad-hoc right now
  const ord = (
    await (await fetch(`${BASE}/orders/${q.square_dayof_order_id}`, { headers: H })).json()
  ).order;
  const orderItems = ord?.line_items || [];
  const adhocInOrder = orderItems.filter((x) => !x.catalog_object_id);
  if (adhocInOrder.length === 0) continue;

  // does the order link ANYTHING? if 0 catalog links but quote has linkable items => full ad-hoc fallback
  const linkedInOrder = orderItems.filter((x) => x.catalog_object_id).length;
  const linkable = li.filter((it) => {
    const c = classify(it).code;
    return c === "SHOULD_LINK";
  }).length;
  const fullAdhocFallback = linkedInOrder === 0 && linkable > 0;

  console.log(
    `\n[quote ${q.id}] #${q.event_number || "?"} ${q.event_name} — ${q.center_code}  status=${q.status}  order=${ord.state}`,
  );
  console.log(
    `   order links ${linkedInOrder}/${orderItems.length}; quote has ${linkable} linkable item(s)${fullAdhocFallback ? "  *** FULL AD-HOC FALLBACK (linkable items lost their link) ***" : ""}`,
  );
  for (const it of li) {
    const c = classify(it);
    tally[c.code] = (tally[c.code] || 0) + 1;
    console.log(
      `     ${c.code.padEnd(14)} ${it.qty}x "${it.name}" @ ${d(Math.round(it.price * 100))}  — ${c.detail}`,
    );
  }
  if (q.tax_cents > 0)
    console.log(
      `     SVC_CHARGE     service charge ${d(q.tax_cents)} (always ad-hoc line, separate from line_items)`,
    );
}

console.log(`\n=== REASON TALLY (across all flagged quote line items) ===`);
for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1]))
  console.log(`   ${k.padEnd(16)} ${v}`);
console.log(`\nLegend:`);
console.log(
  `   SHOULD_LINK    has a usable catalog id (variable price, or fixed price already matches) — ad-hoc here is a BUG / fallback artifact, safe to relink`,
);
console.log(
  `   OVERRIDE       fixed catalog price != quote price — ad-hoc is CORRECT (linking would undercharge). Fix = make a proper catalog entry / variable price`,
);
console.log(
  `   NO_PLU         product has no catalog id at all — genuinely custom OR Hermes isn't supplying a plu`,
);
console.log(`   PLU_UNRESOLVED has a plu but catalog lookup failed — stale/deleted catalog id`);
