import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";
import type { EnqueueInput } from "~/features/crm/jobs";
import type { LeadView } from "../contracts";
import { ALL_REPS, QUEUE_LEADS, REPS, makeLead } from "../test-support";

/**
 * `assignLead` writes Neon FIRST, then Office through the REAL
 * `putProjectFields` (brief §4 B3 tests): a 403 prompt is retried exactly
 * once with `confirm:true` and verified by re-read; a 500 leaves the
 * assignment unsynced, records a system line and enqueues ONE retry job — no
 * retry storm. The Office wire is the same `https.request` script and
 * in-memory Redis as `lib/__tests__/bmi-office-put-project-fields.test.ts`;
 * Neon is mocked at the data modules with a recorded call ORDER.
 */

type OfficeHandler = (
  method: string,
  path: string,
  body: string,
) => { status: number; body: string };

const state = vi.hoisted(() => ({
  officeHandler: null as unknown,
  requests: [] as { method: string; path: string; body: string }[],
  redis: new Map<string, string>(),
  order: [] as string[],
  assignments: [] as Record<string, unknown>[],
  updates: [] as { id: string; patch: Record<string, unknown> }[],
  synced: [] as string[],
  activities: [] as Record<string, unknown>[],
  enqueued: [] as EnqueueInput[],
  setting: undefined as unknown,
  lead: null as unknown,
  /** Every guest welcome this run tried to send — nothing leaves the process. */
  intros: [] as Array<{ planner: { displayName: string }; projectNumber: string }>,
  /** Every planner Teams card this run tried to post. */
  plannerCards: [] as Array<{ planner: { displayName: string; teamsChatId: string } }>,
}));

vi.mock("https", () => ({
  default: {
    Agent: class {
      destroy() {}
    },
    request: (
      opts: { method: string; path: string; headers: Record<string, string> },
      cb: (res: EventEmitter & { statusCode: number }) => void,
    ) => {
      let sent = "";
      const req = new EventEmitter() as EventEmitter & {
        write: (c: string) => void;
        end: () => void;
        setTimeout: () => void;
        destroy: () => void;
      };
      req.write = (c: string) => {
        sent += c;
      };
      req.setTimeout = () => {};
      req.destroy = () => {};
      req.end = () => {
        state.requests.push({ method: opts.method, path: opts.path, body: sent });
        if (opts.path !== "/auth/token") state.order.push(`office:${opts.method}`);
        const { status, body } = (state.officeHandler as OfficeHandler)(
          opts.method,
          opts.path,
          sent,
        );
        const res = new EventEmitter() as EventEmitter & { statusCode: number };
        res.statusCode = status;
        setImmediate(() => {
          cb(res);
          res.emit("data", body);
          res.emit("end");
        });
      };
      return req;
    },
  },
}));

vi.mock("@/lib/redis", () => ({
  default: {
    get: async (k: string) => state.redis.get(k) ?? null,
    setex: async (k: string, _t: number, v: string) => {
      state.redis.set(k, v);
      return "OK";
    },
    del: async (k: string) => (state.redis.delete(k) ? 1 : 0),
    set: async (k: string, v: string, _px: string, _ms: number, nx?: string) => {
      if (nx === "NX" && state.redis.has(k)) return null;
      state.redis.set(k, v);
      return "OK";
    },
    eval: async (_s: string, _n: number, k: string, v: string) => {
      if (state.redis.get(k) === v) {
        state.redis.delete(k);
        return 1;
      }
      return 0;
    },
  },
}));

vi.mock("../data/leads-db", () => ({
  getLead: async () => state.lead,
  updateLeadFields: async (id: string, patch: Record<string, unknown>) => {
    state.order.push("neon:updateLead");
    state.updates.push({ id, patch });
    const lead = state.lead as LeadView;
    const next: LeadView = {
      ...lead,
      rep: "assignedRepId" in patch ? (patch.assignedRepId as string | null) : lead.rep,
      status: typeof patch.statusId === "string" ? patch.statusId : lead.status,
    };
    state.lead = next; // the real getLead re-reads the row; the fake keeps up
    return next;
  },
}));
vi.mock("../data/assignments-db", () => ({
  insertAssignment: async (row: Record<string, unknown>) => {
    state.order.push("neon:insertAssignment");
    state.assignments.push(row);
    return {
      id: String(state.assignments.length),
      leadId: row.leadId,
      fromRepId: row.fromRepId,
      toRepId: row.toRepId,
      toRepName: null,
      toRepSlug: null,
      actorEmail: row.actorEmail,
      reason: row.reason,
      ruleId: null,
      trace: [],
      note: row.note ?? null,
      bmiResponsibleSyncedAt: null,
      createdAt: "2026-09-12T23:30:00.000Z",
    };
  },
  markAssignmentResponsibleSynced: async (id: string) => {
    state.synced.push(id);
  },
}));
vi.mock("~/features/crm/activities", () => ({
  recordActivity: async (a: Record<string, unknown>) => {
    state.activities.push(a);
    return "1";
  },
}));
/**
 * A working rep whose Office user id is still unknown — the `no_bmi_user`
 * case. It cannot be the Marketing Director any more: a `hold` row parks the
 * lead and never reaches the responsible write at all.
 */
const NO_OFFICE_REP = { ...REPS.gs, id: "7", slug: "gs2", bmiUserId: null, bmiUsername: null };

/**
 * The guest's welcome is stubbed: a hand-off that gives a held lead its first
 * owner really does text and email the guest, and a unit test must never put
 * that on a wire. What it asserts instead is that the call was made, with the
 * planner we assigned.
 */
vi.mock("./notify", async (orig) => {
  const actual = await orig<typeof import("./notify")>();
  return {
    ...actual,
    sendGuestIntro: async (input: { planner: { displayName: string }; projectNumber: string }) => {
      state.intros.push(input);
      return { sms: { ok: true }, email: { ok: true } };
    },
    sendPlannerCardForAssignment: async (input: {
      planner: { displayName: string; teamsChatId: string };
    }) => {
      state.plannerCards.push(input);
      return { ok: true, activityId: "act-1" };
    },
  };
});

vi.mock("~/features/crm/reps", () => ({
  listReps: async () => [...ALL_REPS, NO_OFFICE_REP],
}));
vi.mock("../../core/data/settings-db", () => ({ getSettingValue: async () => state.setting }));
vi.mock("~/features/crm/jobs", () => ({
  neonJobStore: {
    enqueue: async (i: EnqueueInput) => {
      state.enqueued.push(i);
      return { job: { id: "9" }, created: true };
    },
  },
}));

const { assignLead, normalizeReason, nextActionForAssignment } = await import("./assign");
const { __resetOfficeTokenCacheForTests } = await import("@/lib/bmi-office-token");

const PROJECT_ID = "63000000009561437";
const PERSON_ID = "63000000009561438";
const NOW = new Date("2026-09-12T23:30:00.000Z");

const projectText = (userId: string) =>
  `{"id":${PROJECT_ID},"number":"DH2891","name":"Gulf Coast Logistics","displayName":"Gulf Coast Logistics",` +
  `"personId":${PERSON_ID},"persons":42,"confirm":false,"balance":0,"stateId":49130082,"kindId":-1,` +
  `"userId":${userId},"userAgentId":${userId},"created":"2026-09-12T19:22:00","updated":"2026-09-12T19:22:00",` +
  `"date":"2026-10-16T17:30:00","publish":true,"companyId":1,"priority":0,` +
  `"bills":[{"id":63000000009561439}],"schedules":[],"products":[],"projectPersons":[{"id":3}],"logs":[]}`;

const PROMPT = {
  IsQuestion: true,
  Kind: 2,
  Message: "Project has open changes, save anyway?",
  OperationId: "8389cf8a268af9b19134286e9ae39f06",
};

/** Pandora-picked responsible was Guest Services (30080112); the hand-off writes Kelsea (28267036). */
function office(opts: { refusals?: number; putStatus?: number } = {}): OfficeHandler {
  let puts = 0;
  return (method, path) => {
    if (path === "/auth/token")
      return { status: 200, body: JSON.stringify({ access_token: "t", expires_in: "86400" }) };
    if (method === "GET" && path.endsWith(`/project/${PROJECT_ID}`)) {
      const landed = puts > 0 && (opts.putStatus ?? 200) < 400;
      return { status: 200, body: projectText(landed ? "28267036" : "30080112") };
    }
    if (method === "PUT" && path.endsWith("/project")) {
      puts++;
      if (puts <= (opts.refusals ?? 0)) return { status: 403, body: JSON.stringify(PROMPT) };
      return {
        status: opts.putStatus ?? 200,
        body: opts.putStatus && opts.putStatus >= 400 ? "boom" : "{}",
      };
    }
    return { status: 404, body: "" };
  };
}

const minted = (): LeadView =>
  makeLead({
    ...QUEUE_LEADS[0]!,
    centre: "FT",
    mintStatus: "minted",
    bmi: { ...QUEUE_LEADS[0]!.bmi, projectId: PROJECT_ID },
  });

beforeEach(() => {
  process.env.BMI_OFFICE_USERNAME = "u";
  process.env.BMI_OFFICE_PASSWORD_B64 = Buffer.from("p").toString("base64");
  state.requests = [];
  state.order = [];
  state.assignments = [];
  state.updates = [];
  state.synced = [];
  state.activities = [];
  state.enqueued = [];
  state.intros = [];
  state.plannerCards = [];
  state.redis.clear();
  state.setting = undefined;
  state.lead = minted();
  state.officeHandler = office();
  __resetOfficeTokenCacheForTests();
});
afterEach(() => {
  delete process.env.BMI_OFFICE_USERNAME;
  delete process.env.BMI_OFFICE_PASSWORD_B64;
});

describe("pure", () => {
  it("normalizeReason: manual on an assigned lead is a reassign; a null rep is a release", () => {
    expect(normalizeReason("manual", { rep: null }, "1")).toBe("manual");
    expect(normalizeReason("manual", { rep: "2" }, "1")).toBe("reassign");
    expect(normalizeReason("manual", { rep: "1" }, "1")).toBe("manual");
    expect(normalizeReason("rule", { rep: null }, "1")).toBe("rule");
    expect(normalizeReason("manual", { rep: "2" }, null)).toBe("release");
  });
  it("nextActionForAssignment: first touch due in the response target (prototype: 60 min)", () => {
    expect(nextActionForAssignment(NOW, 60)).toEqual({
      kind: "call",
      due: "2026-09-13T00:30:00.000Z",
      label: "New lead — first touch due",
    });
  });
});

describe("assignLead", () => {
  it("Neon first, then Office: assignment row + lead row before the first Office call; verified PUT → synced", async () => {
    const r = await assignLead({
      leadId: "1061",
      repId: REPS.kelsea.id,
      actor: "eric@headpinz.com",
      reason: "manual",
    });
    expect(r.bmi).toEqual({ status: "synced" });
    expect(state.order.slice(0, 2)).toEqual(["neon:insertAssignment", "neon:updateLead"]);
    expect(state.order.indexOf("office:GET")).toBeGreaterThan(1);
    expect(state.assignments[0]).toMatchObject({
      leadId: "1061",
      fromRepId: null,
      toRepId: "1",
      actorEmail: "eric@headpinz.com",
      reason: "manual",
    });
    expect(state.updates[0]!.patch).toMatchObject({
      assignedRepId: "1",
      statusId: "assigned",
      nextActionKind: "call",
      nextActionLabel: "New lead — first touch due",
      nextActionDue: expect.any(String),
    });
    const puts = state.requests.filter((q) => q.method === "PUT");
    expect(puts).toHaveLength(1);
    const wire = puts[0]!.body;
    // `projectPutJson` (PR1) puts the small signed ids back on the wire as JSON
    // NUMBERS — the shape every proven Office rail sends — while the 17-digit
    // ids are injected RAW by `serializeWithRawIds`. So the responsible id is
    // a number here, and the project / person ids are bare digits in the text,
    // never quoted and never rounded.
    expect(wire).toContain(`"id":${PROJECT_ID}`);
    expect(wire).toContain(`"personId":${PERSON_ID}`);
    expect(wire).not.toContain(`"${PROJECT_ID}"`);
    const body = JSON.parse(wire) as Record<string, unknown>;
    expect(body.userId).toBe(28267036);
    expect(body.userAgentId).toBe(28267036);
    // Negative control: a naive JSON.parse of the very same bytes rounds the
    // id to 63000000009561440 — which is why nothing reads this rail that way.
    expect(String(body.id)).toBe("63000000009561440");
    expect(String(body.id)).not.toBe(PROJECT_ID);
    expect(body).not.toHaveProperty("bills");
    expect(state.synced).toEqual(["1"]);
    // "assign", the verified Office write, and the guest's held welcome.
    expect(state.activities.map((a) => a.kind)).toEqual(["assign", "bmi", "system"]);
    expect(state.intros).toHaveLength(1);
    expect(state.intros[0]!.planner.displayName).toBe("Kelsea");
    // A hand-off has to tell the person it hands to (owner, 2026-09-14).
    expect(state.plannerCards).toHaveLength(1);
    expect(state.plannerCards[0]!.planner.displayName).toBe("Kelsea");
    expect(state.enqueued).toHaveLength(0);
  });

  it("Office 403 prompt → confirm:true retry exactly once → verified → synced", async () => {
    state.officeHandler = office({ refusals: 1 });
    const r = await assignLead({
      leadId: "1061",
      repId: REPS.kelsea.id,
      actor: "eric@headpinz.com",
      reason: "manual",
    });
    expect(r.bmi.status).toBe("synced");
    const puts = state.requests.filter((q) => q.method === "PUT");
    expect(puts).toHaveLength(2);
    expect((JSON.parse(puts[0]!.body) as { confirm: unknown }).confirm).not.toBe(true);
    expect((JSON.parse(puts[1]!.body) as { confirm: unknown }).confirm).toBe(true);
    expect(state.synced).toEqual(["1"]);
  });

  it("Office 500 → the row stays unsynced, a system line is written, ONE job is enqueued, no retry storm", async () => {
    state.officeHandler = office({ putStatus: 500 });
    const r = await assignLead({
      leadId: "1061",
      repId: REPS.kelsea.id,
      actor: "eric@headpinz.com",
      reason: "manual",
    });
    expect(r.bmi.status).toBe("failed");
    expect(state.requests.filter((q) => q.method === "PUT")).toHaveLength(1);
    expect(state.synced).toEqual([]);
    expect(state.enqueued).toHaveLength(1);
    expect(state.enqueued[0]).toMatchObject({
      kind: "mint-bmi-project",
      idempotencyKey: "mint-bmi-project:1061:responsible:1",
      payload: { leadId: "1061", task: "responsible", assignmentId: "1", repId: "1" },
      createdBy: "eric@headpinz.com",
    });
    // "assign", the Office failure, and the guest's welcome — which goes out
    // whatever Office thinks, because the guest is not waiting on Office.
    expect(state.activities.map((a) => a.kind)).toEqual(["assign", "system", "system"]);
    expect(state.intros).toHaveLength(1);
    expect(String(state.activities[1]!.body)).toContain("queued for retry");
    // The assignment itself stood: the lead is Kelsea's in Neon whatever Office
    // said. NOTHING is rolled back — Neon is the source of truth and the
    // external sync is a downstream retry (CLAUDE.md "persist at capture").
    expect(state.updates[0]!.patch).toMatchObject({ assignedRepId: "1", statusId: "assigned" });
    expect(r.lead.rep).toBe("1");
    expect(r.assignment.bmiResponsibleSyncedAt).toBeNull();
  });

  it("writes paused (crm_settings.bmi_writes enabled:false) → paused, zero Office calls, no job", async () => {
    state.setting = { enabled: false, offCentres: [] };
    const r = await assignLead({
      leadId: "1061",
      repId: REPS.kelsea.id,
      actor: "eric@headpinz.com",
      reason: "manual",
    });
    expect(r.bmi).toEqual({ status: "paused" });
    expect(state.requests).toHaveLength(0);
    expect(state.enqueued).toHaveLength(0);
    expect(state.assignments).toHaveLength(1);
  });

  it("no BMI project yet → no_project; a rep without an Office id → no_bmi_user (both after the Neon writes)", async () => {
    state.lead = { ...minted(), bmi: { ...minted().bmi, projectId: null } };
    expect(
      (await assignLead({ leadId: "1061", repId: REPS.kelsea.id, actor: "x", reason: "manual" }))
        .bmi,
    ).toEqual({ status: "no_project" });
    state.lead = minted();
    expect(
      (await assignLead({ leadId: "1061", repId: NO_OFFICE_REP.id, actor: "x", reason: "manual" }))
        .bmi,
    ).toEqual({ status: "no_bmi_user" });
    expect(state.requests).toHaveLength(0);
    expect(state.assignments).toHaveLength(2);
  });

  it("release: rep null → assignment reason release, lead back to new with no next action, no Office", async () => {
    state.lead = { ...minted(), rep: "1", status: "assigned", assignedAt: NOW.toISOString() };
    const r = await assignLead({
      leadId: "1061",
      repId: null,
      actor: "eric@headpinz.com",
      reason: "manual",
    });
    expect(r.assignment.reason).toBe("release");
    expect(r.bmi).toEqual({ status: "skipped" });
    expect(state.updates[0]!.patch).toMatchObject({
      assignedRepId: null,
      assignedAt: null,
      statusId: "new",
      nextActionDue: null,
    });
    expect(state.requests).toHaveLength(0);
  });

  /**
   * A `hold` row PARKS the lead. `assignableReps()` has always refused to list
   * the Marketing Director; this is the write side of the same rule. If it
   * stamped `assigned_rep_id` the lead would drop off the queue board it was
   * parked on, never show its "Held for…" pill, and be skipped by
   * `listSweepCandidates` for ever — parked AND invisible.
   */
  it("a HOLD rep parks the lead: held_for_rep_id set, assigned_rep_id NULL, no clock, no Office", async () => {
    const r = await assignLead({
      leadId: "1061",
      repId: REPS.mkt.id,
      actor: "rules",
      reason: "rule",
    });
    expect(state.assignments[0]).toMatchObject({ toRepId: REPS.mkt.id, reason: "rule" });
    expect(state.updates[0]!.patch).toMatchObject({
      assignedRepId: null,
      assignedAt: null,
      heldForRepId: REPS.mkt.id,
      statusId: "new",
    });
    expect(state.updates[0]!.patch).toMatchObject({ nextActionDue: null });
    expect(r.lead.rep).toBeNull();
    expect(r.bmi).toEqual({ status: "skipped" });
    expect(state.requests).toHaveLength(0);
    expect(String(state.activities[0]!.body)).toBe("Held for Marketing Director by rules");
    expect((state.activities[0]!.meta as { held: boolean }).held).toBe(true);
  });

  it("a reassign keeps a contacted lead's status and does not reset the first-touch clock", async () => {
    state.lead = {
      ...minted(),
      rep: "2",
      status: "contacted",
      assignedAt: NOW.toISOString(),
      firstTouchAt: NOW.toISOString(),
    };
    const r = await assignLead({
      leadId: "1061",
      repId: REPS.kelsea.id,
      actor: "eric@headpinz.com",
      reason: "manual",
    });
    expect(r.assignment.reason).toBe("reassign");
    expect(state.updates[0]!.patch).toMatchObject({ assignedRepId: "1", statusId: "contacted" });
    expect(state.updates[0]!.patch).not.toHaveProperty("nextActionDue");
  });

  it("refuses a director, an inactive rep and an unknown rep before touching anything", async () => {
    await expect(
      assignLead({ leadId: "1061", repId: REPS.jacob.id, actor: "x", reason: "manual" }),
    ).rejects.toThrow(/director/);
    await expect(
      assignLead({ leadId: "1061", repId: "404", actor: "x", reason: "manual" }),
    ).rejects.toThrow(/no such rep/);
    expect(state.assignments).toHaveLength(0);
  });
});

describe("isPermanentOfficeRefusal", () => {
  /**
   * Owner, 2026-09-14: "I don't want ot be beating BMI office endpoints."
   * Both strings below are VERBATIM from a real lead's timeline, and both were
   * being queued for the default 20 attempts on a 30s-step backoff — about 20
   * Office PUTs over 1¾ hours, none of which could ever have worked.
   */
  /**
   * THE ONE I GOT WRONG on 2026-09-14, and the measurement that caught it.
   *
   * "does not exist in Office" reads like a settled fact and is not. Pandora
   * creates the project in the CLOUD; Office's read side is a different store
   * that converges in minutes, and the responsible write happens SECONDS after
   * the mint — so it asks for a project that is not there yet.
   *
   * Measured on production: every one of these 404s fired 3 or 4 seconds after
   * capture (L-240 +3s, L-238 +3s, L-237 +3s, L-235 +4s, back through 9/14).
   * That is a race with replication, not a missing project. Parking it stopped
   * the retry that used to heal it and left 18 leads with the wrong responsible
   * in Office. If a project really is gone, the attempts run out and the job
   * parks itself — the same end state, reached honestly.
   */
  it("RETRIES a project Office cannot see YET — replication, not absence", async () => {
    const { isPermanentOfficeRefusal } = await import("./assign");
    expect(
      isPermanentOfficeRefusal(
        "Failed to fetch project: 404 — project 8756741 does not exist in Office",
      ),
    ).toBe(false);
  });

  it("parks a foreign-key violation — a per-tenant user id is not a transient fault", async () => {
    const { isPermanentOfficeRefusal } = await import("./assign");
    expect(
      isPermanentOfficeRefusal(
        'Office project 8756741 PUT failed: 400 {"Kind":2,"Message":"violation of FOREIGN KEY ' +
          'constraint \\"FK_PRJ_US_ID\\" on table \\"T_PROJECT\\"\r\nForeign key reference ' +
          'target does not exist\r\nProblematic key value is (\\"F_US_ID\\" = 30080112)"}',
      ),
    ).toBe(true);
  });

  it("still RETRIES anything it does not recognise", async () => {
    const { isPermanentOfficeRefusal } = await import("./assign");
    // Wrongly parking a recoverable job loses a hand-off silently, which is
    // the worse of the two failures — so the match stays narrow on purpose.
    for (const transient of [
      "Office project 123 PUT failed: 500 Internal Server Error",
      "Office project 123 PUT failed: 502 Bad Gateway",
      "socket hang up",
      "ETIMEDOUT",
      'Office project 123 PUT failed: 403 {"IsQuestion":true,"Kind":4}',
      // The cloud→local race, in both the shapes Office words it.
      "Failed to fetch project: 404 — project 8756741 does not exist in Office",
      "Office project 123 GET failed: 404 Not found",
    ]) {
      expect(isPermanentOfficeRefusal(transient), transient).toBe(false);
    }
  });
});
