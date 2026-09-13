import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `share-link-expire` is the kind C6 fills in `jobs/registry.ts`. It must:
 *   report what it did       a director's "Run job" answer of `{}` teaches
 *                            nobody anything;
 *   be safe to run twice     previews have no crons, so it is run by hand, and
 *                            a second run in the same minute must be a no-op
 *                            rather than a second stamp;
 *   key per ET calendar day  so the cron's future `enqueueScheduled` step can
 *                            enqueue it with ON CONFLICT DO NOTHING and get
 *                            exactly one run a day.
 */

const expire = vi.hoisted(() => ({ calls: [] as Date[], returns: 0 }));
vi.mock("./share", () => ({
  expireShareLinks: async (now: Date) => {
    expire.calls.push(now);
    return expire.returns;
  },
}));

const { shareLinkExpireHandler, shareLinkExpireIdempotencyKey } = await import("./jobs");

const NOW = new Date("2026-09-13T18:00:00.000Z");

function ctx(now = NOW) {
  return {
    job: {
      id: "1",
      kind: "share-link-expire" as const,
      idempotencyKey: shareLinkExpireIdempotencyKey(now),
      payload: {},
      status: "running" as const,
      attempts: 1,
      maxAttempts: 20,
      nextAttemptAt: now.toISOString(),
      leasedUntil: null,
      lastError: null,
      result: null,
      createdBy: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      resolvedAt: null,
    },
    payload: {},
    actorEmail: "jacob@headpinz.com",
    now,
  };
}

beforeEach(() => {
  expire.calls = [];
  expire.returns = 0;
});

describe("shareLinkExpireHandler", () => {
  it("stamps the due links and says how many", async () => {
    expire.returns = 3;
    const out = await shareLinkExpireHandler(ctx());

    expect(out).toEqual({ ok: true, result: { expired: 3, ranAt: NOW.toISOString() } });
    expect(expire.calls).toEqual([NOW]);
  });

  it("is a no-op the second time, and still reports success", async () => {
    expire.returns = 0;
    const out = await shareLinkExpireHandler(ctx());
    expect(out).toEqual({ ok: true, result: { expired: 0, ranAt: NOW.toISOString() } });
  });
});

describe("shareLinkExpireIdempotencyKey", () => {
  it("is one key per ET calendar day", () => {
    expect(shareLinkExpireIdempotencyKey(NOW)).toBe("share-link-expire:2026-09-13");
    // 01:00 UTC on the 14th is still the 13th in ET — the boundary that dropped
    // 18 of 20 rows in the RAINYDAY report.
    expect(shareLinkExpireIdempotencyKey(new Date("2026-09-14T01:00:00.000Z"))).toBe(
      "share-link-expire:2026-09-13",
    );
    expect(shareLinkExpireIdempotencyKey(new Date("2026-09-14T05:00:00.000Z"))).toBe(
      "share-link-expire:2026-09-14",
    );
  });
});
