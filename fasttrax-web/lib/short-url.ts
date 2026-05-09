import { randomBytes } from "crypto";
import redis from "@/lib/redis";

const SHORT_TTL = 90 * 24 * 60 * 60; // 90 days — matches /api/s

/**
 * Shorten a destination URL (or path) and return the 6-char code.
 * Writes to the same `short:{code}` Redis key-space as /api/s so
 * the existing /s/[code] redirect page resolves it.
 *
 * @param url  Absolute URL or root-relative path to store.
 *             Example: "/hp/book/open-bowling/confirmation?neonId=42"
 * @returns    6-char base64url code — navigate the browser to /s/{code}
 */
export async function shortenUrl(url: string): Promise<string> {
  const code = randomBytes(4).toString("base64url").slice(0, 6);
  await redis.set(`short:${code}`, url, "EX", SHORT_TTL);
  return code;
}
