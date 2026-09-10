import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * THE HANDSHAKE, with an in-memory Redis and real (short) clocks: who leads,
 * who follows, what a joiner is told, and what happens when nobody comes.
 * The rule itself is cue-sync.ts; audio.server.ts is the one caller.
 */

const store = new Map<string, string>();

vi.mock("@/lib/redis", () => ({
  default: {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    set: vi.fn(async (k: string, v: string, ...rest: (string | number)[]) => {
      if (rest.includes("NX") && store.has(k)) return null;
      store.set(k, v);
      return "OK";
    }),
    del: vi.fn(async (k: string) => {
      const had = store.delete(k);
      return had ? 1 : 0;
    }),
  },
}));

import {
  announceSyncIntent,
  claimSyncLead,
  clearSyncIntents,
  publishSyncResult,
  releaseSyncLead,
  waitForSyncIntent,
  waitForSyncResult,
} from "./cue-sync.server";

const POLL = 5;

beforeEach(() => store.clear());

describe("claimSyncLead", () => {
  it("the first press leads; the second follows and is told who leads", async () => {
    expect(await claimSyncLead("pre", "red")).toEqual({ role: "lead" });
    expect(await claimSyncLead("pre", "blue")).toEqual({ role: "follow", leader: "red" });
  });

  it("a pre lead does not block a post lead — keys are per cue", async () => {
    expect(await claimSyncLead("pre", "red")).toEqual({ role: "lead" });
    expect(await claimSyncLead("post", "blue")).toEqual({ role: "lead" });
  });

  it("the same button pressed twice follows its own earlier press", async () => {
    await claimSyncLead("post", "blue");
    expect(await claimSyncLead("post", "blue")).toEqual({ role: "follow", leader: "blue" });
  });

  it("releasing the lead hands the window to the next press", async () => {
    await claimSyncLead("pre", "red");
    await releaseSyncLead("pre");
    expect(await claimSyncLead("pre", "blue")).toEqual({ role: "lead" });
  });
});

describe("waitForSyncIntent", () => {
  it("returns the partner's session the moment their intent lands", async () => {
    const waiting = waitForSyncIntent("pre", "blue", 500, POLL);
    setTimeout(() => void announceSyncIntent("pre", "blue", "58571820"), 20);
    expect(await waiting).toEqual({ sessionId: "58571820" });
  });

  it("gives up at the window with nobody, and does not overrun it by much", async () => {
    const started = Date.now();
    expect(await waitForSyncIntent("pre", "blue", 60, POLL)).toBeNull();
    expect(Date.now() - started).toBeGreaterThanOrEqual(55);
    expect(Date.now() - started).toBeLessThan(250);
  });

  it("does not mistake the other cue's intent for this one", async () => {
    await announceSyncIntent("post", "blue", "1");
    expect(await waitForSyncIntent("pre", "blue", 30, POLL)).toBeNull();
  });

  it("cleared intents are gone", async () => {
    await announceSyncIntent("pre", "blue", "1");
    await announceSyncIntent("pre", "red", "2");
    await clearSyncIntents("pre", ["blue", "red"]);
    expect(await waitForSyncIntent("pre", "blue", 20, POLL)).toBeNull();
    expect(await waitForSyncIntent("pre", "red", 20, POLL)).toBeNull();
  });
});

describe("waitForSyncResult", () => {
  it("hands the joiner the leader's outcome for ITS session, then consumes it", async () => {
    const waiting = waitForSyncResult("post", "blue", "777", 500, POLL);
    setTimeout(
      () =>
        void publishSyncResult("post", "blue", {
          ok: true,
          atMs: 1_000,
          sessionId: "777",
          synced: true,
          zone: "mega",
        }),
      20,
    );
    expect(await waiting).toMatchObject({ ok: true, synced: true, zone: "mega", sessionId: "777" });
    expect(store.has("pit:audio:sync:post:result:blue")).toBe(false);
  });

  it("ignores a stale result naming an earlier cycle's session", async () => {
    await publishSyncResult("pre", "red", { ok: true, sessionId: "OLD", atMs: 1 });
    expect(await waitForSyncResult("pre", "red", "NEW", 40, POLL)).toBeNull();
    // ...and leaves it alone for its TTL rather than eating somebody else's receipt.
    expect(store.has("pit:audio:sync:pre:result:red")).toBe(true);
  });

  it("relays a failure as faithfully as a success", async () => {
    await publishSyncResult("pre", "red", { ok: false, error: "the PA is busy", sessionId: "9" });
    expect(await waitForSyncResult("pre", "red", "9", 40, POLL)).toEqual({
      ok: false,
      error: "the PA is busy",
      sessionId: "9",
    });
  });

  it("gives up when the leader never publishes — the joiner then plays solo", async () => {
    expect(await waitForSyncResult("pre", "red", "9", 40, POLL)).toBeNull();
  });
});
