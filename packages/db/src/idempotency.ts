/**
 * Idempotency wrapper for endpoints that consume shared inventory.
 *
 * The rule (see tasks/lessons.md "Idempotency on resource-consuming
 * endpoints"): any endpoint that POPS items from a shared pool — POV
 * codes, lane holds, race-pack credits, Square Orders, BMI bills —
 * must dedup by the owning resource id BEFORE allocating new items.
 * Otherwise a customer's retry pops a SECOND set of items, silently
 * draining inventory and producing a customer-facing mismatch (BMI
 * memo says X codes, SMS says Y codes).
 *
 * `withIdempotency(redis, key, fn)`:
 * - Reads `key` from Redis. If a cached result exists, returns it
 *   (parsed from JSON) without invoking `fn`.
 * - Otherwise invokes `fn`, JSON-stringifies the result, writes it
 *   under `key` with a 90-day TTL (override via opts.ttlSeconds),
 *   and returns the result.
 * - Cache writes happen AFTER `fn` returns successfully. If `fn`
 *   throws, no cache is written and the next call retries `fn`
 *   normally (matches the v1 pov-codes pattern).
 *
 * Redis client is injected (structurally typed) so this package
 * doesn't pull in ioredis or @upstash/redis. Callers pass their
 * existing client — apps/web uses ioredis via `@/lib/redis`.
 *
 * Key shape convention: `<feature>:<op>:<owner-id>`, e.g.
 *   - `pov:claimed:person:63000000000021716`
 *   - `bowling:hold:square-order:abc123`
 *   - `bmi:book:session:s_xyz`
 */

export interface IdempotencyRedis {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: unknown[]): Promise<unknown>;
}

export interface IdempotencyOptions {
  /** TTL in seconds. Default: 90 days. */
  ttlSeconds?: number;
  /**
   * If true, cached results are returned with `{ cached: true }` merged in
   * (caller can detect the dedup and surface "already done" in the UI).
   * Requires the cached value to be a plain object. Default: false.
   */
  annotateCached?: boolean;
}

const DEFAULT_TTL_SECONDS = 90 * 24 * 60 * 60;

export async function withIdempotency<T>(
  redis: IdempotencyRedis,
  key: string,
  fn: () => Promise<T>,
  opts: IdempotencyOptions = {},
): Promise<T> {
  const cachedRaw = await redis.get(key);
  if (cachedRaw !== null) {
    const cached = JSON.parse(cachedRaw) as T;
    if (opts.annotateCached && cached && typeof cached === "object") {
      return { ...cached, cached: true } as T;
    }
    return cached;
  }

  const result = await fn();
  const ttl = opts.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  // ioredis: redis.set(key, value, "EX", ttl)
  // @upstash: redis.set(key, value, { ex: ttl })
  // We pass both shapes; ioredis ignores the second-form object,
  // @upstash ignores the trailing positional args. Either works.
  await redis.set(key, JSON.stringify(result), "EX", ttl, { ex: ttl });
  return result;
}
