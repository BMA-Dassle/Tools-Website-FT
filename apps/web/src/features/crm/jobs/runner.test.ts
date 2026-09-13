import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JobKind, JobRow, JobStatus } from "../core/types";
import { planFailure, type EnqueueInput, type JobStore } from "./data/jobs-db";

/**
 * The runner against an IN-MEMORY store with a fake clock (brief §3.5, §3.9):
 * lease, backoff, park after max_attempts, idempotent enqueue, `notImplemented`
 * → `failed` with `{ok:false, error:"not implemented"}` and NEVER `done`, `noop`
 * → `done` carrying `actor_email`, and the 45 s deadline handing rows back.
 */

vi.mock("../core/seed", () => ({
  runSeed: async () => ({ reps: 0, logins: 0, statuses: 0, rules: 0, templates: 0, settings: 0 }),
}));

const { HANDLERS, NOT_IMPLEMENTED_ERROR, notImplemented } = await import("./registry");
const { drainDueJobs, runJobInline, runLeasedJob } = await import("./runner");

class Clock {
  t = Date.parse("2026-09-12T23:30:00.000Z");
  now = () => new Date(this.t);
  tick(ms: number) {
    this.t += ms;
  }
}

/** The same semantics as `neonJobStore`, in memory. */
class MemoryStore implements JobStore {
  rows = new Map<string, JobRow>();
  private seq = 0;
  constructor(private clock: Clock) {}

  private iso(offsetMs = 0) {
    return new Date(this.clock.t + offsetMs).toISOString();
  }

  async enqueue(input: EnqueueInput) {
    const existing = [...this.rows.values()].find((r) => r.idempotencyKey === input.idempotencyKey);
    if (existing) return { job: existing, created: false };
    const id = String(++this.seq);
    const job: JobRow = {
      id,
      kind: input.kind,
      idempotencyKey: input.idempotencyKey,
      payload: input.payload ?? {},
      status: "pending",
      attempts: 0,
      maxAttempts: input.maxAttempts ?? 20,
      nextAttemptAt: input.runAt ? input.runAt.toISOString() : this.iso(),
      leasedUntil: null,
      lastError: null,
      result: null,
      createdBy: input.createdBy ?? null,
      createdAt: this.iso(),
      updatedAt: this.iso(),
      resolvedAt: null,
    };
    this.rows.set(id, job);
    return { job, created: true };
  }

  private due(r: JobRow) {
    const now = this.clock.t;
    if ((r.status === "pending" || r.status === "failed") && Date.parse(r.nextAttemptAt) <= now)
      return true;
    if (r.status === "running" && r.leasedUntil && Date.parse(r.leasedUntil) < now) return true;
    return false;
  }

  private lease(r: JobRow, leaseSeconds: number) {
    const next: JobRow = {
      ...r,
      status: "running",
      leasedUntil: this.iso(leaseSeconds * 1000),
      attempts: r.attempts + 1,
      updatedAt: this.iso(),
    };
    this.rows.set(r.id, next);
    return next;
  }

  async leaseDue(limit: number, leaseSeconds: number) {
    return [...this.rows.values()]
      .filter((r) => this.due(r))
      .sort(
        (a, b) =>
          Date.parse(a.nextAttemptAt) - Date.parse(b.nextAttemptAt) || Number(a.id) - Number(b.id),
      )
      .slice(0, limit)
      .map((r) => this.lease(r, leaseSeconds));
  }

  async leaseById(id: string, leaseSeconds: number) {
    const r = this.rows.get(id);
    return r ? this.lease(r, leaseSeconds) : null;
  }

  async complete(id: string, result: unknown) {
    const r = this.rows.get(id)!;
    const next: JobRow = {
      ...r,
      status: "done",
      result,
      lastError: null,
      leasedUntil: null,
      resolvedAt: this.iso(),
    };
    this.rows.set(id, next);
    return next;
  }

  async fail(id: string, error: string, opts: { park?: boolean } = {}) {
    const r = this.rows.get(id)!;
    const plan = planFailure(r, opts.park);
    const next: JobRow = {
      ...r,
      status: plan.status,
      nextAttemptAt: this.iso(plan.delaySeconds * 1000),
      lastError: error,
      result: { ok: false, error },
      leasedUntil: null,
      resolvedAt: plan.status === "parked" ? this.iso() : null,
    };
    this.rows.set(id, next);
    return next;
  }

  async release(id: string) {
    const r = this.rows.get(id)!;
    const next: JobRow = {
      ...r,
      status: "pending",
      leasedUntil: null,
      attempts: Math.max(r.attempts - 1, 0),
    };
    this.rows.set(id, next);
    return next;
  }

  async get(id: string) {
    return this.rows.get(id) ?? null;
  }

  async list(filter: { status?: JobStatus; limit?: number } = {}) {
    return [...this.rows.values()].filter((r) => !filter.status || r.status === filter.status);
  }
}

let clock: Clock;
let store: MemoryStore;
const deps = () => ({ store, handlers: HANDLERS, now: clock.now });

beforeEach(() => {
  clock = new Clock();
  store = new MemoryStore(clock);
});

describe("noop and notImplemented", () => {
  it("noop → done with the actor's email and a ranAt", async () => {
    const { job, result } = await runJobInline(
      { kind: "noop", actorEmail: "eric@headpinz.com" },
      deps(),
    );
    expect(job.status).toBe("done");
    expect(job.attempts).toBe(1);
    expect(result).toEqual({
      ok: true,
      actor_email: "eric@headpinz.com",
      ranAt: clock.now().toISOString(),
    });
    expect(job.result).toEqual(result);
  });

  it("every kind without a PR → failed with {ok:false, error:'not implemented'}, never done", async () => {
    // A kind is "without a PR" while its registry line is still the
    // `notImplemented` stub (same closure source); a PR that ships its
    // handler drops out of this sweep by construction.
    const stubSource = String(notImplemented("noop"));
    const pending = (Object.keys(HANDLERS) as JobKind[]).filter(
      (k) => k !== "noop" && k !== "seed" && String(HANDLERS[k]) === stubSource,
    );
    expect(pending.length).toBeGreaterThan(0);
    expect(pending).not.toContain("mint-bmi-project"); // B3 shipped it
>>>>>>> c9071cc81 (feat(crm): a lead is a row in our database before it is anything in BMI)
    for (const kind of pending) {
      const { job, result } = await runJobInline({ kind, actorEmail: "eric@headpinz.com" }, deps());
      expect(job.status, kind).toBe("failed");
      expect(job.status, kind).not.toBe("done");
      expect(result, kind).toEqual({ ok: false, error: NOT_IMPLEMENTED_ERROR });
      expect(job.lastError, kind).toBe("not implemented");
    }
  });

  it("seed → done with the counts", async () => {
    const { job, result } = await runJobInline(
      { kind: "seed", actorEmail: "eric@headpinz.com" },
      deps(),
    );
    expect(job.status).toBe("done");
    expect(result).toEqual({
      reps: 0,
      logins: 0,
      statuses: 0,
      rules: 0,
      templates: 0,
      settings: 0,
    });
  });

  it("a handler that THROWS is a failure with its message, not a crash", async () => {
    const throwing = { ...HANDLERS, noop: async () => Promise.reject(new Error("kaboom")) };
    await store.enqueue({ kind: "noop", idempotencyKey: "k1" });
    const summary = await drainDueJobs({}, { store, handlers: throwing, now: clock.now });
    expect(summary).toMatchObject({ leased: 1, ran: 1, done: 0, retry: 1, parked: 0 });
    expect(summary.outcomes[0]).toEqual({
      id: "1",
      kind: "noop",
      status: "failed",
      error: "kaboom",
    });
  });
});

describe("idempotent enqueue", () => {
  it("the same idempotency key enqueues once", async () => {
    const a = await store.enqueue({ kind: "noop", idempotencyKey: "assign-sweep:2026-09-12T23" });
    const b = await store.enqueue({ kind: "noop", idempotencyKey: "assign-sweep:2026-09-12T23" });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.job.id).toBe(a.job.id);
    expect(store.rows.size).toBe(1);
  });
});

describe("lease", () => {
  it("a leased row is running with attempts+1 and is not leased again until its lease expires", async () => {
    await store.enqueue({ kind: "noop", idempotencyKey: "k" });
    const first = await store.leaseDue(50, 120);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ status: "running", attempts: 1 });
    expect(await store.leaseDue(50, 120)).toHaveLength(0);

    clock.tick(121_000);
    const again = await store.leaseDue(50, 120);
    expect(again).toHaveLength(1);
    expect(again[0].attempts).toBe(2);
  });

  it("a future next_attempt_at is not due", async () => {
    await store.enqueue({
      kind: "noop",
      idempotencyKey: "later",
      runAt: new Date(clock.t + 60_000),
    });
    expect(await store.leaseDue(50, 120)).toHaveLength(0);
    clock.tick(60_000);
    expect(await store.leaseDue(50, 120)).toHaveLength(1);
  });
});

describe("backoff and park", () => {
  it("each failure schedules min(600, 30×attempts) s later; attempt max_attempts parks", async () => {
    const handlers = {
      ...HANDLERS,
      noop: async () => ({ ok: false as const, error: "still down" }),
    };
    await store.enqueue({ kind: "noop", idempotencyKey: "flaky", maxAttempts: 3 });

    let summary = await drainDueJobs({}, { store, handlers, now: clock.now });
    expect(summary.retry).toBe(1);
    let row = (await store.get("1"))!;
    expect(row.status).toBe("failed");
    expect(Date.parse(row.nextAttemptAt) - clock.t).toBe(30_000);

    clock.tick(29_000);
    expect((await drainDueJobs({}, { store, handlers, now: clock.now })).leased).toBe(0);
    clock.tick(1_000);
    summary = await drainDueJobs({}, { store, handlers, now: clock.now });
    expect(summary.retry).toBe(1);
    row = (await store.get("1"))!;
    expect(row.attempts).toBe(2);
    expect(Date.parse(row.nextAttemptAt) - clock.t).toBe(60_000);

    clock.tick(60_000);
    summary = await drainDueJobs({}, { store, handlers, now: clock.now });
    expect(summary.parked).toBe(1);
    row = (await store.get("1"))!;
    expect(row.status).toBe("parked");
    expect(row.attempts).toBe(3);
    expect(row.resolvedAt).not.toBeNull();

    clock.tick(10 * 60_000);
    expect((await drainDueJobs({}, { store, handlers, now: clock.now })).leased).toBe(0);
  });

  it("the backoff caps at 600 s", async () => {
    const handlers = { ...HANDLERS, noop: async () => ({ ok: false as const, error: "down" }) };
    await store.enqueue({ kind: "noop", idempotencyKey: "slow", maxAttempts: 40 });
    for (let i = 0; i < 25; i++) {
      await drainDueJobs({}, { store, handlers, now: clock.now });
      const row = (await store.get("1"))!;
      clock.tick(Date.parse(row.nextAttemptAt) - clock.t);
    }
    const row = (await store.get("1"))!;
    expect(row.attempts).toBe(25);
    expect(row.status).toBe("failed");
  });

  it("a handler may ask to park immediately", async () => {
    const handlers = {
      ...HANDLERS,
      noop: async () => ({ ok: false as const, error: "gone", park: true }),
    };
    await store.enqueue({ kind: "noop", idempotencyKey: "gone" });
    const summary = await drainDueJobs({}, { store, handlers, now: clock.now });
    expect(summary.parked).toBe(1);
    expect((await store.get("1"))!.status).toBe("parked");
  });
});

describe("the drain", () => {
  it("runs a batch in due order and stops at the deadline, releasing what it did not reach", async () => {
    const slow = {
      ...HANDLERS,
      noop: async () => {
        clock.tick(20_000);
        return { ok: true as const, result: { ok: true } };
      },
    };
    for (let i = 0; i < 5; i++) await store.enqueue({ kind: "noop", idempotencyKey: `n${i}` });
    const summary = await drainDueJobs(
      { deadlineMs: 45_000 },
      { store, handlers: slow, now: clock.now },
    );
    // 20 s per job: three run (0, 20, 40 s elapsed) before the 45 s deadline.
    expect(summary).toMatchObject({ leased: 5, ran: 3, done: 3, deferred: 2 });
    const released = [...store.rows.values()].filter((r) => r.status === "pending");
    expect(released).toHaveLength(2);
    for (const r of released) expect(r.attempts).toBe(0);
  });

  it("honours the batch size", async () => {
    for (let i = 0; i < 4; i++) await store.enqueue({ kind: "noop", idempotencyKey: `b${i}` });
    const summary = await drainDueJobs({ batch: 2 }, deps());
    expect(summary.leased).toBe(2);
    expect(summary.done).toBe(2);
  });

  it("runLeasedJob with an unknown kind fails and parks rather than throwing", async () => {
    const { job } = await store.enqueue({ kind: "noop", idempotencyKey: "u" });
    const leased = (await store.leaseById(job.id, 120))!;
    const handlers = { ...HANDLERS } as Record<string, (typeof HANDLERS)["noop"]>;
    delete handlers.noop;
    const { job: after, outcome } = await runLeasedJob(leased, {
      store,
      handlers: handlers as typeof HANDLERS,
      now: clock.now,
    });
    expect(outcome).toEqual({ ok: false, error: NOT_IMPLEMENTED_ERROR, park: true });
    expect(after.status).toBe("parked");
  });
});
