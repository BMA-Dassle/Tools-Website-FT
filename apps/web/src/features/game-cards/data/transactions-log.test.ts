/**
 * SQL-shape tests for the bridge-queue ledger helpers. The mock captures each
 * tagged-template statement so we can assert the guards that keep the EIS and
 * SOAP credit paths disjoint (the whole double-credit defense lives in these
 * WHERE clauses).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const queries: string[] = [];
let nextRows: Record<string, unknown>[] = [];

vi.mock("@ft/db", () => ({
  isDbConfigured: () => true,
  sql: () => async (strings: TemplateStringsArray) => {
    const text = strings.join(" ? ");
    queries.push(text);
    return nextRows;
  },
}));

function lastQuery(): string {
  return queries[queries.length - 1] ?? "";
}

beforeEach(() => {
  queries.length = 0;
  nextRows = [];
});

describe("claimQueuedJobs", () => {
  it("claims atomically with SKIP LOCKED and all four eligibility guards", async () => {
    const { claimQueuedJobs } = await import("./transactions-log");
    nextRows = [{ txn_id: "t-1", account_number: "1038010", tokens: 500, bonus_tokens: 100 }];
    const jobs = await claimQueuedJobs(13, "kiosk-1", 3);

    const q = lastQuery();
    expect(q).toContain("FOR UPDATE SKIP LOCKED");
    expect(q).toContain("queue_state = 'queued'");
    expect(q).toContain("state = 'charged'");
    expect(q).toContain("load_state = 'pending'");
    expect(q).toContain("location_code =");
    expect(q).toContain("SET queue_state = 'claimed'");
    expect(jobs).toEqual([
      { txnId: "t-1", accountNumber: "1038010", tokens: 500, bonusTokens: 100 },
    ]);
  });
});

describe("ackQueuedJob", () => {
  it("ok fuses loaded+completed with queue done, accepting claimed OR verify", async () => {
    const { ackQueuedJob } = await import("./transactions-log");
    nextRows = [{ txn_id: "t-1" }];
    const res = await ackQueuedJob({ txnId: "t-1", workerId: "w", outcome: "ok", code: "0" });
    const q = lastQuery();
    expect(q).toContain("load_state = 'loaded'");
    expect(q).toContain("state = 'completed'");
    expect(q).toContain("queue_state = 'done'");
    expect(q).toContain("IN ('claimed', 'verify')");
    expect(q).toContain("claimed_by =");
    expect(res.applied).toBe(true);
  });

  it("declined/no_attempt → soap_fallback, guarded so a loaded row can't re-enter replay", async () => {
    const { ackQueuedJob } = await import("./transactions-log");
    nextRows = [];
    const res = await ackQueuedJob({ txnId: "t-1", workerId: "w", outcome: "declined" });
    const q = lastQuery();
    expect(q).toContain("SET queue_state = 'soap_fallback'");
    expect(q).toContain("load_state = 'pending'");
    expect(res.applied).toBe(false); // already-transitioned rows report unapplied
  });

  it("unknown → verify, only from the claiming worker's live claim", async () => {
    const { ackQueuedJob } = await import("./transactions-log");
    await ackQueuedJob({ txnId: "t-1", workerId: "w", outcome: "unknown" });
    const q = lastQuery();
    expect(q).toContain("SET queue_state = 'verify'");
    expect(q).toContain("queue_state = 'claimed'");
    expect(q).toContain("claimed_by =");
  });
});

describe("enqueue + replay-set exclusion", () => {
  it("markChargedQueued sets charged AND queued in one statement (no cron window)", async () => {
    const { markChargedQueued } = await import("./transactions-log");
    await markChargedQueued("t-1", "o-1", { card: "p-1" });
    const q = lastQuery();
    expect(q).toContain("state = 'charged'");
    expect(q).toContain("queue_state = 'queued'");
    expect(q).toContain("queued_at = NOW()");
  });

  it("listPendingLoads excludes every queue state except NULL and soap_fallback", async () => {
    const { listPendingLoads } = await import("./transactions-log");
    await listPendingLoads(10);
    const q = lastQuery();
    expect(q).toContain("queue_state IS NULL OR queue_state = 'soap_fallback'");
  });

  it("sweeps carry their state guards and age windows", async () => {
    const { sweepStaleQueued, sweepStaleClaimed } = await import("./transactions-log");
    await sweepStaleQueued();
    expect(lastQuery()).toContain("queue_state = 'queued'");
    expect(lastQuery()).toContain("INTERVAL '60 seconds'");
    await sweepStaleClaimed();
    expect(lastQuery()).toContain("queue_state = 'claimed'");
    expect(lastQuery()).toContain("INTERVAL '3 minutes'");
    expect(lastQuery()).toContain("load_state = 'pending'");
    expect(lastQuery()).toContain("SET queue_state = 'verify'");
  });

  it("verify resolutions are guarded to live verify rows only", async () => {
    const { markVerifiedLoaded, markVerifyManual } = await import("./transactions-log");
    nextRows = [{ txn_id: "t-1" }];
    expect(await markVerifiedLoaded("t-1")).toBe(true);
    expect(lastQuery()).toContain("queue_state = 'verify' AND load_state = 'pending'");
    expect(lastQuery()).toContain("queue_state = 'done'");
    expect(await markVerifyManual("t-1", "why")).toBe(true);
    expect(lastQuery()).toContain("load_state = 'load_failed'");
    expect(lastQuery()).toContain("queue_state = 'manual'");
  });
});
