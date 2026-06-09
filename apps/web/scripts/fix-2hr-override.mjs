/**
 * One-time fix: wire each 2-hour bowling duration option to its center's
 * matching 1-hour Square product via override_square_product_id.
 *
 * Without the override, the 2-hour option falls back to the 1.5-hour base
 * product × multiplier(2) = wrong (e.g. Mon-Thu $45 × 2 = $90). With it, the
 * 2-hour books the 1-hour product × 2 (Mon-Thu $30 × 2 = $60), matching the
 * intended model (bowling-db.ts:182-187). Display + charge both follow the
 * override product, so this fixes both.
 *
 * Usage: node scripts/fix-2hr-override.mjs   (reads DATABASE_URL from .env.local)
 */
import { neon } from "@neondatabase/serverless";
import { readFileSync } from "fs";
import { resolve } from "path";

try {
  const raw = readFileSync(resolve(process.cwd(), ".env.local"), "utf8");
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim();
    if (!(k in process.env)) process.env[k] = v;
  }
} catch {
  /* rely on already-set env */
}

let dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}
// Strip surrounding quotes + the channel_binding param the HTTP driver rejects.
dbUrl = dbUrl.trim().replace(/^["']|["']$/g, "");
dbUrl = dbUrl
  .replace(/\?channel_binding=require&/, "?")
  .replace(/[?&]channel_binding=require\b/, "");
const sql = neon(dbUrl);

// experience slug → its center-agnostic 1-hour Square catalog object id
const MAP = {
  "regular-mon-thur": "C2I2FUTKZODAXBL4N7NB4OZG", // 1 Hr Mon-Thur      $30
  "vip-mon-thur": "PI67DZQJVGR5EIXEWLB2ELOJ", // 1 Hr Mon-Thur VIP  $45
  "regular-fri-sun": "QA2R6YZ3D64X63NGQ46LYZRV", // 1 Hr Fri-Sun       $40
  "vip-fri-sun": "OSOZ7RJ6WW7G4CEFL55U7LXF", // 1 Hr Fri-Sun VIP   $55
};

const before = await sql`
  SELECT e.slug, d.center_code, d.square_multiplier, d.override_square_product_id
  FROM bowling_experience_duration_options d
  JOIN bowling_experiences e ON e.id = d.experience_id
  WHERE d.duration_minutes = 120
  ORDER BY e.slug, d.center_code`;
console.log("=== BEFORE — 2-hour options ===");
for (const r of before)
  console.log(
    `  ${r.slug} | ${r.center_code} | x${r.square_multiplier} | override=${r.override_square_product_id ?? "null"}`,
  );

console.log("\n=== APPLYING ===");
let total = 0;
for (const [slug, catId] of Object.entries(MAP)) {
  const rows = await sql`
    UPDATE bowling_experience_duration_options d
    SET override_square_product_id = p.id
    FROM bowling_experiences e, bowling_square_products p
    WHERE d.experience_id = e.id
      AND e.slug = ${slug}
      AND d.duration_minutes = 120
      AND p.center_code = d.center_code
      AND p.square_catalog_object_id = ${catId}
    RETURNING d.center_code, p.price_cents, (p.price_cents * d.square_multiplier) AS two_hr_cents`;
  for (const r of rows) {
    total++;
    console.log(
      `  ${slug} | ${r.center_code} | 1hr=$${(r.price_cents / 100).toFixed(2)} → 2hr=$${(r.two_hr_cents / 100).toFixed(2)}`,
    );
  }
}
console.log(`\nUpdated ${total} row(s).`);
