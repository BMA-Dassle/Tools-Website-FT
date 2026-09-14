import { describe, expect, it, vi } from "vitest";
import {
  FROM_CONTRACT,
  OUR_RANK,
  movesFor,
  runStatusReconcile,
  statusReconcileKey,
  type ReconcileCandidate,
  type ReconcileMove,
} from "./status-reconcile";

/**
 * The job that advances a lead whose CONTRACT has moved past it.
 *
 * It writes a status that drives the board, the queue's nagging and the KPI
 * buckets, so the rule is a unit test rather than a live probe. Owner,
 * 2026-09-14, on Kara Simmons: "this event should be in lead its contract sent
 * double check and fix."
 */

function row(over: Partial<ReconcileCandidate> = {}): ReconcileCandidate {
  return {
    id: "1",
    publicId: "L-129",
    statusId: "assigned",
    projectNumber: "2950",
    gfStatus: "contract_sent",
    ...over,
  };
}

describe("movesFor", () => {
  it("advances a lead its contract has overtaken — the Kara Simmons case", () => {
    // `assigned` on the board, contract signed and the deposit paid.
    expect(movesFor([row({ gfStatus: "deposit_paid" })])).toEqual([
      { ...row({ gfStatus: "deposit_paid" }), to: "deposit" },
    ]);
  });

  it("NEVER pulls a status back", () => {
    // A rep who moved a deal on knows something the money does not — a verbal
    // yes, a bounced cheque. A job that undid their work would be worse than
    // the drift it fixes.
    expect(movesFor([row({ statusId: "confirmed", gfStatus: "contract_sent" })])).toEqual([]);
    expect(movesFor([row({ statusId: "deposit", gfStatus: "deposit_paid" })])).toEqual([]);
  });

  it("leaves Lost and No-response alone — those are a judgement about a guest", () => {
    // Belt and braces: the query excludes them too, but the rule must not rely
    // on a WHERE clause somebody could edit.
    for (const statusId of ["lost", "noresp"]) {
      expect(movesFor([row({ statusId, gfStatus: "balance_charged" })])).toEqual([]);
    }
  });

  it("ignores a contract status that proves nothing", () => {
    // A draft quote nobody sent is not evidence of anything.
    expect(movesFor([row({ gfStatus: "draft" })])).toEqual([]);
    expect(movesFor([row({ gfStatus: "something_new" })])).toEqual([]);
  });

  it("an unknown status on OUR side is left where it is, not ranked as zero", () => {
    // Ranking an unknown as 0 would let the money drag any status we do not
    // recognise all the way forward.
    expect(movesFor([row({ statusId: "snoozed", gfStatus: "balance_charged" })])).toEqual([]);
  });

  it("money in the bank is a won deal whatever the board says", () => {
    expect(movesFor([row({ gfStatus: "balance_charged" })])[0]!.to).toBe("confirmed");
    expect(movesFor([row({ gfStatus: "completed" })])[0]!.to).toBe("confirmed");
  });

  it("every contract status it maps names a status our own rank knows", () => {
    for (const [gf, ours] of Object.entries(FROM_CONTRACT)) {
      expect(OUR_RANK[ours], `${gf} → ${ours}`).toBeTypeOf("number");
    }
  });

  it("lost and noresp are ABSENT from the rank, not zero", () => {
    expect(OUR_RANK.lost).toBeUndefined();
    expect(OUR_RANK.noresp).toBeUndefined();
  });
});

describe("statusReconcileKey", () => {
  it("is one bucket per ET day, so the 2-minute cron runs it once", () => {
    expect(statusReconcileKey(new Date("2026-09-12T23:30:00Z"))).toBe(
      "lead-status-reconcile:2026-09-12",
    );
    // 01:00Z is still the 12th in Eastern time.
    expect(statusReconcileKey(new Date("2026-09-13T01:00:00Z"))).toBe(
      "lead-status-reconcile:2026-09-12",
    );
  });
});

describe("runStatusReconcile", () => {
  function deps(rows: ReconcileCandidate[], applyMove = vi.fn(async () => {})) {
    const activities: Array<{ leadId: string; body: string }> = [];
    return {
      deps: {
        listCandidates: async () => rows,
        applyMove,
        recordActivity: (async (input: { leadId: string; body: string }) => {
          activities.push({ leadId: input.leadId, body: input.body });
          return undefined;
        }) as never,
      },
      activities,
      applyMove,
    };
  }

  it("writes a timeline line saying WHY, because nobody pressed anything", async () => {
    const { deps: d, activities } = deps([row({ gfStatus: "deposit_paid" })]);
    const r = await runStatusReconcile(d);
    expect(r).toMatchObject({ scanned: 1, advanced: 1 });
    expect(activities).toHaveLength(1);
    expect(activities[0]!.body).toBe(
      "Status assigned → deposit — the contract is already deposit_paid",
    );
  });

  it("one lead that fails to write does not stop the rest", async () => {
    const applyMove = vi.fn(async (m: ReconcileMove) => {
      if (m.publicId === "L-2") throw new Error("row vanished");
    });
    const { deps: d } = deps(
      [
        row({ id: "1", publicId: "L-1", gfStatus: "deposit_paid" }),
        row({ id: "2", publicId: "L-2", gfStatus: "deposit_paid" }),
        row({ id: "3", publicId: "L-3", gfStatus: "deposit_paid" }),
      ],
      applyMove as never,
    );
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const r = await runStatusReconcile(d);
      expect(r.scanned).toBe(3);
      expect(r.advanced).toBe(2);
    } finally {
      err.mockRestore();
    }
  });

  it("a second run finds nothing — it is idempotent by construction", async () => {
    // After the first pass the rows come back already advanced, and an
    // already-advanced lead is not behind anything.
    const after = [row({ statusId: "deposit", gfStatus: "deposit_paid" })];
    const { deps: d, activities } = deps(after);
    const r = await runStatusReconcile(d);
    expect(r.advanced).toBe(0);
    expect(activities).toHaveLength(0);
  });
});
