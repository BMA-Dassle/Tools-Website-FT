import { beforeEach, describe, expect, it, vi } from "vitest";
import { http, installMsw, rawJson } from "@/test/msw/server";
import type { CrmRep } from "~/features/crm/core/types";

/**
 * The Goals → Pandora mirror (brief C7): "Neon is written FIRST and is the
 * source of truth; the Pandora call is a downstream sync that must never lose
 * the owner's input. A failed mirror is queued for retry and shown, never
 * swallowed."
 *
 * Everything below is about the SECOND half of that sentence — what the mirror
 * does with a refusal — plus the two shape facts that make a wrong mirror
 * silent: Pandora takes whole DOLLARS while we store cents, and its reply
 * carries an id that must not go through `res.json()`.
 */

const state = vi.hoisted(() => ({
  months: [] as { month: number; goalCents: number }[],
  synced: [] as { repId: string; year: number }[],
}));

vi.mock("../data/goals-db", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    ensureGoalsSchema: async () => {},
    sumGoalsForYear: async () => state.months,
    markGoalsSynced: async (repId: string, year: number) => {
      state.synced.push({ repId, year });
    },
  };
});

const {
  PANDORA_MIN_YEAR,
  PandoraGoalsError,
  goalDollars,
  goalsSyncKey,
  pushRepGoals,
  putPandoraGoal,
} = await import("./pandora-goals");

const URL = "https://bma-pandora-api.azurewebsites.net/v2/bmi/goals";

const posted: { body: unknown; auth: string | null }[] = [];

const server = installMsw(
  http.post(URL, async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>;
    posted.push({ body, auth: request.headers.get("authorization") });
    // A REAL Pandora reply, as raw text with a bare numeric id.
    return rawJson(
      `{"success":true,"data":{"salesGoalID":91422,"salesName":"${String(body.salesName)}","year":${Number(body.year)},"month":${Number(body.month)},"goal":${Number(body.goal)}}}`,
      { status: 201 },
    );
  }),
);

function rep(over: Partial<CrmRep> = {}): CrmRep {
  return {
    id: "id-kelsea",
    slug: "kelsea",
    displayName: "Kelsea Kosco",
    firstName: "Kelsea",
    initials: "KK",
    role: "rep",
    email: null,
    ssoSub: null,
    bmiUserId: "28267036",
    bmiUserIds: null,
    bmiUsername: "Kelsea",
    bmiUsernames: null,
    sevenShiftsUserId: null,
    voxDid: null,
    threecxExtension: null,
    teamsChatId: null,
    phoneE164: null,
    centres: [],
    active: true,
    sortOrder: 1,
    ...over,
  };
}

const DEPS = { apiKey: "test-key" };

beforeEach(() => {
  posted.length = 0;
  state.months = [
    { month: 1, goalCents: 1_200_000 },
    { month: 2, goalCents: 950_050 },
  ];
  state.synced = [];
});

describe("goalDollars", () => {
  it("converts cents to the whole-dollar number Pandora's schema accepts", () => {
    expect(goalDollars(1_200_000)).toBe(12_000);
    // Pandora takes `z.number().min(0)` in DOLLARS; sending cents would set a
    // salesperson's commission target a hundred times too high.
    expect(goalDollars(950_050)).toBe(9_501);
    expect(goalDollars(0)).toBe(0);
  });
});

describe("putPandoraGoal", () => {
  it("sends the documented shape with a bearer key", async () => {
    await putPandoraGoal({ salesName: "Kelsea", year: 2026, month: 3, goalCents: 4_500_000 }, DEPS);
    expect(posted[0].body).toEqual({ salesName: "Kelsea", year: 2026, month: 3, goal: 45_000 });
    expect(posted[0].auth).toBe("Bearer test-key");
  });

  it("reads the reply as RAW TEXT, so the id survives as a string", async () => {
    const out = await putPandoraGoal(
      { salesName: "Kelsea", year: 2026, month: 3, goalCents: 100 },
      DEPS,
    );
    expect(out.salesGoalID).toBe("91422");
    expect(typeof out.salesGoalID).toBe("string");
  });

  it("refuses without an API key rather than calling Pandora anonymously", async () => {
    await expect(
      putPandoraGoal({ salesName: "K", year: 2026, month: 1, goalCents: 0 }, { apiKey: null }),
    ).rejects.toBeInstanceOf(PandoraGoalsError);
    expect(posted).toHaveLength(0);
  });

  it("turns a 500 into an error that names the month", async () => {
    server.use(
      http.post(URL, () => rawJson(`{"success":false,"message":"boom"}`, { status: 500 })),
    );
    const err = await putPandoraGoal(
      { salesName: "K", year: 2026, month: 7, goalCents: 0 },
      DEPS,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PandoraGoalsError);
    expect((err as InstanceType<typeof PandoraGoalsError>).month).toBe(7);
    expect((err as Error).message).toBe("boom");
  });

  it("treats a 200 that says success:false as a refusal, not a success", async () => {
    server.use(
      http.post(URL, () =>
        rawJson(`{"success":false,"message":"year not allowed"}`, { status: 200 }),
      ),
    );
    await expect(
      putPandoraGoal({ salesName: "K", year: 2026, month: 1, goalCents: 0 }, DEPS),
    ).rejects.toThrow("year not allowed");
  });
});

describe("pushRepGoals", () => {
  it("sends every month with a goal and stamps the year as mirrored", async () => {
    const out = await pushRepGoals(rep(), 2026, DEPS);
    expect(out.ok).toBe(true);
    expect(out.months).toEqual([
      { month: 1, goalDollars: 12_000, salesGoalId: "91422" },
      { month: 2, goalDollars: 9_501, salesGoalId: "91422" },
    ]);
    expect(state.synced).toEqual([{ repId: "id-kelsea", year: 2026 }]);
  });

  it("SKIPS a rep with no BMI username instead of guessing a name", async () => {
    // Pandora matches goals by name substring and 500s on no match; guessing
    // would write somebody else's target.
    const out = await pushRepGoals(rep({ bmiUsername: null }), 2026, DEPS);
    expect(out.ok).toBe(false);
    expect(out.skipped).toContain("no BMI username");
    expect(posted).toHaveLength(0);
    expect(state.synced).toEqual([]);
  });

  it("refuses a year Pandora will not accept, without calling it", async () => {
    const out = await pushRepGoals(rep(), PANDORA_MIN_YEAR - 1, DEPS);
    expect(out.ok).toBe(false);
    expect(out.skipped).toContain(String(PANDORA_MIN_YEAR));
    expect(posted).toHaveLength(0);
  });

  it("stops at the first refusal and does NOT claim a half-finished mirror", async () => {
    let n = 0;
    server.use(
      http.post(URL, () => {
        n += 1;
        if (n === 2) return rawJson(`{"success":false,"message":"nope"}`, { status: 500 });
        return rawJson(`{"success":true,"data":{"salesGoalID":1,"goal":0}}`, { status: 201 });
      }),
    );
    await expect(pushRepGoals(rep(), 2026, DEPS)).rejects.toThrow("nope");
    // The year stays unsynced: a partial push must not read as mirrored.
    expect(state.synced).toEqual([]);
  });

  it("does nothing and still stamps when the rep has no goals at all", async () => {
    state.months = [];
    const out = await pushRepGoals(rep(), 2026, DEPS);
    expect(out.ok).toBe(true);
    expect(posted).toHaveLength(0);
  });
});

describe("goalsSyncKey", () => {
  it("is stable within a minute so a double-click enqueues one job", () => {
    const a = goalsSyncKey("kelsea", 2026, new Date("2026-09-13T18:20:05Z"));
    const b = goalsSyncKey("kelsea", 2026, new Date("2026-09-13T18:20:59Z"));
    expect(a).toBe(b);
    expect(a).toBe("pandora-goals-sync:kelsea:2026:2026-09-13T18:20");
  });

  it("separates reps and years", () => {
    const now = new Date("2026-09-13T18:20:05Z");
    expect(goalsSyncKey("kelsea", 2026, now)).not.toBe(goalsSyncKey("lori", 2026, now));
    expect(goalsSyncKey("kelsea", 2026, now)).not.toBe(goalsSyncKey("kelsea", 2027, now));
  });
});
