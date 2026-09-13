import { describe, expect, it, vi } from "vitest";
import type { CrmStatus, StatusBmiMapRow } from "../../core/types";
import type { LeadView } from "../../leads/contracts";
import { PROTO_NOW, makeLead } from "../../leads/test-support";
import { STATUSES, statusById } from "../test-support";
import {
  StatusNotFoundError,
  StatusUnchangedError,
  transition,
  transitionLine,
  type TransitionDeps,
} from "./transition";

/**
 * The transition matrix (brief §4 B4 tests). Every case asserts the SAME two
 * things in the same order: Neon moved FIRST, and Office was touched only on
 * the one branch that may touch it.
 *
 * The Office rail is stubbed at `putProjectFields` — PR1's single project-field
 * writer, which is where the per-project Redis lock, the precision-safe read
 * and the verified re-read all live. What this file pins is that `transition`
 * calls THAT function and no other, with `{stateId}` and nothing else.
 */

const MAPPED: StatusBmiMapRow = {
  statusId: "quote",
  clientKey: "headpinzftmyers",
  bmiStateId: "49130082",
  bmiStateName: "Send Contract",
};

const MINTED = {
  projectId: "63000000009561437",
  projectNumber: "DH2891",
  stateId: "8007473",
  stateName: "Pending Signed",
  personId: "63000000009561438",
  syncedAt: null,
};

interface Recorded {
  order: string[];
  updates: { id: string; patch: Record<string, unknown> }[];
  activities: Record<string, unknown>[];
  put: { clientKey: string; projectId: string; patch: Record<string, unknown> }[];
  reads: number;
}

function harness(
  options: {
    lead?: LeadView;
    mapping?: StatusBmiMapRow | null;
    writesSetting?: unknown;
    putFails?: Error | null;
    /** What a re-read of the project answers, in order. */
    reads?: (Record<string, unknown> | null)[];
    status?: CrmStatus | null;
  } = {},
): { deps: TransitionDeps; rec: Recorded; lead: LeadView } {
  const lead = options.lead ?? makeLead({ id: "1042", status: "contacted", bmi: MINTED });
  const rec: Recorded = { order: [], updates: [], activities: [], put: [], reads: 0 };
  const deps: TransitionDeps = {
    getLead: vi.fn(async () => lead),
    getStatus: vi.fn(async (id: string) =>
      options.status !== undefined && id === "quote"
        ? options.status
        : (STATUSES.find((s) => s.id === id) ?? null),
    ) as unknown as TransitionDeps["getStatus"],
    getStatusMapping: vi.fn(async () =>
      options.mapping === undefined ? MAPPED : options.mapping,
    ) as unknown as TransitionDeps["getStatusMapping"],
    updateLeadFields: vi.fn(async (id: string, patch: Record<string, unknown>) => {
      rec.order.push("neon:lead");
      rec.updates.push({ id, patch });
      return lead;
    }) as unknown as TransitionDeps["updateLeadFields"],
    recordActivity: vi.fn(async (a: Record<string, unknown>) => {
      rec.order.push(`neon:activity:${String(a.kind)}`);
      rec.activities.push(a);
      return "1";
    }) as unknown as TransitionDeps["recordActivity"],
    getSettingValue: vi.fn(async () => options.writesSetting ?? null) as never,
    putProjectFields: vi.fn(
      async (p: { clientKey: string; projectId: string; patch: Record<string, unknown> }) => {
        rec.order.push("office:put");
        rec.put.push(p);
        if (options.putFails) throw options.putFails;
        return { status: 200, project: {} };
      },
    ) as unknown as TransitionDeps["putProjectFields"],
    fetchProjectRawIds: vi.fn(async () => {
      const answer = options.reads?.[rec.reads] ?? null;
      rec.reads += 1;
      rec.order.push("office:read");
      return answer;
    }) as unknown as TransitionDeps["fetchProjectRawIds"],
    now: () => PROTO_NOW,
    sleep: async () => {},
  };
  return { deps, rec, lead };
}

describe("transition — Neon first, always", () => {
  it("writes the status and a `status` activity BEFORE touching Office", async () => {
    const { deps, rec, lead } = harness();
    const out = await transition({ lead, toStatusId: "quote", actor: "kelsea@headpinz.com" }, deps);
    expect(rec.order[0]).toBe("neon:lead");
    expect(rec.order[1]).toBe("neon:activity:status");
    expect(rec.order.indexOf("office:put")).toBeGreaterThan(1);
    expect(rec.updates[0]!.patch).toMatchObject({ statusId: "quote" });
    expect(out.from).toBe("contacted");
    expect(out.status.id).toBe("quote");
  });

  it("the timeline line names both ends and the actor", () => {
    expect(
      transitionLine(statusById("contacted"), statusById("quote"), "kelsea@headpinz.com"),
    ).toBe("Contacted → Quote sent by kelsea@headpinz.com");
  });

  it("refuses an unknown or archived status, and a no-op move", async () => {
    const { deps, lead } = harness({ status: null });
    await expect(
      transition({ lead, toStatusId: "quote", actor: "a@b.c" }, deps),
    ).rejects.toBeInstanceOf(StatusNotFoundError);

    const same = harness({ lead: makeLead({ id: "1", status: "quote", bmi: MINTED }) });
    await expect(
      transition({ lead: same.lead, toStatusId: "quote", actor: "a@b.c" }, same.deps),
    ).rejects.toBeInstanceOf(StatusUnchangedError);
    // Nothing was written on either refusal.
    expect(same.rec.order).toEqual([]);
  });
});

describe("transition — the BMI branch table", () => {
  it("MAPPED + writes on → putProjectFields({stateId}) and the lead records the new state", async () => {
    const { deps, rec, lead } = harness();
    const out = await transition({ lead, toStatusId: "quote", actor: "kelsea@headpinz.com" }, deps);
    expect(rec.put).toEqual([
      {
        clientKey: "headpinzftmyers",
        projectId: "63000000009561437",
        patch: { stateId: "49130082" },
      },
    ]);
    expect(out.bmi).toEqual({
      status: "write",
      stateId: "49130082",
      stateName: "Send Contract",
    });
    const stateWrite = rec.updates.find((u) => "bmiStateId" in u.patch)!;
    expect(stateWrite.patch).toMatchObject({
      bmiStateId: "49130082",
      bmiStateName: "Send Contract",
    });
    expect(rec.activities.some((a) => a.kind === "bmi")).toBe(true);
  });

  it("UNMAPPED → Neon only, no Office call, and a system line saying why", async () => {
    const { deps, rec, lead } = harness({ mapping: null });
    const out = await transition({ lead, toStatusId: "quote", actor: "a@b.c" }, deps);
    expect(out.bmi.status).toBe("unmapped");
    expect(rec.put).toEqual([]);
    expect(rec.order).not.toContain("office:put");
    const why = rec.activities.find((a) => a.kind === "system")!;
    expect(String(why.body)).toContain("no Office state mapped");
  });

  it("PAUSED (the director's Neon toggle) → Neon only, no Office call", async () => {
    const { deps, rec, lead } = harness({ writesSetting: { enabled: false } });
    const out = await transition({ lead, toStatusId: "quote", actor: "a@b.c" }, deps);
    expect(out.bmi.status).toBe("paused");
    expect(rec.put).toEqual([]);
    expect(String(rec.activities.find((a) => a.kind === "system")!.body)).toContain("paused");
  });

  it("PAUSED for ONE centre only pauses that centre", async () => {
    const paused = { enabled: true, offCentres: ["headpinzftmyers"] };
    const fm = harness({ writesSetting: paused });
    expect(
      (await transition({ lead: fm.lead, toStatusId: "quote", actor: "a@b.c" }, fm.deps)).bmi
        .status,
    ).toBe("paused");
    const naples = harness({
      lead: makeLead({ id: "9", status: "contacted", centre: "HPN", bmi: MINTED }),
      writesSetting: paused,
      mapping: { ...MAPPED, clientKey: "headpinznaples" },
    });
    expect(
      (await transition({ lead: naples.lead, toStatusId: "quote", actor: "a@b.c" }, naples.deps))
        .bmi.status,
    ).toBe("write");
  });

  it("a MISSING settings row means writes are ON (R4 — no row = enabled)", async () => {
    const { deps, rec, lead } = harness({ writesSetting: null });
    const out = await transition({ lead, toStatusId: "quote", actor: "a@b.c" }, deps);
    expect(out.bmi.status).toBe("write");
    expect(rec.put).toHaveLength(1);
  });

  it("NO PROJECT → Neon only; there is nothing in Office to move", async () => {
    const { deps, rec, lead } = harness({
      lead: makeLead({
        id: "3",
        status: "contacted",
        bmi: {
          projectId: null,
          projectNumber: null,
          stateId: null,
          stateName: null,
          personId: null,
          syncedAt: null,
        },
      }),
    });
    const out = await transition({ lead, toStatusId: "quote", actor: "a@b.c" }, deps);
    expect(out.bmi.status).toBe("no_project");
    expect(rec.put).toEqual([]);
  });

  it("a BUILT-IN state id is never written from here — that is the cancel path (B5)", async () => {
    const { deps, rec, lead } = harness({
      mapping: { ...MAPPED, bmiStateId: "-4", bmiStateName: "Cancelled" },
    });
    const out = await transition({ lead, toStatusId: "quote", actor: "a@b.c" }, deps);
    expect(out.bmi.status).toBe("builtin");
    expect(rec.put).toEqual([]);
    expect(String(rec.activities.find((a) => a.kind === "system")!.body)).toContain("Contract tab");
  });
});

describe("transition — a 200 is never trusted", () => {
  it("a verify failure is RE-READ, never re-written, and succeeds when Office catches up", async () => {
    const { deps, rec, lead } = harness({
      putFails: new Error("project 63000000009561437 PUT did not land: stateId reads …"),
      // The write propagates to Firebird asynchronously: first read stale, second good.
      reads: [{ stateId: "8007473" }, { stateId: "49130082" }],
    });
    const out = await transition({ lead, toStatusId: "quote", actor: "a@b.c" }, deps);
    expect(out.bmi.status).toBe("write");
    // ONE write attempt, two reads. Never a second PUT.
    expect(rec.put).toHaveLength(1);
    expect(rec.order.filter((o) => o === "office:put")).toHaveLength(1);
    expect(rec.reads).toBe(2);
  });

  it("a state that never reads back → `pending`, the chip, and NO claimed sync", async () => {
    const { deps, rec, lead } = harness({
      putFails: new Error("Office project PUT failed: 500"),
      reads: [{ stateId: "8007473" }, { stateId: "8007473" }, { stateId: "8007473" }],
    });
    const out = await transition({ lead, toStatusId: "quote", actor: "a@b.c" }, deps);
    expect(out.bmi.status).toBe("pending");
    expect(out.bmi.error).toContain("500");
    // The lead's BMI state columns are NOT stamped with a state we cannot prove.
    expect(rec.updates.some((u) => "bmiStateId" in u.patch)).toBe(false);
    expect(rec.activities.some((a) => a.kind === "bmi")).toBe(false);
    expect(String(rec.activities.find((a) => a.kind === "system")!.body)).toContain("sync pending");
    // Neon still moved: the rep's decision is not lost to an Office outage.
    expect(rec.updates[0]!.patch).toMatchObject({ statusId: "quote" });
  });

  it("an unreadable project during confirm is not treated as proof", async () => {
    const { deps, lead } = harness({
      putFails: new Error("boom"),
      reads: [null, null, null],
    });
    const out = await transition({ lead, toStatusId: "quote", actor: "a@b.c" }, deps);
    expect(out.bmi.status).toBe("pending");
  });
});

describe("transition — lost reasons", () => {
  it("records a lost reason on a lost status and clears it on the way back out", async () => {
    const lost = harness({ mapping: null });
    await transition(
      { lead: lost.lead, toStatusId: "lost", actor: "a@b.c", lostReason: "Booked elsewhere" },
      lost.deps,
    );
    expect(lost.rec.updates[0]!.patch).toMatchObject({
      statusId: "lost",
      lostReason: "Booked elsewhere",
    });

    const back = harness({
      lead: makeLead({ id: "5", status: "lost", lostReason: "Booked elsewhere", bmi: MINTED }),
      mapping: null,
    });
    await transition({ lead: back.lead, toStatusId: "quote", actor: "a@b.c" }, back.deps);
    expect(back.rec.updates[0]!.patch).toMatchObject({ statusId: "quote", lostReason: null });
  });
});
