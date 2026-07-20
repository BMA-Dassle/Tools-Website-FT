import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../data/transactions-log", () => ({
  claimQueuedJobs: vi.fn(async () => [
    { txnId: "t-1", accountNumber: "1038010", tokens: 500, bonusTokens: 100 },
  ]),
  ackQueuedJob: vi.fn(async () => ({ applied: true })),
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("eisQueueCenters (rollout flag parsing)", () => {
  it("unset/empty → no queue centers (v1 SOAP everywhere)", async () => {
    vi.stubEnv("GAME_CARD_EIS_QUEUE_CENTERS", "");
    const { eisQueueCenters, isEisQueueCenter } = await import("./bridge-queue");
    expect(eisQueueCenters().size).toBe(0);
    expect(isEisQueueCenter(13)).toBe(false);
  });

  it("parses a comma list with whitespace", async () => {
    vi.stubEnv("GAME_CARD_EIS_QUEUE_CENTERS", " 12, 6 ,13 ");
    const { eisQueueCenters } = await import("./bridge-queue");
    expect([...eisQueueCenters()].sort()).toEqual([12, 13, 6]);
  });

  it("drops garbage and unknown location codes", async () => {
    vi.stubEnv("GAME_CARD_EIS_QUEUE_CENTERS", "banana,99,13");
    const { eisQueueCenters, isEisQueueCenter } = await import("./bridge-queue");
    expect([...eisQueueCenters()]).toEqual([13]);
    expect(isEisQueueCenter(99)).toBe(false);
  });
});

describe("claimJobs / ackJob", () => {
  it("rejects unknown location codes before touching the DB", async () => {
    const { claimJobs } = await import("./bridge-queue");
    const tlog = await import("../data/transactions-log");
    await expect(claimJobs({ locationCode: 99, workerId: "w", max: 3 })).rejects.toMatchObject({
      code: "UNKNOWN_LOCATION",
    });
    expect(tlog.claimQueuedJobs).not.toHaveBeenCalled();
  });

  it("claims for a valid center and echoes the lease", async () => {
    const { claimJobs, CLAIM_LEASE_MS } = await import("./bridge-queue");
    const tlog = await import("../data/transactions-log");
    const res = await claimJobs({ locationCode: 13, workerId: "kiosk-1", max: 3 });
    expect(tlog.claimQueuedJobs).toHaveBeenCalledWith(13, "kiosk-1", 3);
    expect(res.jobs).toHaveLength(1);
    expect(res.leaseMs).toBe(CLAIM_LEASE_MS);
  });

  it("ackJob passes through to the guarded data-layer transition", async () => {
    const { ackJob } = await import("./bridge-queue");
    const tlog = await import("../data/transactions-log");
    const res = await ackJob({ txnId: "t-1", workerId: "kiosk-1", outcome: "ok", code: "0" });
    expect(tlog.ackQueuedJob).toHaveBeenCalledWith({
      txnId: "t-1",
      workerId: "kiosk-1",
      outcome: "ok",
      code: "0",
    });
    expect(res.applied).toBe(true);
  });
});
