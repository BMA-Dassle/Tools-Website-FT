import { describe, expect, it, vi } from "vitest";
import type { JobContext } from "~/features/crm/jobs";
import { HANDLERS, NOT_IMPLEMENTED_ERROR, notImplemented } from "~/features/crm/jobs/registry";
import { runThreecxReconcileJob, type ReconcileJobDeps } from "./jobs";

/** The `threecx-reconcile` job and its registry line. */

function ctx(payload: Record<string, unknown> = {}): JobContext {
  return {
    job: {
      id: "1",
      kind: "threecx-reconcile",
      idempotencyKey: "threecx-reconcile:2026-09-13T18:10",
      payload,
      status: "running",
      attempts: 1,
      maxAttempts: 20,
      nextAttemptAt: "2026-09-13T18:00:00.000Z",
      leasedUntil: null,
      lastError: null,
      result: null,
      createdBy: null,
      createdAt: "2026-09-13T18:00:00.000Z",
      updatedAt: "2026-09-13T18:00:00.000Z",
      resolvedAt: null,
    },
    payload,
    actorEmail: null,
    now: new Date("2026-09-13T18:12:00Z"),
  };
}

const RESULT = {
  from: "a",
  to: "b",
  rowsSeen: 5,
  callsSeen: 3,
  callsWritten: 3,
  legsSkipped: 1,
};

function deps(overrides: Partial<ReconcileJobDeps> = {}) {
  return {
    reconcile: vi.fn(async () => RESULT),
    deps: () => ({}) as never,
    configured: () => true,
    ...overrides,
  } as unknown as ReconcileJobDeps & { reconcile: ReturnType<typeof vi.fn> };
}

describe("the registry line", () => {
  it("is no longer notImplemented", async () => {
    // `notImplemented` handlers answer `{ok:false, error:"not implemented"}` and
    // the runner records them as FAILED — this line must not do that any more.
    expect(HANDLERS["threecx-reconcile"]).toBeDefined();

    // THE CONTROL IS BUILT HERE, NOT BORROWED FROM A NEIGHBOUR.
    // This assertion used to reach for whichever kind was still a stub — first
    // `share-link-expire`, then `pandora-goals-sync` — and each time that
    // neighbour's PR landed, this test broke for a reason that had nothing to
    // do with 3CX. As of 2026-09-13 every kind has a real handler, so there is
    // no borrowable stub left at all. Constructing one locally proves the same
    // thing (a stub answers "not implemented"; our line does not) and can never
    // be invalidated by somebody else shipping.
    const control = notImplemented("threecx-reconcile");
    expect(await control(ctx())).toEqual({ ok: false, error: NOT_IMPLEMENTED_ERROR });
    expect(HANDLERS["threecx-reconcile"].toString()).not.toBe(control.toString());
  });
});

describe("runThreecxReconcileJob", () => {
  it("returns the counts on a normal run", async () => {
    const d = deps();
    expect(await runThreecxReconcileJob(ctx(), d)).toEqual({ ok: true, result: RESULT });
  });

  it("a quiet window is a SUCCESS, not a failure", async () => {
    const d = deps({
      reconcile: vi.fn(async () => ({ ...RESULT, rowsSeen: 0, callsSeen: 0, callsWritten: 0 })),
    });
    const out = await runThreecxReconcileJob(ctx(), d);
    expect(out.ok).toBe(true);
  });

  it("PARKS when 3CX is not configured — no retry will conjure a secret", async () => {
    const out = await runThreecxReconcileJob(ctx(), deps({ configured: () => false }));
    expect(out).toEqual({ ok: false, error: "3cx_not_configured", park: true });
  });

  it("retries a transient PBX failure with backoff, without parking", async () => {
    const d = deps({
      reconcile: vi.fn(async () => {
        throw new Error("3cx GetCallLogData 500");
      }),
    });
    const out = await runThreecxReconcileJob(ctx(), d);
    expect(out).toMatchObject({ ok: false });
    expect("park" in out && out.park).toBeFalsy();
  });

  it("lets a director re-run one window by hand", async () => {
    const d = deps();
    await runThreecxReconcileJob(
      ctx({ from: "2026-09-12T00:00:00Z", to: "2026-09-13T00:00:00Z" }),
      d,
    );
    const arg = d.reconcile.mock.calls[0][0] as { from?: Date; to?: Date };
    expect(arg.from?.toISOString()).toBe("2026-09-12T00:00:00.000Z");
    expect(arg.to?.toISOString()).toBe("2026-09-13T00:00:00.000Z");
  });

  it("ignores a payload date it cannot parse rather than sending Invalid Date to the PBX", async () => {
    const d = deps();
    await runThreecxReconcileJob(ctx({ from: "last tuesday" }), d);
    const arg = d.reconcile.mock.calls[0][0] as { from?: Date };
    expect(arg.from).toBeUndefined();
  });
});
