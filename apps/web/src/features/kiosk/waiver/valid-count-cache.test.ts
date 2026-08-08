import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

/**
 * NEVER CACHE AN UNREADABLE RECORD.
 *
 * A BMI person with a null birthdate makes Pandora's GET /bmi/person return 500
 * "Response Validator Error" (proven live 2026-08-07). This reader used to
 * cache that outcome as "0" for the full TTL — so the racer stayed pinned to
 * "no waiver" even AFTER the birthday was written and the record started
 * reading cleanly. The repair would appear not to work, for reasons invisible
 * on the screen.
 *
 * The answer is still `false` (fail closed — never let an unverified racer onto
 * a kart). What must not happen is that the false gets remembered.
 */

const store = new Map<string, string>();
const setex = vi.fn(async (k: string, _ttl: number, v: string) => {
  store.set(k, v);
  return "OK";
});
vi.mock("@/lib/redis", () => ({
  default: {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    setex: (...a: [string, number, string]) => setex(...a),
  },
}));

const { waiverValidNow } = await import("./valid-count");

const ok = (waiverExpiry: string | null) => ({
  ok: true,
  status: 200,
  json: async () => ({ success: true, data: { waiverExpiry } }),
});
const err500 = {
  ok: false,
  status: 500,
  json: async () => ({ success: false, error: "Response Validator Error" }),
};

beforeEach(() => {
  store.clear();
  setex.mockClear();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("waiverValidNow — cache behaviour", () => {
  it("does NOT cache the null-birthdate 500", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => err500),
    );
    await expect(waiverValidNow("63000000007642347", "LAB52GY480CJF")).resolves.toBe(false);
    expect(setex).not.toHaveBeenCalled();
  });

  it("re-asks after a 500, so a repaired record is seen immediately", async () => {
    // The whole point: 500 first, then the birthday is written and it reads.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(err500)
      .mockResolvedValueOnce(ok("2027-08-08T13:00:00.000Z"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(waiverValidNow("63000000007642347", "LAB52GY480CJF")).resolves.toBe(false);
    await expect(waiverValidNow("63000000007642347", "LAB52GY480CJF")).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("DOES cache a clean read — both true and a genuine false", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ok("2027-08-08T13:00:00.000Z")),
    );
    await expect(waiverValidNow("58096162", "LAB52GY480CJF")).resolves.toBe(true);
    expect(setex).toHaveBeenCalledTimes(1);

    setex.mockClear();
    store.clear();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ok(null)),
    );
    await expect(waiverValidNow("58091668", "LAB52GY480CJF")).resolves.toBe(false);
    // A real "no waiver" is worth caching; an unreadable record is not.
    expect(setex).toHaveBeenCalledTimes(1);
  });

  it("does not cache a network failure either", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("timeout");
      }),
    );
    await expect(waiverValidNow("58096162", "LAB52GY480CJF")).resolves.toBe(false);
    expect(setex).not.toHaveBeenCalled();
  });
});
