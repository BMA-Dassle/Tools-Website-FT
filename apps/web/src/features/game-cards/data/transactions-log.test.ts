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

describe("replay-set exclusion", () => {
  it("listPendingLoads excludes every queue state except NULL and soap_fallback", async () => {
    const { listPendingLoads } = await import("./transactions-log");
    await listPendingLoads(10);
    const q = lastQuery();
    expect(q).toContain("queue_state IS NULL OR queue_state = 'soap_fallback'");
  });

  it("listPendingLoads gives kiosk new-card rows a 15-minute grace (the kiosk credits them itself)", async () => {
    // A swipe kiosk persists the swiped account at prepare/claim, so without
    // the grace a cron tick between the charge and the kiosk's bridge credit
    // would SOAP-credit the same card — EIS and SOAP share no dedup.
    const { listPendingLoads } = await import("./transactions-log");
    await listPendingLoads(10);
    const q = lastQuery();
    expect(q).toContain("kind NOT IN ('new_card', 'voucher')");
    expect(q).toContain("INTERVAL '15 minutes'");
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
    expect(lastQuery()).toContain("loaded_via = 'verify'");
    expect(await markVerifyManual("t-1", "why")).toBe(true);
    expect(lastQuery()).toContain("load_state = 'load_failed'");
    expect(lastQuery()).toContain("queue_state = 'manual'");
  });
});
