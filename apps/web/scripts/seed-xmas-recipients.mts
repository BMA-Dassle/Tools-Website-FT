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
import type { XmasSegment, XmasRecipient } from "@/lib/xmas-blast";

const AUDIENCE_TTL = 60 * 60 * 24 * 30; // keep in sync with lib/xmas-blast.ts
const idxKey = (s: XmasSegment) => `xmasblast:idx:${s}`;
const recKey = (e: string) => `xmasblast:rec:${e.toLowerCase()}`;

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
const toSeed: XmasRecipient[] = [];
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
    toSeed.push({
      email,
      name: (row.name || "").trim(),
      phone: (row.phone || "").trim(),
      segment: seg,
    });
  }
}

// Pipelined write — batches thousands of ops into a handful of round-trips.
if (!DRY && toSeed.length) {
  const CHUNK = 400;
  for (let i = 0; i < toSeed.length; i += CHUNK) {
    const batch = toSeed.slice(i, i + CHUNK);
    const pipe = redis.pipeline();
    for (const r of batch) {
      pipe.sadd(idxKey(r.segment), r.email);
      pipe.set(recKey(r.email), JSON.stringify(r), "EX", AUDIENCE_TTL);
    }
    await pipe.exec();
    seeded += batch.length;
    console.log(`  seeded ${seeded}/${toSeed.length}`);
  }
  const pipe2 = redis.pipeline();
  pipe2.expire(idxKey("naples"), AUDIENCE_TTL);
  pipe2.expire(idxKey("fortmyers"), AUDIENCE_TTL);
  await pipe2.exec();
}

console.log(DRY ? "[DRY RUN — nothing written]" : "[SEEDED]");
console.log("Unique emails per segment:");
console.log(`  naples   : ${seen.naples.size} (with phone: ${withPhone.naples})`);
console.log(`  fortmyers: ${seen.fortmyers.size} (with phone: ${withPhone.fortmyers})`);
console.log(`Total unique: ${seen.naples.size + seen.fortmyers.size}`);
console.log(`Skipped (no segment / bad email): ${skipped}`);
if (!DRY) console.log(`Records written to Redis: ${seeded}`);

await redis.quit();
