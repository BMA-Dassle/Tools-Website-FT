/** Peek at the cached kiosk availability payload the kiosks are actually served. */
import fs from "node:fs";
import path from "node:path";
import Redis from "ioredis";

const envPath = path.resolve(import.meta.dirname, "../.env.local");
for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const redis = new Redis(process.env.REDIS_URL!, { tls: process.env.REDIS_URL!.startsWith("rediss") ? {} : undefined });
for (const center of ["fort-myers", "naples"]) {
  for (const key of [`kiosk:avail:v3:${center}`, `kiosk:avail:last:v1:${center}`]) {
    const [val, ttl] = await Promise.all([redis.get(key), redis.ttl(key)]);
    console.log(`\n=== ${key} (ttl ${ttl}s)`);
    console.log(val ?? "(no cache entry)");
  }
}
redis.disconnect();
