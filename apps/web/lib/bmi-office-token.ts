import https from "https";
import redis from "@/lib/redis";

/**
 * ONE BMI Office token per tenant, shared across every caller and every lambda.
 *
 * WHY THIS EXISTS. `/auth/token` returns `expires_in: 86399` — a 24-hour grant —
 * the token is OPAQUE, and **every re-auth mints a different one**, so each is a
 * distinct grant BMI holds server-side for a full day (measured live 2026-08-25,
 * `scripts/bmi-office-token-lifetime.ts`). Before this module, five production
 * callers minted roughly 4,500 tokens a day between them and every one stayed
 * valid for 24h, so they all overlapped:
 *
 *   - lib/bmi-scan.ts            single-slot cache, evicted per center, per run
 *   - lib/bmi-office-actions.ts  single-slot cache, evicted per center, per run
 *   - cron/race-dayof-pay        NO cache — every call
 *   - cron/race-cancel-watch     NO cache — every call
 *   - cron/bmi-cancel-sweep      NO cache — every call
 *
 * The "single slot keyed by clientKey" shape was the trap: it looks like a cache
 * and behaves like none at all, because every loop over both centers evicts the
 * other center's entry. That is the load BMI Office reported as consuming their
 * server connections.
 *
 * WHY ONE HOUR AND NOT THE FULL 23. A shared, long-lived token is a shared
 * failure mode: if the grant is revoked — a password rotation, or BMI reaping
 * the very sessions we asked them to reap — every cron on it wedges until the
 * entry lapses. At 1 hour that self-heals in an hour with no retry plumbing, and
 * still costs only ~48 tokens a day across both centers, which is ~100x below
 * the level that caused the incident. Going to 23h would buy ~2/day instead of
 * ~48/day: indistinguishable to BMI, materially worse to operate.
 * (`~/features/daily-events/data/bmi-office.ts` predates this and caches 23h in
 * its own key; it is already one-token-per-tenant, so it is not part of the leak.)
 *
 * Redis is the shared floor and the in-process memo is the fast path. A Redis
 * outage degrades to per-instance caching — never to "no BMI access".
 */

const OFFICE_HOST = "office-api22.sms-timing.com";
const SMS_VERSION = "6251006 202511051229";

const cacheKey = (clientKey: string) => `bmi:office:token:${clientKey}`;

/** Deliberately short — see "WHY ONE HOUR" above. */
const TTL_SECONDS = 3600;

interface Grant {
  token: string;
  /** Absolute expiry, so a reader inherits the real deadline, not a guess. */
  expiresAtMs: number;
}

/** Per-instance fast path. Keyed by clientKey — NOT a single slot. */
const memo = new Map<string, Grant>();

/**
 * Coalesces concurrent misses. Without this a cold start with several in-flight
 * calls mints one token each, which is the bug this module exists to remove.
 */
const inflight = new Map<string, Promise<string>>();

function credentials(): { user: string; pass: string } {
  const user = process.env.BMI_OFFICE_USERNAME;
  const b64 = process.env.BMI_OFFICE_PASSWORD_B64;
  const pass = b64 ? Buffer.from(b64, "base64").toString() : process.env.BMI_OFFICE_PASSWORD;
  if (!user || !pass) {
    // Loud, not an empty-string auth attempt that reads as a vendor 400.
    throw new Error(
      "BMI Office credentials missing — set BMI_OFFICE_USERNAME and BMI_OFFICE_PASSWORD(_B64)",
    );
  }
  return { user, pass };
}

function postToken(clientKey: string, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: OFFICE_HOST,
        path: "/auth/token",
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          clientkey: clientKey,
          "x-fast-version": SMS_VERSION,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 500, body: data }));
      },
    );
    req.on("error", reject);
    req.setTimeout(20_000, () => {
      req.destroy();
      reject(new Error("Office auth timeout"));
    });
    req.write(body);
    req.end();
  });
}

async function mint(clientKey: string): Promise<Grant> {
  const { user, pass } = credentials();
  const res = await postToken(
    clientKey,
    `grant_type=password&username=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}`,
  );
  if (res.status !== 200) {
    throw new Error(`Office auth failed (${clientKey}): ${res.status} ${res.body.slice(0, 200)}`);
  }
  const data = JSON.parse(res.body) as { access_token?: string; expires_in?: string | number };
  if (!data.access_token) {
    throw new Error(`Office auth returned no access_token (${clientKey})`);
  }
  const grantedS = Number(data.expires_in) || TTL_SECONDS;
  // Never hold past the grant itself, even if BMI shortens expires_in one day.
  const liveForS = Math.max(Math.min(TTL_SECONDS, grantedS - 60), 60);
  console.log(`[bmi-office-token] minted ${clientKey} (held ${liveForS}s of ${grantedS}s granted)`);
  return { token: data.access_token, expiresAtMs: Date.now() + liveForS * 1000 };
}

/**
 * A valid Office bearer token for `clientKey`, reusing the fleet's current one
 * whenever there is one.
 *
 * @param forceRefresh mint a new grant even if a cached one looks live — for a
 *   caller that just saw a 401 and knows the cached token is dead.
 */
export async function getOfficeToken(
  clientKey: string,
  opts?: { forceRefresh?: boolean },
): Promise<string> {
  if (opts?.forceRefresh) await invalidateOfficeToken(clientKey);
  else {
    const hit = memo.get(clientKey);
    if (hit && Date.now() < hit.expiresAtMs) return hit.token;
  }

  const pending = inflight.get(clientKey);
  if (pending) return pending;

  const job = (async () => {
    if (!opts?.forceRefresh) {
      // Redis before minting — this is what makes a cold start reuse the token
      // some other lambda already paid for.
      try {
        const raw = await redis.get(cacheKey(clientKey));
        if (raw) {
          const grant = JSON.parse(raw) as Grant;
          if (grant.token && Date.now() < grant.expiresAtMs) {
            memo.set(clientKey, grant);
            return grant.token;
          }
        }
      } catch {
        // Redis unavailable or a malformed entry — mint instead of failing.
      }
    }

    const grant = await mint(clientKey);
    memo.set(clientKey, grant);
    try {
      const ttl = Math.max(1, Math.round((grant.expiresAtMs - Date.now()) / 1000));
      await redis.setex(cacheKey(clientKey), ttl, JSON.stringify(grant));
    } catch {
      // Non-fatal: this instance still has the memo, others mint their own.
    }
    return grant.token;
  })();

  inflight.set(clientKey, job);
  try {
    return await job;
  } finally {
    inflight.delete(clientKey);
  }
}

/** Drop the cached grant so the next call mints. Call this on a 401. */
export async function invalidateOfficeToken(clientKey: string): Promise<void> {
  memo.delete(clientKey);
  try {
    await redis.del(cacheKey(clientKey));
  } catch {
    // Non-fatal — the entry lapses on its own within the hour.
  }
}

/** Test seam: forget every cached grant in this process. */
export function __resetOfficeTokenCacheForTests(): void {
  memo.clear();
  inflight.clear();
}
