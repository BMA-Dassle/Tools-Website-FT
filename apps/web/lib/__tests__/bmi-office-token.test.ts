import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * The rule this file exists to hold: ONE BMI OFFICE TOKEN PER TENANT, NOT ONE
 * PER CALL.
 *
 * Every /auth/token mints a distinct opaque grant that BMI holds for 24 hours
 * (measured 2026-08-25). The caches this module replaced were "a single slot
 * keyed by clientKey" — which looks like a cache and behaves like none, because
 * a loop over both centers evicts the other center's entry every iteration.
 * Five callers between them minted ~4,500 grants a day, all overlapping. Each
 * test below is named for the way that came back.
 */

const redisStore = new Map<string, string>();
const redisGet = vi.fn(async (k: string) => redisStore.get(k) ?? null);
const redisSetex = vi.fn(async (k: string, _ttl: number, v: string) => {
  redisStore.set(k, v);
  return "OK";
});
const redisDel = vi.fn(async (k: string) => (redisStore.delete(k) ? 1 : 0));

vi.mock("@/lib/redis", () => ({
  default: { get: redisGet, setex: redisSetex, del: redisDel },
}));

/** Every /auth/token response hands back a NEW opaque token, as BMI does. */
let minted = 0;
const httpsRequest = vi.fn();
vi.mock("https", () => ({
  default: {
    request: (_opts: unknown, cb: (res: unknown) => void) => {
      httpsRequest();
      const listeners: Record<string, (arg?: unknown) => void> = {};
      const res = {
        statusCode: 200,
        on: (ev: string, fn: (arg?: unknown) => void) => {
          listeners[ev] = fn;
          return res;
        },
      };
      // Defer so the caller can attach handlers first, like a real socket.
      setTimeout(() => {
        cb(res);
        minted += 1;
        listeners.data?.(JSON.stringify({ access_token: `tok-${minted}`, expires_in: "86399" }));
        listeners.end?.();
      }, 0);
      return {
        on: () => undefined,
        setTimeout: () => undefined,
        write: () => undefined,
        end: () => undefined,
        destroy: () => undefined,
      };
    },
  },
}));

let getOfficeToken: typeof import("../bmi-office-token").getOfficeToken;
let invalidateOfficeToken: typeof import("../bmi-office-token").invalidateOfficeToken;
let reset: typeof import("../bmi-office-token").__resetOfficeTokenCacheForTests;

beforeEach(async () => {
  process.env.BMI_OFFICE_USERNAME = "API2";
  process.env.BMI_OFFICE_PASSWORD = "pw";
  delete process.env.BMI_OFFICE_PASSWORD_B64;
  minted = 0;
  redisStore.clear();
  redisGet.mockClear();
  redisSetex.mockClear();
  httpsRequest.mockClear();
  const mod = await import("../bmi-office-token");
  getOfficeToken = mod.getOfficeToken;
  invalidateOfficeToken = mod.invalidateOfficeToken;
  reset = mod.__resetOfficeTokenCacheForTests;
  reset();
});

afterEach(() => reset?.());

describe("getOfficeToken", () => {
  it("does not re-auth when both centers are looped, the bug that made the old cache useless", async () => {
    // The exact shape of every caller: for (const center of CENTERS) { getToken(center) }.
    // The single-slot cache minted a grant on EVERY iteration of EVERY run.
    for (const ck of ["headpinzftmyers", "headpinznaples"]) await getOfficeToken(ck);
    for (const ck of ["headpinzftmyers", "headpinznaples"]) await getOfficeToken(ck);
    for (const ck of ["headpinzftmyers", "headpinznaples"]) await getOfficeToken(ck);
    expect(minted).toBe(2); // one per tenant, not one per iteration
  });

  it("keeps tenants apart — a Naples call never gets the Fort Myers grant", async () => {
    const fm = await getOfficeToken("headpinzftmyers");
    const naples = await getOfficeToken("headpinznaples");
    expect(fm).not.toBe(naples);
  });

  it("coalesces a burst so a cold start mints ONE grant, not one per caller", async () => {
    // A cold lambda with several concurrent Office calls is the normal case, and
    // without in-flight dedupe each one races to mint its own 24h grant.
    const together = await Promise.all(
      Array.from({ length: 8 }, () => getOfficeToken("headpinzftmyers")),
    );
    expect(minted).toBe(1);
    expect(new Set(together).size).toBe(1);
  });

  it("reuses the grant another instance already paid for, via Redis", async () => {
    await getOfficeToken("headpinzftmyers");
    expect(minted).toBe(1);
    // A fresh lambda: process memo empty, Redis warm.
    reset();
    const second = await getOfficeToken("headpinzftmyers");
    expect(minted).toBe(1); // no new grant
    expect(second).toBe("tok-1");
  });

  it("persists the grant with an expiry, so a reader inherits the real deadline", async () => {
    await getOfficeToken("headpinzftmyers");
    const raw = redisStore.get("bmi:office:token:headpinzftmyers");
    expect(raw).toBeTruthy();
    const grant = JSON.parse(raw!) as { token: string; expiresAtMs: number };
    expect(grant.token).toBe("tok-1");
    expect(grant.expiresAtMs).toBeGreaterThan(Date.now());
    // Held for an hour, not the full 24h the grant allows — a revoked shared
    // token must not wedge every cron for a day.
    expect(grant.expiresAtMs).toBeLessThanOrEqual(Date.now() + 3600_000 + 1000);
  });

  it("ignores a stale Redis entry rather than handing out a dead token", async () => {
    redisStore.set(
      "bmi:office:token:headpinzftmyers",
      JSON.stringify({ token: "expired", expiresAtMs: Date.now() - 1000 }),
    );
    const token = await getOfficeToken("headpinzftmyers");
    expect(token).not.toBe("expired");
    expect(minted).toBe(1);
  });

  it("survives a Redis outage by minting instead of failing BMI access entirely", async () => {
    redisGet.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    redisSetex.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const token = await getOfficeToken("headpinzftmyers");
    expect(token).toBe("tok-1");
  });

  it("mints again after invalidation, so a 401 can self-heal", async () => {
    const first = await getOfficeToken("headpinzftmyers");
    await invalidateOfficeToken("headpinzftmyers");
    const second = await getOfficeToken("headpinzftmyers");
    expect(second).not.toBe(first);
    expect(minted).toBe(2);
  });

  it("forceRefresh bypasses both caches", async () => {
    const first = await getOfficeToken("headpinzftmyers");
    const second = await getOfficeToken("headpinzftmyers", { forceRefresh: true });
    expect(second).not.toBe(first);
  });

  it("throws loudly on missing credentials instead of authing with an empty password", async () => {
    // The routes this replaced defaulted to `|| ""`, so a missing secret reached
    // BMI as a wrong-password attempt and read like a vendor fault.
    delete process.env.BMI_OFFICE_USERNAME;
    delete process.env.BMI_OFFICE_PASSWORD;
    reset();
    await expect(getOfficeToken("headpinzftmyers")).rejects.toThrow(/credentials missing/i);
  });
});
