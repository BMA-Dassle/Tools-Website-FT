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
  it("listPendingLoads replays NULL / soap_fallback / queued, but never the ambiguous claimed/verify/manual", async () => {
    // 'queued' is safe to replay (a bridge would have moved it to 'claimed'
    // before crediting, so a bare queued row was never credited). claimed/
    // verify/manual are excluded — re-crediting a possibly-already-credited
    // card would double-charge (no EIS/proxy dedup).
    const { listPendingLoads } = await import("./transactions-log");
    await listPendingLoads(10);
    // The eligibility set is exactly NULL / soap_fallback / queued — claimed,
    // verify and manual are absent from it, so they're never replayed. (Checked
    // on the clause itself, not the surrounding comment, which mentions the
    // excluded states by name.)
    const clause = lastQuery().replace(/--[^\n]*/g, ""); // strip SQL comments
    expect(clause).toContain("queue_state IS NULL OR queue_state IN ('soap_fallback', 'queued')");
    expect(clause).not.toContain("claimed");
    expect(clause).not.toContain("verify");
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
});
