import { describe, expect, it, vi } from "vitest";
import type { JobContext } from "~/features/crm/jobs";
import type { LeadAssignmentView, LeadView } from "../contracts";
import { ALL_REPS, QUEUE_LEADS, makeLead } from "../test-support";
import { runLeadBmiJob, type LeadBmiJobDeps } from "./jobs";

/**
 * The `mint-bmi-project` handler: retry vs park verdicts for both tasks.
 */

const ctx = (payload: Record<string, unknown>): JobContext => ({
  job: {
    id: "1",
    kind: "mint-bmi-project",
    idempotencyKey: "k",
    payload,
    status: "running",
    attempts: 1,
    maxAttempts: 20,
    nextAttemptAt: "",
    leasedUntil: null,
    lastError: null,
    result: null,
    createdBy: null,
    createdAt: "",
    updatedAt: "",
    resolvedAt: null,
  },
  payload,
  actorEmail: "eric@headpinz.com",
  now: new Date("2026-09-12T23:30:00Z"),
});

const assignment = (over: Partial<LeadAssignmentView> = {}): LeadAssignmentView => ({
  id: "77",
  leadId: "1061",
  fromRepId: null,
  toRepId: "1",
  toRepName: "Kelsea Kosco",
  toRepSlug: "kelsea",
  actorEmail: "eric@headpinz.com",
  reason: "manual",
  ruleId: null,
  trace: [],
  note: null,
  bmiResponsibleSyncedAt: null,
  createdAt: "",
  ...over,
});

function deps(lead: LeadView | null, over: Partial<LeadBmiJobDeps> = {}) {
  const calls: string[] = [];
  const d: LeadBmiJobDeps = {
    getLead: async () => lead,
    listReps: async () => ALL_REPS,
    listAssignments: async () => [assignment()],
    mintLead: async (l) => {
      calls.push("mint");
      return {
        outcome: {
          status: "minted",
          projectId: "63000000009561437",
          projectNumber: "DH3249",
          personId: null,
          assignedAgent: null,
        },
        lead: { ...l, mintStatus: "minted" },
      };
    },
    mintDeps: () => ({}) as never,
    syncResponsible: async () => {
      calls.push("sync");
      return { status: "synced" };
    },
    assignDeps: () => ({}) as never,
    ...over,
  };
  return { d, calls };
}

const unminted = makeLead({
  ...QUEUE_LEADS[0]!,
  mintStatus: "failed",
  bmi: { ...QUEUE_LEADS[0]!.bmi, projectId: null },
});
const minted = makeLead({
  ...QUEUE_LEADS[0]!,
  rep: "1",
  bmi: { ...QUEUE_LEADS[0]!.bmi, projectId: "63000000009561437" },
});

describe("mint task", () => {
  it("parks on a missing / unknown lead", async () => {
    expect(await runLeadBmiJob(ctx({}), deps(null).d)).toMatchObject({ ok: false, park: true });
    expect(await runLeadBmiJob(ctx({ leadId: "1" }), deps(null).d)).toMatchObject({
      ok: false,
      park: true,
      error: "lead 1 not found",
    });
  });
  it("already minted → done without calling Pandora", async () => {
    const { d, calls } = deps(minted);
    expect(await runLeadBmiJob(ctx({ leadId: "1061", task: "mint" }), d)).toMatchObject({
      ok: true,
      result: { already: "minted" },
    });
    expect(calls).toEqual([]);
  });
  it("a blocker a retry cannot fix (no email) → park", async () => {
    const r = await runLeadBmiJob(
      ctx({ leadId: "1061", task: "mint" }),
      deps({ ...unminted, guest: { ...unminted.guest, email: null } }).d,
    );
    expect(r).toEqual({ ok: false, error: "cannot mint: needs_email_or_time", park: true });
  });
  it("mints with the assignee's Office name as agent; a Pandora failure is a retry", async () => {
    const agents: unknown[] = [];
    const { d } = deps(
      { ...unminted, rep: "1" },
      {
        mintLead: async (l, extras) => {
          agents.push(extras?.agent);
          return { outcome: { status: "failed", error: "boom", httpStatus: 500 }, lead: l };
        },
      },
    );
    expect(await runLeadBmiJob(ctx({ leadId: "1061" }), d)).toEqual({ ok: false, error: "boom" });
    expect(agents).toEqual(["Kelsea Kosco"]);
    const ok = await runLeadBmiJob(ctx({ leadId: "1061" }), deps(unminted).d);
    expect(ok).toMatchObject({ ok: true, result: { projectNumber: "DH3249" } });
  });
});

describe("responsible task", () => {
  const payload = { leadId: "1061", task: "responsible", assignmentId: "77", repId: "1" };
  it("superseded (lead reassigned since) → park", async () => {
    expect(await runLeadBmiJob(ctx(payload), deps({ ...minted, rep: "2" }).d)).toMatchObject({
      ok: false,
      park: true,
      error: "assignment superseded",
    });
  });
  it("already synced → done", async () => {
    const { d, calls } = deps(minted, {
      listAssignments: async () => [assignment({ bmiResponsibleSyncedAt: "2026-09-12T23:00:00Z" })],
    });
    expect(await runLeadBmiJob(ctx(payload), d)).toMatchObject({
      ok: true,
      result: { already: "synced" },
    });
    expect(calls).toEqual([]);
  });
  it("no project yet → retry (the mint job will land it)", async () => {
    expect(
      await runLeadBmiJob(
        ctx(payload),
        deps({ ...minted, bmi: { ...minted.bmi, projectId: null } }).d,
      ),
    ).toEqual({ ok: false, error: "lead has no BMI project yet" });
  });
  it("synced → done; failed → retry; no Office id → park", async () => {
    expect(await runLeadBmiJob(ctx(payload), deps(minted).d)).toMatchObject({
      ok: true,
      result: { bmi: { status: "synced" } },
    });
    expect(
      await runLeadBmiJob(
        ctx(payload),
        deps(minted, { syncResponsible: async () => ({ status: "failed", error: "500" }) }).d,
      ),
    ).toEqual({ ok: false, error: "500" });
    expect(
      await runLeadBmiJob(
        ctx(payload),
        deps(minted, { syncResponsible: async () => ({ status: "no_bmi_user" }) }).d,
      ),
    ).toMatchObject({ ok: false, park: true });
  });
  it("the registry line resolves to this handler through the leads barrel (no static cycle)", async () => {
    vi.resetModules();
    const { HANDLERS } = await import("~/features/crm/jobs/registry");
    expect(typeof HANDLERS["mint-bmi-project"]).toBe("function");
    expect(String(HANDLERS["mint-bmi-project"])).toContain("runLeadBmiJob");
  });
});
