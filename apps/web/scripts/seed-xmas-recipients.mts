/**
 * Seed the Christmas in July blast audience into Redis from the gitignored
 * scripts/.data/xmas-recipients.json (produced from the 2025 group-events xlsx).
 *
 * Usage (from apps/web):
 *   npx tsx scripts/seed-xmas-recipients.mts --dry-run   # counts only, writes nothing
 *   npx tsx scripts/seed-xmas-recipients.mts             # seed Redis (30-day TTL)
 *
 * Dedups by lowercased email within each segment (Redis SADD). The one-shot
 * cron (app/api/cron/xmas-blast) then reads this audience to send.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const DRY = process.argv.includes("--dry-run");
const DATA = resolve(process.cwd(), "scripts/.data/xmas-recipients.json");

const redis = (await import("@/lib/redis")).default;
const { seedRecipient } = await import("@/lib/xmas-blast");
import type { XmasSegment, XmasRecipient } from "@/lib/xmas-blast";

interface Row {
  segment: string;
  email: string;
  name: string;
  company: string;
  phone: string;
}

const rows = JSON.parse(readFileSync(DATA, "utf8")) as Row[];

const seen: Record<XmasSegment, Set<string>> = { naples: new Set(), fortmyers: new Set() };
const withPhone: Record<XmasSegment, number> = { naples: 0, fortmyers: 0 };
let skipped = 0;
let seeded = 0;

for (const row of rows) {
  // Trust the precomputed segment, but re-validate against Location semantics.
  const seg = (row.segment === "naples" || row.segment === "fortmyers"
    ? row.segment
    : null) as XmasSegment | null;
  const email = (row.email || "").trim().toLowerCase();
  if (!seg || !email.includes("@")) {
    skipped++;
    continue;
  }
  if (seen[seg].has(email)) continue; // dedup — first row wins
  seen[seg].add(email);
  if (row.phone && row.phone.trim()) withPhone[seg]++;

  if (!DRY) {
    const rec: XmasRecipient = {
      email,
      name: (row.name || "").trim(),
      phone: (row.phone || "").trim(),
      segment: seg,
    };
    await seedRecipient(rec);
    seeded++;
  }
}

console.log(DRY ? "[DRY RUN — nothing written]" : "[SEEDED]");
console.log("Unique emails per segment:");
console.log(`  naples   : ${seen.naples.size} (with phone: ${withPhone.naples})`);
console.log(`  fortmyers: ${seen.fortmyers.size} (with phone: ${withPhone.fortmyers})`);
console.log(`Total unique: ${seen.naples.size + seen.fortmyers.size}`);
console.log(`Skipped (no segment / bad email): ${skipped}`);
if (!DRY) console.log(`Records written to Redis: ${seeded}`);

await redis.quit();
