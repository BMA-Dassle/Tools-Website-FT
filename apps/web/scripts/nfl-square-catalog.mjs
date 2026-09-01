/**
 * Create the four Square catalog objects NFL Ticket on NeoVerse needs, and
 * print the VARIATION ids the seed wants.
 *
 *   NFL Ticket on NeoVerse (3 Hrs)   $119.95   no modifiers
 *   Game Day Pizza                   $0.00     One included Topping + Pizza Toppings
 *   Game Day Wings (10)              $0.00     Sauce + Dippers + Breaded/Naked
 *                                                (required), Drums-or-Flats and
 *                                                Extra Sauce (optional, priced)
 *   Game Day Soda Pitcher            $0.00     Soda Choice
 *
 * EVERY MODIFIER LIST IS AN EXISTING ONE. Nothing new is created — the wing
 * lists were already on "Nemos Chicken Wings" (the 10-jumbo-wing item), and the
 * pizza/soda lists are the ones Pizza Bowl already uses. Read from the live
 * catalog 2026-08-31 rather than assumed:
 *
 *   J7VKRPRO6TLJOQEVBFQYXZGR  One included Topping  SINGLE
 *   D24QE4DVAPDK5DT7QVG5YIVL  Pizza Toppings        MULTIPLE   (paid extras)
 *   J66H25NSLZDVOZW2QPZO4EYP  Sauce Selection       MULTIPLE   Mild/Medium/Hot + 11
 *   AHWVRX4UFKBALXTKBPB7PMN5  Dippers               MULTIPLE   Ranch/Blue Cheese
 *   NU4UEVMHCNHAYUDKAI6XFEGK  Soda Choice           SINGLE
 *
 * The wings item carries SEVEN more enabled lists at the register (Breaded or
 * Naked, Drums/Flats, Extra Crispy, 1/2 & 1/2, Toss, Extra Dippers, Sauce
 * Extra-). They are deliberately NOT attached: the booking step requires a pick
 * in every attached list (it cannot read Square's min_selected_modifiers yet),
 * and three of them add cost the $119.95 does not cover. Owner decision
 * 2026-08-31, option A.
 *
 * Category, tax ids and location scoping are CLONED from the nearest existing
 * item rather than invented — the lane item from "1.5 Hr Mon-Thur VIP", the
 * three food items from "Pizza Bowl Pizza" — so these ring up and report exactly
 * like their siblings.
 *
 * Re-running is safe: it looks the items up by name first and skips any that
 * already exist, so it will not create duplicates.
 *
 * Usage:
 *   node apps/web/scripts/nfl-square-catalog.mjs            # dry run, prints the plan
 *   node apps/web/scripts/nfl-square-catalog.mjs --apply    # writes
 */

import { readFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";

for (const p of [
  "apps/web/.env.local",
  "../../apps/web/.env.local",
  "C:/GIT/Tools-Website-FT/apps/web/.env.local",
]) {
  if (!existsSync(p)) continue;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    let v = t.slice(i + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    if (!process.env[t.slice(0, i).trim()]) process.env[t.slice(0, i).trim()] = v;
  }
  break;
}

const APPLY = process.argv.includes("--apply");
const H = {
  Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
  "Content-Type": "application/json",
  "Square-Version": "2024-12-18",
};
const BASE = "https://connect.squareup.com/v2";

const LANE_TEMPLATE = "M6SVAMNQNWEMDLLM4SRM2T6C"; // 1.5 Hr Mon-Thur VIP
const FOOD_TEMPLATE = "NUGESUJBH5C3AEFQGPSWEWF2"; // Pizza Bowl Pizza

// { list, min, max } — min 0 is OPTIONAL, max null is unlimited. These are
// PER-ITEM overrides: the same list is required on the a-la-carte wings and
// optional here, which is exactly what the override exists for.
const MOD = {
  pizzaIncluded: { id: "J7VKRPRO6TLJOQEVBFQYXZGR", min: 1, max: 1 }, // One included Topping
  pizzaExtras: { id: "D24QE4DVAPDK5DT7QVG5YIVL", min: 0, max: null }, // paid extras, $1 ea
  wingSauce: { id: "J66H25NSLZDVOZW2QPZO4EYP", min: 1, max: 2 }, // Mild/Medium/Hot +11
  wingDippers: { id: "AHWVRX4UFKBALXTKBPB7PMN5", min: 1, max: 1 }, // Ranch / Blue Cheese
  wingBreading: { id: "ERVWHF7QP6XWNPCN4OWPMUNH", min: 1, max: 1 }, // Breaded or Naked
  wingCut: { id: "TBXFTPA2KHIRG56CDSMGT3WJ", min: 0, max: 1 }, // Drums/Flats, +$2
  wingExtraSauce: { id: "CKL3GK33VONWE4X5D5GU54MO", min: 0, max: null }, // +75c each
  soda: { id: "NU4UEVMHCNHAYUDKAI6XFEGK", min: 1, max: 1 }, // Soda Choice
};

async function getObject(id) {
  const r = await fetch(`${BASE}/catalog/object/${id}?include_related_objects=false`, {
    headers: H,
  });
  if (!r.ok) throw new Error(`get ${id}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return (await r.json()).object;
}

/** Category / tax / location scoping lifted from an existing sibling. */
function shapeFrom(tpl) {
  return {
    present_at_all_locations: tpl.present_at_all_locations ?? true,
    ...(tpl.absent_at_location_ids ? { absent_at_location_ids: tpl.absent_at_location_ids } : {}),
    itemBits: {
      is_taxable: tpl.item_data?.is_taxable ?? true,
      ...(tpl.item_data?.tax_ids ? { tax_ids: tpl.item_data.tax_ids } : {}),
      ...(tpl.item_data?.categories ? { categories: tpl.item_data.categories } : {}),
      ...(tpl.item_data?.category_id ? { category_id: tpl.item_data.category_id } : {}),
    },
  };
}

const modInfo = (mods) =>
  mods.map((m, ordinal) => ({
    modifier_list_id: m.id,
    enabled: true,
    hidden_from_customer: false,
    ordinal,
    // -1 is Square's "unset". A min of 0 must be sent as 0, not -1, or the
    // booking step cannot tell optional from unspecified.
    min_selected_modifiers: m.min,
    max_selected_modifiers: m.max ?? -1,
  }));

function buildItem({ key, name, description, priceCents, modifierListIds, shape }) {
  return {
    type: "ITEM",
    id: `#${key}`,
    present_at_all_locations: shape.present_at_all_locations,
    ...(shape.absent_at_location_ids
      ? { absent_at_location_ids: shape.absent_at_location_ids }
      : {}),
    item_data: {
      name,
      description,
      ...shape.itemBits,
      ...(modifierListIds.length ? { modifier_list_info: modInfo(modifierListIds) } : {}),
      variations: [
        {
          type: "ITEM_VARIATION",
          id: `#${key}_var`,
          present_at_all_locations: shape.present_at_all_locations,
          ...(shape.absent_at_location_ids
            ? { absent_at_location_ids: shape.absent_at_location_ids }
            : {}),
          item_variation_data: {
            item_id: `#${key}`,
            name: "Regular",
            pricing_type: "FIXED_PRICING",
            price_money: { amount: priceCents, currency: "USD" },
          },
        },
      ],
    },
  };
}

/** Already there? Match on exact name so a re-run is a no-op. */
async function findByName(name) {
  const r = await fetch(`${BASE}/catalog/search-catalog-items`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ text_filter: name, limit: 50 }),
  });
  if (!r.ok) return null;
  const j = await r.json();
  return (j.items ?? []).find((i) => i.item_data?.name === name) ?? null;
}

const varOf = (item) => item?.item_data?.variations?.[0]?.id ?? "(no variation)";

async function main() {
  if (!process.env.SQUARE_ACCESS_TOKEN) {
    console.error("✗ SQUARE_ACCESS_TOKEN is not set");
    process.exit(1);
  }

  const laneShape = shapeFrom(await getObject(LANE_TEMPLATE));
  const foodShape = shapeFrom(await getObject(FOOD_TEMPLATE));
  console.log(
    `templates: lane cat=${JSON.stringify(laneShape.itemBits.categories ?? laneShape.itemBits.category_id)} taxes=${(laneShape.itemBits.tax_ids ?? []).length}` +
      `  |  food cat=${JSON.stringify(foodShape.itemBits.categories ?? foodShape.itemBits.category_id)} taxes=${(foodShape.itemBits.tax_ids ?? []).length}\n`,
  );

  const plan = [
    {
      key: "nfl_lane",
      name: "NFL Ticket on NeoVerse (3 Hrs)",
      description:
        "Three hours on a VIP lane from 15 minutes before kickoff, with the game on the NeoVerse LED walls. Includes shoes, a one-topping pizza, 10 wings and a soda pitcher.",
      priceCents: 11995,
      modifierListIds: [],
      shape: laneShape,
    },
    {
      key: "nfl_pizza",
      name: "Game Day Pizza",
      description: "Included with NFL Ticket on NeoVerse. One topping included, $1 each extra.",
      priceCents: 0,
      modifierListIds: [MOD.pizzaIncluded, MOD.pizzaExtras],
      shape: foodShape,
    },
    {
      key: "nfl_wings",
      name: "Game Day Wings (10)",
      description:
        "Included with NFL Ticket on NeoVerse. 10 wings — pick a sauce, a dipper and how they are cooked. Drums-or-flats and extra sauce are optional and priced.",
      priceCents: 0,
      // Owner 2026-09-01: breaded-or-naked required, drums/flats and extra
      // sauce optional. Order is the order the guest answers them.
      modifierListIds: [
        MOD.wingSauce,
        MOD.wingDippers,
        MOD.wingBreading,
        MOD.wingCut,
        MOD.wingExtraSauce,
      ],
      shape: foodShape,
    },
    {
      key: "nfl_soda",
      name: "Game Day Soda Pitcher",
      description: "Included with NFL Ticket on NeoVerse.",
      priceCents: 0,
      modifierListIds: [MOD.soda],
      shape: foodShape,
    },
  ];

  const toCreate = [];
  for (const p of plan) {
    const existing = await findByName(p.name);
    if (existing) {
      console.log(`  EXISTS  "${p.name}"  item=${existing.id}  variation=${varOf(existing)}`);
      p.existing = existing;
    } else {
      console.log(
        `  CREATE  "${p.name}"  $${(p.priceCents / 100).toFixed(2)}\n` +
          (p.modifierListIds.length
            ? p.modifierListIds
                .map(
                  (m) =>
                    `            ${m.min > 0 ? "required" : "optional"}  min=${m.min} max=${m.max ?? "∞"}  ${m.id}`,
                )
                .join("\n")
            : "            (no modifier lists)"),
      );
      toCreate.push(buildItem(p));
    }
  }

  if (toCreate.length === 0) {
    console.log("\nNothing to create.");
  } else if (!APPLY) {
    console.log(
      `\n(dry run — ${toCreate.length} object(s) would be created. Re-run with --apply.)`,
    );
    return;
  } else {
    const r = await fetch(`${BASE}/catalog/batch-upsert-catalog-objects`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ idempotency_key: randomUUID(), batches: [{ objects: toCreate }] }),
    });
    const j = await r.json();
    if (!r.ok || j.errors) {
      console.error(`\n✗ upsert failed: ${r.status}`);
      console.error(JSON.stringify(j.errors ?? j, null, 1).slice(0, 1200));
      process.exit(1);
    }
    console.log(`\n✓ created ${(j.objects ?? []).length} object(s)`);
  }

  // Read back by name so the ids printed are what Square actually holds, not
  // what we hoped it would hold.
  console.log("\n─── paste these into scripts/seed-nfl-vip.mts ───");
  const consts = {
    "NFL Ticket on NeoVerse (3 Hrs)": "NFL_CAT_LANE",
    "Game Day Pizza": "NFL_CAT_PIZZA",
    "Game Day Wings (10)": "NFL_CAT_WINGS",
    "Game Day Soda Pitcher": "NFL_CAT_SODA",
  };
  const kitchen = [];
  for (const [name, constName] of Object.entries(consts)) {
    const it = await findByName(name);
    const v = varOf(it);
    console.log(`const ${constName} = "${v}";`.padEnd(58) + `// ${name}`);
    if (constName !== "NFL_CAT_LANE") kitchen.push(`  "${v}", // ${name}`);
  }
  console.log("\n─── and these into KITCHEN_CATALOG_IDS (lib/bowling-lane-open.ts) ───");
  console.log(kitchen.join("\n"));
  console.log("\n    …and the same three into ALLOWED_FOOD");
  console.log("    (app/api/bowling/v2/reservations/[id]/food/route.ts)");
}

main().catch((e) => {
  console.error(`\n✗ ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
