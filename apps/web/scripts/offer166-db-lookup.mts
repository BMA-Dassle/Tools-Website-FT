/** Read-only: which bowling experience maps to QAMF web offer 166 at FM? */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { neon } from "@neondatabase/serverless";

const APP_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const raw = readFileSync(resolve(APP_ROOT, ".env.local"), "utf8");
for (const line of raw.split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const sql = neon(process.env.DATABASE_URL!);

const offers = await sql`
  SELECT eo.center_code, eo.qamf_web_offer_id, eo.qamf_option_type, eo.qamf_option_id,
         eo.is_active AS offer_active, e.slug, e.kind, e.is_vip, e.days_of_week, e.is_active AS exp_active
  FROM bowling_experience_offers eo
  JOIN bowling_experiences e ON e.id = eo.experience_id
  WHERE eo.qamf_web_offer_id = 166
`;
console.log("bowling_experience_offers rows for offer 166:");
console.log(JSON.stringify(offers, null, 2));

const durations = await sql`
  SELECT d.center_code, e.slug, d.qamf_option_id, d.duration_minutes, d.label, d.square_multiplier
  FROM bowling_experience_duration_options d
  JOIN bowling_experiences e ON e.id = d.experience_id
  WHERE e.id IN (
    SELECT experience_id FROM bowling_experience_offers WHERE qamf_web_offer_id = 166
  )
  ORDER BY d.center_code, d.sort_order
`;
console.log("\nduration options for those experiences:");
console.log(JSON.stringify(durations, null, 2));
