/**
 * PARKED IS NOT A GRAVE — the 2026-08-16 incident, as a test.
 *
 * Five `add-membership` rows — the "Customer Registration" grant, for Chatelain,
 * Puello, Ortengren, Maddy N and Viauri Lewis — sat parked for 21-31 hours
 * reporting "this person is at another center", while every one of them read a
 * clean 200 WITH A VALID WAIVER at the exact location they were parked against.
 * The bug that mis-parked them was fixed three hours after the last one died — and
 * the fix could not reach them, because nothing in the system ever re-asked
 * whether a park's reason still held.
 *
 * Two independent doors were welded shut, and both are covered here:
 *   1. no sweep re-probed a parked row's barrier
 *   2. `enqueueSync` SWALLOWED any re-enqueue against a parked row — the row kept
 *      its idempotency key, so the natural healing path (guest comes back, flow
 *      re-enqueues) updated nothing and returned null, and that followup could
 *      never be created again by any means
 *
 * These assert the SQL's guard clauses directly. That is deliberate: the rules
 * that decide whether a followup may come back from the dead are set-based and
 * live IN the statement, so a test that only exercised a mocked return value
 * would pass while the WHERE clause said something else entirely.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

/** Captures every statement the module runs, with its interpolated params. */
const executed: Array<{ text: string; params: unknown[] }> = [];
let nextResult: Array<Record<string, unknown>> = [];

vi.mock("@/lib/db", () => ({
  isDbConfigured: () => true,
  sql: () => (strings: TemplateStringsArray, ...params: unknown[]) => {
    executed.push({ text: strings.join("?"), params });
    return Promise.resolve(nextResult);
  },
}));

import {
  enqueueSync,
  reviveSyncRow,
  listParkedForRecheck,
  revivalCooldownMinutes,
  MAX_ATTEMPTS,
  MAX_REVIVALS,
  REVIVE_HORIZON_HOURS,
  type SyncQueueRow,
} from "../bmi-sync-queue";

vi.mock("@/lib/bmi-sync-push", () => ({
  SYNC_LEASE_SECONDS: 90,
  sendSyncPush: () => Promise.resolve(null),
}));

/** The last statement that actually mutates/reads the queue table. */
const lastMatching = (needle: string) =>
  [...executed].reverse().find((e) => e.text.includes(needle))?.text ?? "";

const parkedRow = (over: Partial<SyncQueueRow> = {}): SyncQueueRow =>
  ({
    id: 1233,
    kind: "add-membership",
    idempotencyKey: "licence:63000000008534798",
    barrier: "person-local",
    barrierRef: "63000000008534798",
    locationId: "LAB52GY480CJF",
    reservationRef: null,
    payload: {},
    attempts: 0,
    nextAttemptAt: new Date().toISOString(),
    giveUpAt: null,
    status: "parked",
    lastError: "person … does not exist at this center",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    resolvedAt: new Date().toISOString(),
    pushTransport: "vercel-queue",
    revivals: 0,
    ...over,
  }) as SyncQueueRow;

beforeEach(() => {
  executed.length = 0;
  nextResult = [];
});

describe("the cooldown that decides how long we keep re-asking", () => {
  it("starts soon, because the common park is a transient vendor 404", () => {
    expect(revivalCooldownMinutes(0)).toBe(15);
  });

  it("escalates and caps, so a hopeless row cannot spin", () => {
    expect(revivalCooldownMinutes(1)).toBe(30);
    expect(revivalCooldownMinutes(2)).toBe(60);
    expect(revivalCooldownMinutes(99)).toBe(360);
  });

  /**
   * The other common park is "a human has to type a birth date into BMI Office",
   * and humans do that the next morning. Total patience across the allowed
   * revivals therefore has to span more than a day, or the sweep would give up
   * before the person it is waiting on has started work.
   */
  it("spans more than a day in total, so it outlives an overnight human fix", () => {
    const total = Array.from({ length: MAX_REVIVALS }, (_, i) => revivalCooldownMinutes(i)).reduce(
      (a, b) => a + b,
      0,
    );
    expect(total).toBeGreaterThan(24 * 60);
  });

  it("never resurrects last week's work order", () => {
    expect(REVIVE_HORIZON_HOURS).toBeLessThanOrEqual(72);
  });
});

describe("listParkedForRecheck — what is allowed to come back", () => {
  it("only ever looks at parked rows", async () => {
    await listParkedForRecheck();
    expect(lastMatching("FROM bmi_sync_queue")).toMatch(/status = 'parked'/);
  });

  /**
   * THE LINE THAT KEEPS A DEAD ROW DEAD. A row that spent its whole attempt
   * budget, or that a handler declared terminal (attempts stamped to 9_999),
   * failed at the HANDLER — its barrier reading open says nothing about that.
   * Project 63000000008492343 answered 404 everywhere for 40 attempts across
   * 4h33m and is simply gone; it must never be picked up again.
   */
  it("excludes rows the WORK defeated, not just rows the barrier kept out", async () => {
    await listParkedForRecheck();
    const stmt = lastMatching("FROM bmi_sync_queue");
    expect(stmt).toMatch(/attempts <\s*\?/);
    expect(executed.at(-1)?.params).toContain(MAX_ATTEMPTS);
  });

  it("bounds resurrection and ignores ancient parks", async () => {
    await listParkedForRecheck();
    const { text, params } = executed.at(-1)!;
    expect(text).toMatch(/revivals <\s*\?/);
    expect(params).toContain(MAX_REVIVALS);
    expect(params).toContain(REVIVE_HORIZON_HOURS);
  });
});

describe("reviveSyncRow — extends patience, never the budget", () => {
  it("refuses to touch a row that is no longer parked", async () => {
    nextResult = [];
    const ok = await reviveSyncRow(parkedRow(), "200 — present and readable");
    expect(ok).toBe(false);
    expect(lastMatching("UPDATE bmi_sync_queue")).toMatch(/status = 'parked'/);
  });

  it("reports success only when a row actually moved", async () => {
    nextResult = [{ id: 1233 }];
    expect(await reviveSyncRow(parkedRow(), "reopened")).toBe(true);
  });

  /**
   * CONVERGENCE. `attempts` is the lifetime work budget and a sweep-driven
   * revival must not refill it — combined with the `attempts < MAX_ATTEMPTS`
   * filter above, that is what proves the revive→park→revive loop terminates
   * instead of re-probing a doomed row forever.
   */
  it("does NOT refill the attempt budget", async () => {
    nextResult = [{ id: 1233 }];
    await reviveSyncRow(parkedRow({ attempts: 12 }), "reopened");
    const stmt = lastMatching("UPDATE bmi_sync_queue");
    expect(stmt).not.toMatch(/attempts\s*=/);
    expect(stmt).toMatch(/revivals\s*=\s*revivals \+ 1/);
    expect(stmt).toMatch(/give_up_at\s*=/);
  });
});

describe("enqueueSync — the idempotency key must not be a tombstone", () => {
  /**
   * The poison, exactly. `ON CONFLICT … WHERE status = 'pending'` meant a parked
   * row kept its key and the followup could never be re-created — a live caller
   * asking again got a silent null.
   */
  it("lets a live request revive a PARKED row", async () => {
    nextResult = [];
    await enqueueSync({ kind: "add-membership", idempotencyKey: "k" });
    const stmt = lastMatching("ON CONFLICT");
    expect(stmt).toMatch(/status = 'parked'/);
    expect(stmt).toMatch(/revivals <\s*\?/);
  });

  /**
   * …and the original safety property survives untouched: a FINISHED followup
   * must never run twice because a retried request replayed the enqueue.
   */
  it("still refuses to resurrect a done or cancelled row", async () => {
    nextResult = [];
    await enqueueSync({ kind: "add-membership", idempotencyKey: "k" });
    const stmt = lastMatching("ON CONFLICT");
    const guard = stmt.slice(stmt.indexOf("WHERE bmi_sync_queue.status"));
    expect(guard).not.toMatch(/'done'/);
    expect(guard).not.toMatch(/'cancelled'/);
  });

  /** A live caller IS new demand, so this door — unlike the sweep — does refill
   *  the budget, and only for a row that was actually parked. */
  it("gives a revived row a fresh budget, and leaves a pending row's alone", async () => {
    nextResult = [];
    await enqueueSync({ kind: "add-membership", idempotencyKey: "k" });
    const stmt = lastMatching("ON CONFLICT");
    expect(stmt).toMatch(/attempts\s*=\s*CASE WHEN bmi_sync_queue\.status = 'parked'/);
    expect(stmt).toMatch(/THEN 0 ELSE bmi_sync_queue\.attempts END/);
  });
});
