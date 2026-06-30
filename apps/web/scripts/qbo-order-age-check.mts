// READ-ONLY: fetch the specific orders flagged by the QBO sync as "missing
// Square category" and report, per order: created_at date, location, and for
// each race/POV line whether it carries a catalog_object_id. Answers the
// question: are these OLD (pre catalog-link fix) or a LIVE v2 issue? NO writes.
import fs from "fs";

const env = fs.readFileSync("c:/GIT/Tools-Website-FT/apps/web/.env.local", "utf8");
const tok = env.match(/^SQUARE_ACCESS_TOKEN=(.+)$/m)![1].trim().replace(/^["']|["']$/g, "");
const BASE = "https://connect.squareup.com/v2";
const H = { Authorization: `Bearer ${tok}`, "Content-Type": "application/json", "Square-Version": "2024-12-18" };

// Sample IDs per group (all POV; a spread of the big ones; all of the small ones).
const GROUPS: Record<string, string[]> = {
  "POV Race Video": [
    "1uQWfWwIwnA9Sr32nVGi6JowetSZY", "FAHlGc5CvReRl8noFCtPGuczvBEZY", "vFxgPKhKTcwgiIWBi40ZzTqsmfAZY",
    "Ptb98xk2zvjJlJFXipDqyG3ymSZZY", "lqGSqVFSSrnOQWs2pvhy1shEnFJZY",
  ],
  "Intermediate Race": [
    "Prs8xewTHUR34lxgnofeef4bkHMZY", "rdcdeq97sXwbR8IawRgKApYIC27YY", "xijUgm0Do6GEhFqNl1G0sS5tnZMZY",
  ],
  "Pro Race": ["1Ub2HlKSWGIdALGuCd9M1rWuXWIZY", "JeRtJx6odgDHuBP5D1VuH7vHHZBZY"],
  "Pro Race (League −20%)": ["DjtNjPSDs42MzlB7cPFQakIJxn5YY", "XFrw68WQNPs0Jfd3pqmvO1Wa0QAZY"],
  "Rookie Pack": ["3JtQYAk6TaHMgARWL67yfBSQilJZY"],
  "Starter Race": [
    "7LjRzYAQjKXEBehSvREY725RYzQZY", "hOD3eHN6pznLRWPBgmhoEgNIU9QZY", "d0nJ9Yx63xsAfBfskQA8bL224S7YY",
  ],
  "Ultimate Qualifier": ["rZQgwrAATUzfdikp51sz3SBwx4TZY", "LztEQ1HGtcsWs5Na73FEw7cZeCgZY"],
  "GF Race Blue Starter": ["TxcLjpixgYnraFkH7xpXa5iKnQeZY"],
};

const allIds = [...new Set(Object.values(GROUPS).flat())];

// batch-retrieve orders (need a location? no — batch retrieve works by id)
const out: Record<string, any> = {};
for (let i = 0; i < allIds.length; i += 100) {
  const batch = allIds.slice(i, i + 100);
  const r = await fetch(`${BASE}/orders/batch-retrieve`, {
    method: "POST", headers: H, body: JSON.stringify({ order_ids: batch }),
  });
  const b = await r.json();
  if (b.errors) console.error(JSON.stringify(b.errors));
  for (const o of b.orders || []) out[o.id] = o;
}

console.log("group | order | created_at | location | race/POV line -> catalog_object_id?\n");
for (const [grp, ids] of Object.entries(GROUPS)) {
  console.log(`### ${grp}`);
  for (const id of ids) {
    const o = out[id];
    if (!o) { console.log(`  ${id}  -> NOT FOUND`); continue; }
    const lines = (o.line_items || [])
      .map((li: any) => `"${li.name}"${li.catalog_object_id ? " [LINKED]" : " [AD-HOC]"}`)
      .join("; ");
    console.log(`  ${o.created_at?.slice(0, 10)}  loc=${o.location_id}  ${id}`);
    console.log(`      ${lines}`);
  }
  console.log("");
}
