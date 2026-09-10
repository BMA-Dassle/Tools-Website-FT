import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * THE 2026-09-10 FREEZE, REPLAYED AGAINST THE RECONCILIATION.
 *
 * Pandora's cache said mega was playing a 1:16 clip with its clock stuck at
 * 0:06 and `connected: true`; the Core said every zone was idle. The old
 * paBusy read the cache alone, so every control sat behind "PA busy · mega"
 * for an hour. These tests pin the three ways the truth read now gets past
 * that: suspicion, the sanity beat, and the distrust flag it leaves behind.
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
      store.delete(k);
      return 1;
    }),
  },
}));

const liveRead = vi.fn();
const statusRead = vi.fn();
vi.mock("./qsys.server", () => ({
  readQsysLive: (...args: unknown[]) => liveRead(...args),
  readQsysStatus: (...args: unknown[]) => statusRead(...args),
}));

import { readQsysTruth } from "./qsys-truth.server";

const idle = (zone: string) => ({
  zone,
  label: zone,
  wired: true,
  playing: false,
  state: "Idle",
  file: "",
  lastSource: "",
  timing: { source: "player", remainingText: "--:--", elapsedText: "--:--", durationText: "--:--" },
});
const playing = (zone: string, file: string) => ({
  ...idle(zone),
  playing: true,
  state: "Pre",
  file,
  timing: {
    source: "player",
    remaining: 69.6,
    remainingText: "1:10",
    elapsed: 6,
    elapsedText: "0:06",
    duration: 75.6,
    durationText: "1:16",
  },
});

const ALL_IDLE = [idle("red"), idle("blue"), idle("mega")];
const MEGA_STUCK = [idle("red"), idle("blue"), playing("mega", "Dual Track Pre-Message.mp3")];

beforeEach(() => {
  store.clear();
  liveRead.mockReset();
  statusRead.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("readQsysTruth", () => {
  it("takes a healthy cache at its word without asking the Core (after the first sanity beat)", async () => {
    // Spend the venue's sanity beat first, as a wall pulse would have.
    store.set("pit:audio:qsys:sanity", "1");
    liveRead.mockResolvedValue({
      connected: true,
      zones: ALL_IDLE,
      stateUpdatedAtMs: Date.now() - 3600_000,
    });
    const truth = await readQsysTruth({ fresh: true });
    expect(truth?.source).toBe("live");
    expect(truth?.suspicion).toBeNull();
    expect(statusRead).not.toHaveBeenCalled();
  });

  it("sees through the frozen cache: mega 'playing' with a 46-minute-old frame → the Core's idle picture wins", async () => {
    store.set("pit:audio:qsys:sanity", "1");
    liveRead.mockResolvedValue({
      connected: true,
      zones: MEGA_STUCK,
      stateUpdatedAtMs: Date.now() - 46 * 60_000,
    });
    statusRead.mockResolvedValue({
      connected: true,
      zones: ALL_IDLE,
      stateUpdatedAtMs: Date.now(),
    });

    const truth = await readQsysTruth({ fresh: true });
    expect(truth?.source).toBe("status");
    expect(truth?.zones.find((z) => z.zone === "mega")?.playing).toBe(false);
    expect(truth?.suspicion).toMatch(/mega reports playing/);
    // ...and leaves the distrust flag so the next read skips the cache entirely.
    expect(store.get("pit:audio:qsys:distrust")).toMatch(/mega: cache says playing/);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("disagrees with the Core"));
  });

  it("keeps trusting a playing zone whose frames are fresh — a real clip is not a freeze", async () => {
    store.set("pit:audio:qsys:sanity", "1");
    liveRead.mockResolvedValue({
      connected: true,
      zones: MEGA_STUCK,
      stateUpdatedAtMs: Date.now() - 200,
    });
    const truth = await readQsysTruth({ fresh: true });
    expect(truth?.source).toBe("live");
    expect(truth?.zones.find((z) => z.zone === "mega")?.playing).toBe(true);
    expect(statusRead).not.toHaveBeenCalled();
  });

  it("under distrust, reads the Core and never the cache", async () => {
    store.set("pit:audio:qsys:distrust", "earlier disagreement");
    statusRead.mockResolvedValue({
      connected: true,
      zones: ALL_IDLE,
      stateUpdatedAtMs: Date.now(),
    });
    const truth = await readQsysTruth({ fresh: true });
    expect(liveRead).not.toHaveBeenCalled();
    expect(truth?.source).toBe("status");
  });

  it("the sanity beat asks the Core even when the cache looks fine, and catches a cache stuck idle", async () => {
    // No sanity key in the store: this read wins the beat.
    liveRead.mockResolvedValue({
      connected: true,
      zones: ALL_IDLE,
      stateUpdatedAtMs: Date.now() - 60_000,
    });
    statusRead.mockResolvedValue({
      connected: true,
      zones: [playing("red", "Red Track Pre-Message.mp3"), idle("blue"), idle("mega")],
      stateUpdatedAtMs: Date.now(),
    });
    const truth = await readQsysTruth({ fresh: true });
    expect(statusRead).toHaveBeenCalledTimes(1);
    expect(truth?.source).toBe("status");
    expect(truth?.zones.find((z) => z.zone === "red")?.playing).toBe(true);
    expect(store.get("pit:audio:qsys:distrust")).toMatch(/red: cache says idle/);
  });

  it("a sanity beat that finds agreement sets no distrust", async () => {
    liveRead.mockResolvedValue({
      connected: true,
      zones: ALL_IDLE,
      stateUpdatedAtMs: Date.now() - 60_000,
    });
    statusRead.mockResolvedValue({
      connected: true,
      zones: ALL_IDLE,
      stateUpdatedAtMs: Date.now(),
    });
    const truth = await readQsysTruth({ fresh: true });
    expect(truth?.source).toBe("status");
    expect(truth?.suspicion).toBeNull();
    expect(store.has("pit:audio:qsys:distrust")).toBe(false);
  });

  it("falls back to the suspect cache when the Core cannot be read — fail open, not blind", async () => {
    store.set("pit:audio:qsys:sanity", "1");
    liveRead.mockResolvedValue({ connected: false, zones: ALL_IDLE, stateUpdatedAtMs: Date.now() });
    statusRead.mockResolvedValue(null);
    const truth = await readQsysTruth({ fresh: true });
    expect(truth?.source).toBe("live");
    expect(truth?.suspicion).toMatch(/link to the Core is down/);
  });

  it("returns null when neither source answers", async () => {
    store.set("pit:audio:qsys:sanity", "1");
    liveRead.mockResolvedValue(null);
    statusRead.mockResolvedValue(null);
    expect(await readQsysTruth({ fresh: true })).toBeNull();
  });

  it("memoises for the pollers, and `fresh` bypasses the memo for a press", async () => {
    store.set("pit:audio:qsys:sanity", "1");
    liveRead.mockResolvedValue({ connected: true, zones: ALL_IDLE, stateUpdatedAtMs: Date.now() });
    await readQsysTruth();
    await readQsysTruth();
    expect(liveRead).toHaveBeenCalledTimes(1);
    expect(store.has("pit:audio:qsys:truth")).toBe(true);
    await readQsysTruth({ fresh: true });
    expect(liveRead).toHaveBeenCalledTimes(2);
  });
});
