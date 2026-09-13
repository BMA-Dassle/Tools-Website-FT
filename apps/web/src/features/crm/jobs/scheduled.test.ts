import { describe, expect, it } from "vitest";
import type { JobRow } from "../core/types";
import type { EnqueueInput } from "./data/jobs-db";
import { SCHEDULED_KINDS, enqueueScheduled } from "./scheduled";

/**
 * The cron's self-enqueue: one row per bucket, whatever the tick rate. The
 * store here is the real ON CONFLICT DO NOTHING behaviour in miniature — a
 * second insert with a key it already holds returns the existing row and
 * `created: false`.
 */

function store() {
  const rows = new Map<string, JobRow>();
  const inserts: EnqueueInput[] = [];
  return {
    rows,
    inserts,
    async enqueue(input: EnqueueInput) {
      inserts.push(input);
      const existing = rows.get(input.idempotencyKey);
      if (existing) return { job: existing, created: false };
      const job = { id: String(rows.size + 1), ...input } as unknown as JobRow;
      rows.set(input.idempotencyKey, job);
      return { job, created: true };
    },
  };
}

describe("enqueueScheduled", () => {
  it("enqueues every scheduled kind on this branch, keyed by its ET bucket", async () => {
    const s = store();
    // 23:30Z on Sep 12 is 19:30 ET on Sep 12.
    const out = await enqueueScheduled(new Date("2026-09-12T23:30:00Z"), s);
    expect(out).toEqual([
      { kind: "assign-sweep", idempotencyKey: "assign-sweep:2026-09-12T19", created: true },
      {
        kind: "sevenshifts-mirror",
        idempotencyKey: "sevenshifts-mirror:2026-09-12",
        created: true,
      },
      // C3's bucket is a UTC 5-minute window, not an ET one: a call log is read
      // by instant, and nothing about it belongs to a Fort Myers calendar day.
      {
        kind: "threecx-reconcile",
        idempotencyKey: "threecx-reconcile:2026-09-12T23:30",
        created: true,
      },
    ]);
    expect(s.inserts.every((i) => i.createdBy === "cron")).toBe(true);
  });

  it("two ticks in the same ET hour enqueue the sweep ONCE (the 2-minute cron is idempotent)", async () => {
    const s = store();
    await enqueueScheduled(new Date("2026-09-12T23:30:00Z"), s);
    const second = await enqueueScheduled(new Date("2026-09-12T23:32:00Z"), s);
    expect(second.map((r) => r.created)).toEqual([false, false, false]);
    expect(s.rows.size).toBe(3);
    // The INSERT is still attempted — the unique index is what de-duplicates.
    expect(s.inserts).toHaveLength(6);
  });

  it("the next ET hour is a new sweep bucket; the mirror stays on the same ET day", async () => {
    const s = store();
    await enqueueScheduled(new Date("2026-09-12T23:30:00Z"), s);
    const next = await enqueueScheduled(new Date("2026-09-13T00:10:00Z"), s);
    expect(next).toEqual([
      { kind: "assign-sweep", idempotencyKey: "assign-sweep:2026-09-12T20", created: true },
      {
        kind: "sevenshifts-mirror",
        idempotencyKey: "sevenshifts-mirror:2026-09-12",
        created: false,
      },
      {
        kind: "threecx-reconcile",
        idempotencyKey: "threecx-reconcile:2026-09-13T00:10",
        created: true,
      },
    ]);
  });

  it("one kind failing to enqueue does not stop the others", async () => {
    const s = store();
    let calls = 0;
    const flaky = {
      enqueue: async (input: EnqueueInput) => {
        calls++;
        if (calls === 1) throw new Error("deadlock detected");
        return s.enqueue(input);
      },
    };
    const out = await enqueueScheduled(new Date("2026-09-12T23:30:00Z"), flaky);
    expect(out[0]).toMatchObject({
      kind: "assign-sweep",
      created: false,
      error: "deadlock detected",
    });
    expect(out[1]).toMatchObject({ kind: "sevenshifts-mirror", created: true });
  });

  it("every scheduled kind is a real job kind with a handler", async () => {
    const { HANDLERS } = await import("./registry");
    for (const s of SCHEDULED_KINDS) expect(typeof HANDLERS[s.kind]).toBe("function");
  });
});
