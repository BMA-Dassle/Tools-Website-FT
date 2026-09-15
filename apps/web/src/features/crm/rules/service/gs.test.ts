import { describe, expect, it, vi } from "vitest";

/**
 * The Guest Services card's payload: which departments are read, how a refusing
 * one degrades, and which rep an address already belongs to. Neon is replaced
 * at the sub boundaries (`~/features/crm/reps`, the settings row), so this is
 * the assembly logic only — the classification rules live in
 * `gs-members.test.ts` and the live run is in the PR's smoke.
 */

const bag = vi.hoisted(() => ({
  logins: [
    { email: "guestservices@headpinz.com", repId: "4" },
    { email: "jasmine@headpinz.com", repId: "4" },
  ],
  setCalls: [] as [string, string | null][],
}));

// The reps sub and the settings row are the two Neon boundaries; the fixtures
// are inline rather than imported from `test-support`, because importing that
// file pulls the REAL reps module in before the mock is registered.
vi.mock("~/features/crm/reps", () => ({
  listReps: async () => REPS,
  listRepLogins: async () => bag.logins,
  setRepLogin: async (email: string, slug: string | null) => {
    bag.setCalls.push([email, slug]);
    return true;
  },
}));
vi.mock("../data/sevenshifts-settings-db", () => ({
  getSevenShiftsSetting: async () => ({
    gsDepartmentIds: [635186, 730648],
    gsDepartmentName: "Call Center",
  }),
  putSevenShiftsSetting: async () => ({ before: undefined }),
}));

const { loadDepartmentUsers, loadGsPayload, repIdByEmail, setGsLogin } = await import("./gs");
const { CENTRE_CODES } = await import("~/features/crm/core/centres");
type Rep = import("~/features/crm/core/types").CrmRep;

const rep = (id: string, slug: string, displayName: string, role: Rep["role"]): Rep => ({
  id,
  slug,
  displayName,
  firstName: displayName.split(" ")[0] ?? displayName,
  initials: "XX",
  role,
  email: `${slug}@headpinz.com`,
  ssoSub: null,
  bmiUserId: null,
  bmiUserIds: null,
  bmiUsername: displayName,
  bmiUsernames: null,
  sevenShiftsUserId: null,
  voxDid: null,
  threecxExtension: null,
  teamsChatId: null,
  phoneE164: null,
  centres: [...CENTRE_CODES],
  active: true,
  sortOrder: Number(id) * 10,
});

const REPS: Rep[] = [
  rep("1", "kelsea", "Kelsea Kosco", "rep"),
  { ...rep("4", "gs", "Guest Services", "bucket"), email: "guestservices@headpinz.com" },
  rep("7", "eric", "Eric Osborn", "director"),
];

const user = (id: number, first: string, email?: string) => ({
  id,
  first_name: first,
  last_name: "Agent",
  email,
});

function deps(byDepartment: Record<number, ReturnType<typeof user>[] | Error>) {
  const asked: number[] = [];
  return {
    asked,
    deps: {
      configured: true,
      async listDepartmentUsers(departmentId: number) {
        asked.push(departmentId);
        const hit = byDepartment[departmentId];
        if (hit instanceof Error) throw hit;
        return hit ?? [];
      },
    },
  };
}

describe("loadDepartmentUsers", () => {
  it("de-duplicates a user who is in two departments and records both ids", async () => {
    const d = deps({
      635186: [user(901, "Jasmine")],
      730648: [user(901, "Jasmine"), user(902, "Alex")],
    });
    const out = await loadDepartmentUsers(d.deps, [635186, 730648]);
    expect(d.asked).toEqual([635186, 730648]);
    expect(out.error).toBeNull();
    expect(out.users.map((u) => [u.id, u.departmentIds])).toEqual([
      [901, [635186, 730648]],
      [902, [730648]],
    ]);
  });

  it("a department that refuses is reported, and the other one's members still come back", async () => {
    const d = deps({ 635186: new Error("7shifts 403 on /users"), 730648: [user(902, "Alex")] });
    const out = await loadDepartmentUsers(d.deps, [635186, 730648]);
    expect(out.error).toBe("7shifts 403 on /users");
    expect(out.users.map((u) => u.id)).toEqual([902]);
  });
});

describe("repIdByEmail", () => {
  it("a login row wins over a rep's own mailbox (findRepByLoginEmail's precedence)", async () => {
    const map = await repIdByEmail(REPS);
    expect(map.get("kelsea@headpinz.com")).toBe("1");
    expect(map.get("jasmine@headpinz.com")).toBe("4");
    expect(map.get("guestservices@headpinz.com")).toBe("4");
  });
});

describe("loadGsPayload", () => {
  it("classifies the configured departments' members against the bucket", async () => {
    const d = deps({
      635186: [
        user(901, "Jasmine", "jasmine@headpinz.com"),
        user(903, "Eric", "eric@headpinz.com"),
      ],
    });
    const payload = await loadGsPayload(d.deps);
    expect(payload.setting.gsDepartmentIds).toEqual([635186, 730648]);
    expect(payload.gsRep?.slug).toBe("gs");
    expect(payload.members.map((m) => [m.email, m.worksAsGs, m.eligible])).toEqual([
      ["eric@headpinz.com", false, false],
      ["jasmine@headpinz.com", true, true],
    ]);
  });

  it("without a 7shifts token there is no member list at all, and the card says so", async () => {
    const payload = await loadGsPayload({
      configured: false,
      listDepartmentUsers: async () => {
        throw new Error("must not be called");
      },
    });
    expect(payload.configured).toBe(false);
    expect(payload.members).toEqual([]);
    expect(payload.membersError).toBeNull();
  });
});

describe("setGsLogin", () => {
  it("refuses a director's own address and never writes", async () => {
    bag.setCalls.length = 0;
    const d = deps({ 635186: [user(903, "Eric", "eric@headpinz.com")] });
    const out = await setGsLogin(d.deps, {
      email: "eric@headpinz.com",
      works: true,
      actorEmail: "eric@headpinz.com",
    });
    expect(out.refused).toBe("member_not_eligible");
    expect(bag.setCalls).toEqual([]);
  });

  it("maps an eligible agent to the bucket, and unmapping passes null", async () => {
    bag.setCalls.length = 0;
    const d = deps({ 635186: [user(904, "Paula", "paula@headpinz.com")] });
    await setGsLogin(d.deps, {
      email: "paula@headpinz.com",
      works: true,
      actorEmail: "eric@headpinz.com",
    });
    expect(bag.setCalls).toEqual([["paula@headpinz.com", "gs"]]);

    bag.setCalls.length = 0;
    const already = deps({ 635186: [user(901, "Jasmine", "jasmine@headpinz.com")] });
    await setGsLogin(already.deps, {
      email: "jasmine@headpinz.com",
      works: false,
      actorEmail: "eric@headpinz.com",
    });
    expect(bag.setCalls).toEqual([["jasmine@headpinz.com", null]]);
  });
});
