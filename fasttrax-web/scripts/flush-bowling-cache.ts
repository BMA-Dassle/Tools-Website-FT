/**
 * Flush all bowling availability cache keys from Redis.
 * Run this after fixing the deduplication bug so stale VIP-stripped
 * results don't linger for the remaining 5-min TTL.
 *
 * Usage: npx tsx scripts/flush-bowling-cache.ts
 */

import { readFileSync } from "fs";
import { resolve } from "path";

try {
  const envPath = resolve(process.cwd(), ".env.local");
  const raw = readFileSync(envPath, "utf8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = val;
  }
} catch { /* rely on env */ }

const REDIS_URL = process.env.REDIS_URL ?? process.env.KV_URL;
if (!REDIS_URL) { console.error("REDIS_URL / KV_URL not set"); process.exit(1); }

// Use ioredis or the upstash REST API depending on what's available.
// We'll use the @upstash/redis REST SDK if the URL looks like upstash.
async function flush() {
  if (REDIS_URL!.startsWith("https://")) {
    // Upstash REST
    const token = process.env.REDIS_TOKEN ?? process.env.KV_REST_API_TOKEN ?? "";
    const scanRes = await fetch(`${REDIS_URL}/scan/0/match/bowling:avail:*`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const scanData = await scanRes.json() as { result: [string, string[]] };
    const keys: string[] = scanData.result?.[1] ?? [];
    if (keys.length === 0) {
      console.log("No bowling:avail:* keys found in cache.");
      return;
    }
    console.log(`Found ${keys.length} key(s) — deleting…`);
    for (const k of keys) {
      await fetch(`${REDIS_URL}/del/${encodeURIComponent(k)}`, {
        method: "GET",
        headers: { authorization: `Bearer ${token}` },
      });
      console.log(`  deleted: ${k}`);
    }
    console.log("Done.");
  } else {
    // ioredis
    const { default: Redis } = await import("ioredis");
    const client = new Redis(REDIS_URL!);
    const keys = await client.keys("bowling:avail:*");
    if (keys.length === 0) {
      console.log("No bowling:avail:* keys found.");
    } else {
      await client.del(...keys);
      console.log(`Deleted ${keys.length} key(s):`);
      keys.forEach((k) => console.log(`  ${k}`));
    }
    client.disconnect();
  }
}

flush().catch((err) => { console.error(err); process.exit(1); });
