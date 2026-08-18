import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { waiverVariantForAge } from "~/features/kiosk/waiver/templates";

/**
 * What this lookup costs is the whole point: /api/kiosk/waiver/template was 21 ×
 * 500 in the hour Pandora degraded on 2026-08-18, every one of them spent
 * re-fetching a contentID we already knew. The tests below pin the three things
 * that make caching it safe rather than clever:
 *
 *   1. the KEY matches BMI's real banding (two templates per center, split at 18,
 *      measured by probe) — key it per exact age and a 40-year-old lands on a cold
 *      key during the outage the cache exists for;
 *   2. a failed lookup serves the retained contentID, because signing against a
 *      slightly old template beats not signing;
 *   3. retries happen only when there is nothing to fall back on. Piling retries
 *      onto a degrading vendor is what deepened the 2026-08-14 incident.
 */

const store = new Map<string, string>();
const redisMock = {
  get: vi.fn(async (key: string) => store.get(key) ?? null),
  set: vi.fn(async (key: string, value: string) => {
    store.set(key, value);
    return "OK";
  }),
};
vi.mock("@/lib/redis", () => ({ default: redisMock }));

const { resolveWaiverTemplate, waiverBandForAge, waiverTemplateCacheLabel } =
  await import("./template-cache");

const FT = "LAB52GY480CJF";
const NAPLES = "PPTR5G2N0QXF7";
const key = (loc: string, band: string) => `pandora:waiver-template:v1:${loc}:${band}`;

/** Pandora's real wrapper shape, with the ids the probe actually returned. */
const body = (contentID: string, name: string, id = "95845") =>
  JSON.stringify({ success: true, data: { id, contentID, name, duration: 1, body: "<p>BMI</p>" } });

function seed(loc: string, band: string, contentID: string, ageMs: number) {
  store.set(
    key(loc, band),
    JSON.stringify({
      template: { id: "95845", contentID, name: band, duration: 1, body: "<p>BMI</p>" },
      cachedAt: Date.now() - ageMs,
    }),
  );
}

beforeEach(() => {
  store.clear();
  redisMock.get.mockClear();
  redisMock.set.mockClear();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("waiverBandForAge — BMI's banding, which we now depend on", () => {
  it("splits at 18, as every center did when probed", () => {
    expect(waiverBandForAge(5)).toBe("minor");
    expect(waiverBandForAge(17)).toBe("minor");
    expect(waiverBandForAge(18)).toBe("adult");
    expect(waiverBandForAge(40)).toBe("adult");
  });

  it("agrees with the template gate the kiosk renders bodies from", () => {
    // If these ever diverge, a guest gets our minor body with BMI's adult
    // contentID (or the reverse) — the two must move together.
    for (const age of [0, 5, 12, 17, 18, 25, 40, 99]) {
      expect(waiverBandForAge(age)).toBe(waiverVariantForAge(age));
    }
  });
});

describe("resolveWaiverTemplate — the key", () => {
  it("serves every minor age from ONE cached copy", async () => {
    const fetcher = vi.fn(async () => ({ status: 200, body: body("20241498", "Minor", "95841") }));

    const first = await resolveWaiverTemplate({ locationID: FT, age: 5, fetcher });
    const second = await resolveWaiverTemplate({ locationID: FT, age: 17, fetcher });

    expect(fetcher).toHaveBeenCalledOnce(); // age 17 rode age 5's copy
    expect(first.ok && first.source).toBe("fresh");
    expect(second.ok && second.source).toBe("cache");
    expect(second.ok && second.template.contentID).toBe("20241498");
  });

  it("keeps adult and minor apart", async () => {
    seed(FT, "minor", "20241498", 60_000);
    const fetcher = vi.fn(async () => ({ status: 200, body: body("19065376", "Adult") }));

    const adult = await resolveWaiverTemplate({ locationID: FT, age: 25, fetcher });

    expect(fetcher).toHaveBeenCalledOnce();
    expect(adult.ok && adult.template.contentID).toBe("19065376");
  });

  it("keeps centers apart — Naples cannot read Fort Myers' copy", async () => {
    seed(FT, "adult", "19065376", 60_000);
    const fetcher = vi.fn(async () => ({ status: 200, body: body("5958737", "Adult", "39996") }));

    const naples = await resolveWaiverTemplate({ locationID: NAPLES, age: 25, fetcher });

    expect(fetcher).toHaveBeenCalledOnce();
    expect(naples.ok && naples.template.contentID).toBe("5958737");
  });
});

describe("resolveWaiverTemplate — freshness", () => {
  it("re-reads once the copy is older than an hour", async () => {
    seed(FT, "adult", "19065376", 61 * 60_000);
    const fetcher = vi.fn(async () => ({ status: 200, body: body("19065999", "Adult") }));

    const r = await resolveWaiverTemplate({ locationID: FT, age: 25, fetcher });

    expect(fetcher).toHaveBeenCalledOnce();
    expect(r.ok && r.template.contentID).toBe("19065999"); // a real revision lands
  });

  it("forceFresh bypasses a copy that is still inside the hour", async () => {
    seed(FT, "adult", "19065376", 60_000);
    const fetcher = vi.fn(async () => ({ status: 200, body: body("19065376", "Adult") }));

    const r = await resolveWaiverTemplate({ locationID: FT, age: 25, forceFresh: true, fetcher });

    expect(fetcher).toHaveBeenCalledOnce();
    expect(r.ok && r.source).toBe("fresh");
  });
});

describe("resolveWaiverTemplate — the outage path", () => {
  it("serves the retained contentID when Pandora 500s, and says so", async () => {
    seed(FT, "adult", "19065376", 20 * 24 * 60 * 60_000); // 20 days old
    const fetcher = vi.fn(async () => ({ status: 500, body: "Server Error" }));

    const r = await resolveWaiverTemplate({ locationID: FT, age: 25, fetcher });

    expect(r.ok).toBe(true);
    expect(r.ok && r.source).toBe("stale");
    expect(r.ok && r.staleReason).toBe("pandora-500");
    expect(r.ok && r.template.contentID).toBe("19065376");
    expect(r.ok && waiverTemplateCacheLabel(r)).toContain("STALE-pandora-500");
  });

  it("serves the retained contentID when the lookup times out", async () => {
    seed(NAPLES, "minor", "5958734", 90 * 60_000);
    const fetcher = vi.fn(async () => {
      throw new Error("The operation was aborted due to timeout");
    });

    const r = await resolveWaiverTemplate({ locationID: NAPLES, age: 8, fetcher });

    expect(r.ok && r.source).toBe("stale");
    expect(r.ok && r.template.contentID).toBe("5958734");
  });

  it("tries ONCE when a copy exists — no retry storm on a degrading vendor", async () => {
    seed(FT, "adult", "19065376", 2 * 60 * 60_000);
    const fetcher = vi.fn(async () => ({ status: 503, body: "down" }));

    await resolveWaiverTemplate({ locationID: FT, age: 25, fetcher });

    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("retries on a COLD key, where a flaky answer is the difference between a signature and nothing", async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValueOnce({ status: 502, body: "bad gateway" })
      .mockResolvedValueOnce({ status: 200, body: body("19065376", "Adult") });

    const r = await resolveWaiverTemplate({ locationID: FT, age: 25, fetcher });

    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(r.ok && r.template.contentID).toBe("19065376");
  });

  it("does not retry a 4xx — that is a real answer about a real request", async () => {
    const fetcher = vi.fn(async () => ({ status: 404, body: "no such location" }));

    const r = await resolveWaiverTemplate({ locationID: FT, age: 25, fetcher });

    expect(fetcher).toHaveBeenCalledOnce();
    expect(r.ok).toBe(false);
    expect(!r.ok && r.status).toBe(404);
  });

  it("fails, rather than caching, a 200 with no contentID — it cannot be signed against", async () => {
    const fetcher = vi.fn(async () => ({ status: 200, body: JSON.stringify({ data: {} }) }));

    const r = await resolveWaiverTemplate({ locationID: FT, age: 25, fetcher });

    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe("no-contentid");
    expect(store.has(key(FT, "adult"))).toBe(false);
  });

  it("reports the failure when there is nothing retained to serve", async () => {
    const fetcher = vi.fn(async () => ({ status: 503, body: "down" }));

    const r = await resolveWaiverTemplate({ locationID: FT, age: 25, fetcher });

    expect(r.ok).toBe(false);
    expect(!r.ok && r.status).toBe(503);
    expect(!r.ok && r.reason).toBe("pandora-503");
  });

  it("survives a Redis read that throws — the live lookup still answers", async () => {
    redisMock.get.mockRejectedValueOnce(new Error("redis down"));
    const fetcher = vi.fn(async () => ({ status: 200, body: body("19065376", "Adult") }));

    const r = await resolveWaiverTemplate({ locationID: FT, age: 25, fetcher });

    expect(r.ok && r.source).toBe("fresh");
  });
});
