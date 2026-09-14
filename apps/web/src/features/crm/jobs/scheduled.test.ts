import { describe, expect, it } from "vitest";
import type { JobRow } from "../core/types";
import type { EnqueueInput } from "./data/jobs-db";
import { SCHEDULED_KINDS, enqueueScheduled } from "./scheduled";

/**
 * The BMI delta enqueues one row per TENANT, not one per tick, so it is a
 * separate step inside `enqueueScheduled`. The cases below are about the
 * one-key-per-tick loop; they stub it out so a second Office tenant does not
 * change what they assert. `noDelta` is the stub; the real step has its own
 * test at the bottom.
 */
const noDelta = async () => [];

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
    const out = await enqueueScheduled(
      new Date("2026-09-12T23:30:00Z"),
      s,
      SCHEDULED_KINDS,
      noDelta,
    );
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
      // The deadline on a welcome held for a planner who never arrived - an ET
      // hour like the sweep, because it is about somebody's working day.
      {
        kind: "guest-intro-backstop",
        idempotencyKey: "guest-intro-backstop:2026-09-12T19",
        created: true,
      },
    ]);
    expect(s.inserts.every((i) => i.createdBy === "cron")).toBe(true);
  });

  it("two ticks in the same ET hour enqueue the sweep ONCE (the 2-minute cron is idempotent)", async () => {
    const s = store();
    await enqueueScheduled(new Date("2026-09-12T23:30:00Z"), s, SCHEDULED_KINDS, noDelta);
    const second = await enqueueScheduled(
      new Date("2026-09-12T23:32:00Z"),
      s,
      SCHEDULED_KINDS,
      noDelta,
    );
    expect(second.map((r) => r.created)).toEqual([false, false, false, false]);
    expect(s.rows.size).toBe(4);
    // The INSERT is still attempted — the unique index is what de-duplicates.
    expect(s.inserts).toHaveLength(8);
  });

  it("the next ET hour is a new sweep bucket; the mirror stays on the same ET day", async () => {
    const s = store();
    await enqueueScheduled(new Date("2026-09-12T23:30:00Z"), s, SCHEDULED_KINDS, noDelta);
    const next = await enqueueScheduled(
      new Date("2026-09-13T00:10:00Z"),
      s,
      SCHEDULED_KINDS,
      noDelta,
    );
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
      {
        kind: "guest-intro-backstop",
        idempotencyKey: "guest-intro-backstop:2026-09-12T20",
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
    const out = await enqueueScheduled(
      new Date("2026-09-12T23:30:00Z"),
      flaky,
      SCHEDULED_KINDS,
      noDelta,
    );
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

describe("the BMI mirror's delta", () => {
  /**
   * It had never been scheduled at all, so the incremental sync only ran when
   * somebody pressed Run by hand — and nobody ever had for Fort Myers. Naples
   * had delta rows and Fort Myers had none, so our copy of that centre went
   * stale the moment anything was booked.
   */
  it("enqueues one tick per Office tenant, alongside the per-tick kinds", async () => {
    const s = store();
    const ticks = async () => [
      { key: "bmi-mirror-delta:2026-09-12T23:35:headpinzftmyers", created: true },
      { key: "bmi-mirror-delta:2026-09-12T23:35:headpinznaples", created: true },
    ];
    const out = await enqueueScheduled(new Date("2026-09-12T23:30:00Z"), s, SCHEDULED_KINDS, ticks);
    const delta = out.filter((r) => r.kind === "bmi-mirror-delta");
    expect(delta.map((r) => r.idempotencyKey)).toEqual([
      "bmi-mirror-delta:2026-09-12T23:35:headpinzftmyers",
      "bmi-mirror-delta:2026-09-12T23:35:headpinznaples",
    ]);
    expect(delta.every((r) => r.created)).toBe(true);
    // The per-tick kinds still went in beside it.
    expect(out.filter((r) => r.kind === "assign-sweep")).toHaveLength(1);
  });

  it("a throwing delta step is reported and does NOT cost the tick its other kinds", async () => {
    const s = store();
    const boom = async () => {
      throw new Error("neon timeout");
    };
    const out = await enqueueScheduled(new Date("2026-09-12T23:30:00Z"), s, SCHEDULED_KINDS, boom);
    expect(out.filter((r) => r.kind !== "bmi-mirror-delta").length).toBe(SCHEDULED_KINDS.length);
    const delta = out.find((r) => r.kind === "bmi-mirror-delta")!;
    expect(delta.created).toBe(false);
    expect(delta.error).toBe("neon timeout");
  });
});
