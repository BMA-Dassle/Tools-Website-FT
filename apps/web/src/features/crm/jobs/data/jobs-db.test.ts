import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `crm_jobs` at the SQL boundary: the backoff formula (pure AND in the UPDATE),
 * the lease's `FOR UPDATE SKIP LOCKED`, the idempotent enqueue.
 */

const db = await vi.hoisted(async () =>
  (await import("@/test/stubs/recording-sql")).makeRecordingSql(),
);
vi.mock("@ft/db", () => ({ sql: () => db.q, isDbConfigured: () => true }));

const { backoffSeconds, planFailure, neonJobStore, mapJobRow } = await import("./jobs-db");

const ROW = {
  id: "41",
  kind: "noop",
  idempotency_key: "manual:noop:abc",
  payload: {},
  status: "pending",
  attempts: 0,
  max_attempts: 20,
  next_attempt_at: "2026-09-12T23:00:00+00",
  leased_until: null,
  last_error: null,
  result: null,
  created_by: "eric@headpinz.com",
  created_at: "2026-09-12T23:00:00+00",
  updated_at: "2026-09-12T23:00:00+00",
  resolved_at: null,
};

beforeEach(() => db.reset());

describe("backoff", () => {
  it("min(600, 30 × attempts)", () => {
    expect(backoffSeconds(1)).toBe(30);
    expect(backoffSeconds(2)).toBe(60);
    expect(backoffSeconds(19)).toBe(570);
    expect(backoffSeconds(20)).toBe(600);
    expect(backoffSeconds(50)).toBe(600);
    expect(backoffSeconds(0)).toBe(30);
  });

  it("planFailure: failed with backoff until max_attempts, then parked; park on request", () => {
    expect(planFailure({ attempts: 1, maxAttempts: 20 })).toEqual({
      status: "failed",
      delaySeconds: 30,
    });
    expect(planFailure({ attempts: 19, maxAttempts: 20 })).toEqual({
      status: "failed",
      delaySeconds: 570,
    });
    expect(planFailure({ attempts: 20, maxAttempts: 20 })).toEqual({
      status: "parked",
      delaySeconds: 0,
    });
    expect(planFailure({ attempts: 1, maxAttempts: 20 }, true)).toEqual({
      status: "parked",
      delaySeconds: 0,
    });
  });
});

describe("neonJobStore SQL", () => {
  it("enqueue is ON CONFLICT (idempotency_key) DO NOTHING; a duplicate returns the existing row, created:false", async () => {
    db.respond = (stmt) => (/^INSERT INTO crm_jobs/.test(stmt.text) ? [ROW] : []);
    const first = await neonJobStore.enqueue({
      kind: "noop",
      idempotencyKey: "manual:noop:abc",
      createdBy: "e",
    });
    expect(first.created).toBe(true);
    expect(first.job.id).toBe("41");
    const insert = db.matching(/^INSERT INTO crm_jobs/)[0];
    expect(insert.text).toContain("ON CONFLICT (idempotency_key) DO NOTHING");
    expect(insert.params[1]).toBe("manual:noop:abc");

    db.reset();
    db.respond = (stmt) =>
      /^INSERT INTO crm_jobs/.test(stmt.text)
        ? []
        : /WHERE idempotency_key = \$1/.test(stmt.text)
          ? [ROW]
          : [];
    const second = await neonJobStore.enqueue({ kind: "noop", idempotencyKey: "manual:noop:abc" });
    expect(second.created).toBe(false);
    expect(second.job.id).toBe("41");
  });

  it("leaseDue takes pending/failed-and-due rows and expired running leases, FOR UPDATE SKIP LOCKED, attempts + 1", async () => {
    db.respond = (stmt) =>
      /UPDATE crm_jobs AS j/.test(stmt.text) ? [{ ...ROW, status: "running", attempts: 1 }] : [];
    const rows = await neonJobStore.leaseDue(50, 120);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("running");
    const lease = db.matching(/UPDATE crm_jobs AS j/)[0];
    expect(lease.text).toContain("FOR UPDATE SKIP LOCKED");
    expect(lease.text).toContain("status IN ('pending','failed') AND next_attempt_at <= NOW()");
    expect(lease.text).toContain(
      "status = 'running' AND leased_until IS NOT NULL AND leased_until < NOW()",
    );
    expect(lease.text).toContain("attempts = j.attempts + 1");
    expect(lease.params).toEqual([50, 120]);
  });

  it("fail applies the SAME backoff in SQL and parks at max_attempts; complete resolves", async () => {
    await neonJobStore.fail("41", "boom");
    const fail = db.matching(/SET status = CASE WHEN/)[0];
    expect(fail.text).toContain("LEAST(600, 30 * GREATEST(attempts, 1))");
    expect(fail.text).toContain("THEN 'parked' ELSE 'failed' END");
    expect(fail.text).toContain("attempts >= max_attempts");
    expect(fail.params).toEqual(["41", "boom", false]);

    db.reset();
    await neonJobStore.complete("41", { ok: true });
    const done = db.matching(/SET status = 'done'/)[0];
    expect(done.text).toContain("resolved_at = NOW()");
    expect(done.params).toEqual(["41", JSON.stringify({ ok: true })]);
  });

  it("release hands a leased row back without counting the attempt", async () => {
    await neonJobStore.release("41");
    const rel = db.matching(/SET status = 'pending', leased_until = NULL/)[0];
    expect(rel.text).toContain("attempts = GREATEST(attempts - 1, 0)");
    expect(rel.text).toContain("AND status = 'running'");
  });

  it("mapJobRow: ids as strings, unknown kind/status fall back safely", () => {
    const j = mapJobRow({
      ...ROW,
      id: 41 as unknown as string,
      kind: "mystery",
      status: "weird",
      payload: "x",
    });
    expect(j.id).toBe("41");
    expect(j.kind).toBe("noop");
    expect(j.status).toBe("pending");
    expect(j.payload).toEqual({});
  });
});
