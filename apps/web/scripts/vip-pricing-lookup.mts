/** Pull the VIP bowling catalog item price + confirm race/license/POV
 *  to ground the combo revenue-split proposal. Read-only. */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
const TOKEN = process.env.SQUARE_ACCESS_TOKEN!;
const H = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

// VIP bowling experience catalog item + the Ultimate Qualifier (racing) item.
for (const [label, id] of [
  ["VIP Bowling", "R66TY2VTICYUH4NM3F4UQVLF"],
  ["Ultimate Qualifier (racing)", "X4RZPTPJEJ45OG3S3HMDMCHZ"],
] as const) {
  const res = await fetch(`https://connect.squareup.com/v2/catalog/object/${id}?include_related_objects=true`, {
    headers: H,
  });
  const data = (await res.json()) as {
    object?: { item_data?: { name?: string; variations?: Array<{ id: string; item_variation_data?: { name?: string; price_money?: { amount?: number } } }> } };
    errors?: unknown;
  };
  if (!res.ok || data.errors) {
    console.log(`${label} (${id}): ERROR ${JSON.stringify(data.errors ?? data)}`);
    continue;
  }
  const item = data.object?.item_data;
  console.log(`\n${label} — "${item?.name}" (${id})`);
  for (const v of item?.variations ?? []) {
    const amt = v.item_variation_data?.price_money?.amount;
    console.log(
      `   • ${v.item_variation_data?.name ?? "(default)"}: ${amt != null ? `$${(amt / 100).toFixed(2)}` : "variable/none"}`,
    );
  }
}
