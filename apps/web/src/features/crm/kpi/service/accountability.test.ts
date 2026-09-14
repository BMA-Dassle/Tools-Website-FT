import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CrmRep, CrmUser } from "~/features/crm/core/types";

/**
 * Accountability, and above all WHO MAY SEE WHAT.
 *
 * The brief is explicit that this is enforced in the route, not by hiding UI
 * — so the test that matters is that a REP asking for a COLLEAGUE'S numbers
 * does not get them, however the request is shaped. Hiding the team table in
 * the component would satisfy a screenshot and leak the JSON.
 *
 * Neon is mocked at the data modules; nothing here touches a database.
 */

const state = vi.hoisted(() => ({
  reps: [] as unknown[],
  targets: new Map<string, unknown>(),
  touches: [] as unknown[],
  touched: new Map<string, number>(),
  responses: new Map<string, number[]>(),
  weekly: [] as unknown[],
  touchFilters: [] as { from: string; until: string }[],
  hosts: { hosts: 0, remaining: 0 },
  hostFilters: [] as { from: string; until: string }[],
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
    upsertTarget: async () => {},
  };
});

vi.mock("../data/measure-db", () => ({
  ensureMeasureReadable: async () => {},
  touchCounts: async (f: { from: string; until: string }) => {
    state.touchFilters.push(f);
    return state.touches;
  },
  leadsTouched: async () => state.touched,
  responseMinutesByRep: async () => state.responses,
  callsByWeek: async () => state.weekly,
  lastYearHostCounts: async (f: { from: string; until: string }) => {
    state.hostFilters.push(f);
    return state.hosts;
  },
}));

const {
  accountability,
  measurableRoster,
  myWeek,
  pctOf,
  reachOutProgress,
  visibleRoster,
  worstBehind,
} = await import("./accountability");

const NOW = new Date("2026-09-12T23:30:00Z"); // Saturday 12 Sep, ET

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
const LORI = rep("lori");
const GS = rep("gs", "bucket");
const MKT = rep("mkt", "hold");
const JACOB = rep("jacob", "director");

function user(role: "rep" | "director", mine: CrmRep | null): CrmUser {
  return {
    email: `${mine?.slug ?? role}@headpinz.com`,
    name: mine?.displayName ?? "Director",
    sub: null,
    roles: role === "director" ? ["access", "sales", "sales-director"] : ["access", "sales"],
    role,
    rep: mine,
  };
}

beforeEach(() => {
  state.reps = [KELSEA, LORI, GS, MKT, JACOB];
  state.targets = new Map([
    [
      "id-kelsea",
      {
        calls: 40,
        texts: 30,
        emails: 25,
        reachouts: 15,
        responseTargetMinutes: 60,
        effectiveFrom: "2026-09-07",
      },
    ],
    [
      "id-lori",
      {
        calls: 40,
        texts: 30,
        emails: 25,
        reachouts: 15,
        responseTargetMinutes: 60,
        effectiveFrom: "2026-09-07",
      },
    ],
  ]);
  state.touches = [
    { repId: "id-kelsea", channel: "call", touches: 38, leads: 20 },
    { repId: "id-kelsea", channel: "sms", touches: 30, leads: 18 },
    { repId: "id-lori", channel: "call", touches: 18, leads: 9 },
    { repId: "id-lori", channel: "reachout", touches: 4, leads: 4 },
    // The call-centre bucket is comfortably ahead, so the banner is about the
    // two salespeople rather than about an idle bucket row.
    { repId: "id-gs", channel: "call", touches: 55, leads: 40 },
    { repId: "id-gs", channel: "reachout", touches: 18, leads: 18 },
  ];
  state.touched = new Map([
    ["id-kelsea", 24],
    ["id-lori", 11],
  ]);
  state.responses = new Map([
    ["id-kelsea", [20, 40, 30]],
    ["id-lori", [80, 71, 62]],
  ]);
  state.weekly = [
    { repId: "id-kelsea", weekStart: "2026-08-17", calls: 30 },
    { repId: "id-kelsea", weekStart: "2026-09-07", calls: 38 },
  ];
  state.touchFilters = [];
  state.hosts = { hosts: 118, remaining: 96 };
  state.hostFilters = [];
});

describe("rosters", () => {
  it("measures people and the Guest Services bucket, never the Marketing hold row or a director", () => {
    const r = measurableRoster([KELSEA, LORI, GS, MKT, JACOB]).map((x) => x.slug);
    expect(r).toEqual(["kelsea", "lori", "gs"]);
  });

  it("a director sees everyone; a rep sees only themselves", () => {
    expect(
      visibleRoster(user("director", null), state.reps as CrmRep[]).map((r) => r.slug),
    ).toEqual(["kelsea", "lori", "gs"]);
    expect(visibleRoster(user("rep", KELSEA), state.reps as CrmRep[]).map((r) => r.slug)).toEqual([
      "kelsea",
    ]);
  });

  it("a sales user with no rep row sees nobody, not everybody", () => {
    expect(visibleRoster(user("rep", null), state.reps as CrmRep[])).toEqual([]);
  });
});

describe("visibility, enforced in the service", () => {
  it("a rep gets only their own row", async () => {
    const out = await accountability(user("rep", KELSEA), { now: NOW });
    expect(out.reps.map((r) => r.slug)).toEqual(["kelsea"]);
  });

  it("IGNORES a ?rep= naming a colleague — it does not obey it and does not 500", async () => {
    const out = await accountability(user("rep", KELSEA), { rep: "lori", now: NOW });
    expect(out.reps.map((r) => r.slug)).toEqual(["kelsea"]);
    expect(JSON.stringify(out)).not.toContain("lori name");
  });

  it("honours ?rep= for a director", async () => {
    const out = await accountability(user("director", null), { rep: "lori", now: NOW });
    expect(out.reps.map((r) => r.slug)).toEqual(["lori"]);
  });

  it("gives a rep no 'behind' banner — that is the director's view of the team", async () => {
    const out = await accountability(user("rep", LORI), { now: NOW });
    expect(out.behind).toBeNull();
  });
});

describe("counts and targets", () => {
  it("maps channels onto the four meters, zero for a channel with no rows", async () => {
    const out = await accountability(user("rep", KELSEA), { now: NOW });
    expect(out.reps[0].actual).toMatchObject({
      calls: 38,
      texts: 30,
      emails: 0,
      reachouts: 0,
      leadsTouched: 24,
    });
  });

  it("uses the median response, not the mean", async () => {
    const out = await accountability(user("rep", KELSEA), { now: NOW });
    expect(out.reps[0].actual.medianResponseMinutes).toBe(30);
  });

  it("gives a rep with no target row the defaults, and the bucket its own", async () => {
    state.targets = new Map();
    const out = await accountability(user("director", null), { now: NOW });
    const kelsea = out.reps.find((r) => r.slug === "kelsea");
    const gs = out.reps.find((r) => r.slug === "gs");
    expect(kelsea?.target.calls).toBe(40);
    expect(gs?.target.calls).toBe(60);
    // A default is flagged as such — the screen must not imply a director set it.
    expect(kelsea?.target.effectiveFrom).toBeNull();
  });

  it("scales a weekly target by the number of weeks in the range", async () => {
    const week = await accountability(user("rep", KELSEA), { range: "week", now: NOW });
    const four = await accountability(user("rep", KELSEA), { range: "4w", now: NOW });
    expect(week.reps[0].target.calls).toBe(40);
    expect(four.reps[0].target.calls).toBe(160);
    // The response target is a duration, not a quantity: it does NOT scale.
    expect(four.reps[0].target.responseTargetMinutes).toBe(60);
  });

  it("reads the activity rows over the window it reports", async () => {
    await accountability(user("director", null), { range: "last", now: NOW });
    expect(state.touchFilters.at(-1)).toEqual({ from: "2026-08-31", until: "2026-09-06" });
  });

  it("builds the four-week sparkline oldest first, zero-filling silent weeks", async () => {
    const out = await accountability(user("rep", KELSEA), { now: NOW });
    expect(out.reps[0].actual.trend).toEqual([30, 0, 0, 38]);
  });
});

/**
 * Same-time-last-year reach-outs moved here from the KPI dashboard (owner,
 * 2026-09-13). The tests that matter are that the numerator comes off the rows
 * this service ALREADY read — the whole reason for moving it rather than
 * copying it — and that it stays team-wide when the roster is narrowed.
 */
describe("same-time-last-year reach-outs", () => {
  it("sums the reach-out channel off the touch rows, with last year's hosts as the denominator", async () => {
    const out = await accountability(user("director", null), { now: NOW });
    // Lori 4 + Guest Services 18. Kelsea logged calls and texts, not reach-outs.
    expect(out.reachOuts).toEqual({ done: 22, hosts: 118, remaining: 96 });
  });

  it("looks last year's hosts up over the SAME days, one year back", async () => {
    await accountability(user("director", null), { range: "last", now: NOW });
    // The window it reports is 2026-08-31 → 2026-09-06.
    expect(state.hostFilters.at(-1)).toEqual({ from: "2025-08-31", until: "2025-09-06" });
  });

  it("stays team-wide when the roster is narrowed to one person", async () => {
    // A rep's page shows their own meters, but the reach-out list belongs to
    // nobody: "4 of 118" on Lori's page would read as the team in freefall.
    const out = await accountability(user("rep", LORI), { now: NOW });
    expect(out.reps.map((r) => r.slug)).toEqual(["lori"]);
    expect(out.reachOuts.done).toBe(22);
  });

  it("reports an empty list honestly rather than dividing by zero", () => {
    expect(reachOutProgress([], { hosts: 0, remaining: 0 })).toEqual({
      done: 0,
      hosts: 0,
      remaining: 0,
    });
    expect(pctOf(0, 0)).toBe(0);
  });

  it("counts only the reach-out channel, never calls or texts", () => {
    const rows = [
      { repId: "a", channel: "call", touches: 40, leads: 20 },
      { repId: "a", channel: "reachout", touches: 6, leads: 6 },
      { repId: "b", channel: "sms", touches: 12, leads: 9 },
      { repId: "b", channel: "reachout", touches: 3, leads: 3 },
    ];
    expect(reachOutProgress(rows, { hosts: 20, remaining: 11 }).done).toBe(9);
  });
});

describe("worstBehind", () => {
  it("names the rep who has done least of the work the two targets ask for", async () => {
    // Lori: 18 calls + 4 reach-outs of 55 asked = 40%.
    // Kelsea: 38 + 0 of 55 = 69% — ahead, despite a reach-out column at zero.
    const out = await accountability(user("director", null), { now: NOW });
    expect(out.behind?.slug).toBe("lori");
    expect(out.behind?.callsPct).toBe(45);
    expect(out.behind?.reachoutsPct).toBe(27);
  });

  it("does not name someone whose only gap is one column not yet started", async () => {
    // The rule this replaced scored the WORSE of the two percentages, so a rep
    // at 95% of calls with an untouched reach-out column scored 0 and was
    // named ahead of a colleague genuinely adrift.
    state.touches = [{ repId: "id-kelsea", channel: "call", touches: 40, leads: 20 }];
    state.targets = new Map([
      [
        "id-kelsea",
        {
          calls: 40,
          texts: 30,
          emails: 25,
          reachouts: 15,
          responseTargetMinutes: 60,
          effectiveFrom: "2026-09-07",
        },
      ],
    ]);
    state.reps = [KELSEA, JACOB];
    const out = await accountability(user("director", null), { now: NOW });
    expect(out.behind).toBeNull();
  });

  it("ignores a rep with no target at all rather than calling them 0% done", async () => {
    state.targets = new Map([
      [
        "id-kelsea",
        {
          calls: 0,
          texts: 0,
          emails: 0,
          reachouts: 0,
          responseTargetMinutes: 60,
          effectiveFrom: "2026-09-07",
        },
      ],
    ]);
    state.touches = [];
    state.reps = [KELSEA, JACOB];
    const out = await accountability(user("director", null), { now: NOW });
    expect(out.behind).toBeNull();
  });

  it("is null when nobody is behind — a banner that is always there is unread", () => {
    const ok = [
      {
        repId: "1",
        slug: "kelsea",
        firstName: "Kelsea",
        displayName: "Kelsea",
        initials: "KK",
        target: {
          calls: 10,
          texts: 0,
          emails: 0,
          reachouts: 10,
          responseTargetMinutes: 60,
          effectiveFrom: null,
        },
        actual: {
          calls: 10,
          texts: 0,
          emails: 0,
          reachouts: 10,
          leadsTouched: 1,
          medianResponseMinutes: 10,
          trend: [],
        },
      },
    ];
    expect(worstBehind(ok)).toBeNull();
  });
});

describe("myWeek", () => {
  it("is this week, this person, and nothing else", async () => {
    const out = await myWeek(user("rep", KELSEA), NOW);
    expect(out.window.range).toBe("week");
    expect(out.rep?.slug).toBe("kelsea");
  });

  it("is null for somebody with no rep row, rather than the first person on the roster", async () => {
    const out = await myWeek(user("rep", null), NOW);
    expect(out.rep).toBeNull();
  });
});

describe("pctOf", () => {
  it("is 0 rather than NaN against a zero target", () => {
    expect(pctOf(5, 0)).toBe(0);
    expect(pctOf(18, 40)).toBe(45);
  });
});
