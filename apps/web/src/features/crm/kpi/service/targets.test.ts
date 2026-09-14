import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CrmRep, CrmUser } from "~/features/crm/core/types";

/**
 * Weekly targets: who may write them, and WHEN a written one starts.
 *
 * "Applies from next Monday" is not decoration. `crm_targets` is
 * effective-dated so that raising a target today cannot move the bar under
 * somebody who has already worked four days of the week against the old one —
 * and cannot retrospectively mark last week a failure.
 */

const state = vi.hoisted(() => ({
  reps: [] as unknown[],
  targets: new Map<string, unknown>(),
  upserts: [] as Record<string, unknown>[],
}));

vi.mock("~/features/crm/reps", () => ({
  listReps: async () => state.reps,
  ensureRepsSchema: async () => {},
}));

vi.mock("../data/targets-db", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    ensureTargetsSchema: async () => {},
    targetsAsOf: async () => state.targets,
    upsertTarget: async (input: Record<string, unknown>, actorEmail: string) => {
      state.upserts.push({ ...input, actorEmail });
    },
  };
});

vi.mock("../data/measure-db", () => ({
  ensureMeasureReadable: async () => {},
  touchCounts: async () => [],
  leadsTouched: async () => new Map(),
  responseMinutesByRep: async () => new Map(),
  callsByWeek: async () => [],
}));

const { listTargets, nextMondayEt, saveTarget } = await import("./targets");

const SAT = new Date("2026-09-12T23:30:00Z"); // Saturday 12 Sep, ET
const MON = new Date("2026-09-07T14:00:00Z"); // Monday 7 Sep, ET

function rep(slug: string, role: CrmRep["role"] = "rep"): CrmRep {
  return {
    id: `id-${slug}`,
    slug,
    displayName: `${slug} name`,
    firstName: slug,
    initials: slug.slice(0, 2).toUpperCase(),
    role,
    email: null,
    ssoSub: null,
    bmiUserId: null,
    bmiUserIds: null,
    bmiUsername: null,
    sevenShiftsUserId: null,
    voxDid: null,
    threecxExtension: null,
    teamsChatId: null,
    phoneE164: null,
    centres: [],
    active: true,
    sortOrder: 1,
  };
}

const KELSEA = rep("kelsea");
const GS = rep("gs", "bucket");
const MKT = rep("mkt", "hold");

function user(role: "rep" | "director", mine: CrmRep | null): CrmUser {
  return {
    email: `${mine?.slug ?? role}@headpinz.com`,
    name: "Someone",
    sub: null,
    roles: role === "director" ? ["access", "sales", "sales-director"] : ["access", "sales"],
    role,
    rep: mine,
  };
}

const BODY = {
  repSlug: "kelsea",
  calls: 45,
  texts: 30,
  emails: 25,
  reachouts: 15,
  responseTargetMinutes: 60,
};

beforeEach(() => {
  state.reps = [KELSEA, GS, MKT];
  state.targets = new Map();
  state.upserts = [];
});

describe("nextMondayEt", () => {
  it("is the Monday AFTER the current ET week, not today", () => {
    expect(nextMondayEt(SAT)).toBe("2026-09-14");
    // Even standing on a Monday, it is NEXT Monday: the week in progress keeps
    // the targets it started with.
    expect(nextMondayEt(MON)).toBe("2026-09-14");
  });

  it("does not roll a week early for an ET evening that is tomorrow in UTC", () => {
    expect(nextMondayEt(new Date("2026-09-13T01:00:00Z"))).toBe("2026-09-14");
  });
});

describe("listTargets", () => {
  it("gives a rep only their own row", async () => {
    const out = await listTargets(user("rep", KELSEA), SAT);
    expect(out.targets.map((t) => t.repSlug)).toEqual(["kelsea"]);
    expect(out.reps.map((r) => r.slug)).toEqual(["kelsea"]);
  });

  it("gives a director the whole measurable roster", async () => {
    const out = await listTargets(user("director", null), SAT);
    expect(out.targets.map((t) => t.repSlug)).toEqual(["kelsea", "gs"]);
  });

  it("falls back to the defaults, flagged as defaults, when nobody has set one", async () => {
    const out = await listTargets(user("director", null), SAT);
    expect(out.targets[0].target.calls).toBe(40);
    expect(out.targets[1].target.calls).toBe(60); // the bucket's own
    // `effectiveFrom: null` is how the screen knows not to imply a director set it.
    expect(out.targets[0].target.effectiveFrom).toBeNull();
  });
});

describe("saveTarget", () => {
  it("refuses a rep, in the service and not only in the route", async () => {
    // A job, a script or another service must not be able to get round the
    // route's `{director: true}` by not being HTTP.
    await expect(saveTarget(user("rep", KELSEA), BODY, SAT)).rejects.toMatchObject({
      status: 403,
      message: "director_only",
    });
    expect(state.upserts).toHaveLength(0);
  });

  it("writes from NEXT Monday by default", async () => {
    await saveTarget(user("director", null), BODY, SAT);
    expect(state.upserts[0]).toMatchObject({
      repId: "id-kelsea",
      effectiveFrom: "2026-09-14",
      calls: 45,
      actorEmail: "director@headpinz.com",
    });
  });

  it("REFUSES a date that is not a Monday", async () => {
    // Starting mid-week would measure a week already half run against a bar
    // nobody saw on Monday morning.
    await expect(
      saveTarget(user("director", null), { ...BODY, effectiveFrom: "2026-09-16" }, SAT),
    ).rejects.toMatchObject({ status: 400, message: "effective_from_must_be_monday" });
    expect(state.upserts).toHaveLength(0);
  });

  it("accepts an explicit Monday, including a past one for a correction", async () => {
    await saveTarget(user("director", null), { ...BODY, effectiveFrom: "2026-09-07" }, SAT);
    expect(state.upserts[0]).toMatchObject({ effectiveFrom: "2026-09-07" });
  });

  it("refuses an unknown rep rather than writing a target nobody owns", async () => {
    await expect(
      saveTarget(user("director", null), { ...BODY, repSlug: "nobody" }, SAT),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("refuses the Marketing hold row — it is not a rep who works leads", async () => {
    await expect(
      saveTarget(user("director", null), { ...BODY, repSlug: "mkt" }, SAT),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("clamps an absurd number instead of storing it", async () => {
    await saveTarget(user("director", null), { ...BODY, calls: 999_999 }, SAT);
    expect(state.upserts[0].calls).toBe(2000);
  });

  it("keeps the response target inside a day", async () => {
    await saveTarget(user("director", null), { ...BODY, responseTargetMinutes: 99_999 }, SAT);
    expect(state.upserts[0].responseTargetMinutes).toBe(1440);
  });
});
