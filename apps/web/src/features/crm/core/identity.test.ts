import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CrmRep } from "./types";

/**
 * The role matrix and the two entry points' failure shapes (brief §3.3).
 *
 * `@/auth` is mocked at the module boundary: the real one instantiates
 * next-auth, and what this file pins is what we DO with a session, not how
 * Auth.js builds one (auth.config.test.ts owns that). `hasAdminAccess` is
 * replicated faithfully — `roles.includes("access")`.
 */

const bag = vi.hoisted(() => ({
  session: null as unknown,
  authImpl: null as null | (() => Promise<unknown>),
  rep: null as unknown,
  repImpl: null as null | ((email: string) => Promise<unknown>),
  repCalls: [] as string[],
}));

vi.mock("@/auth", () => ({
  auth: () => (bag.authImpl ? bag.authImpl() : Promise.resolve(bag.session)),
  hasAdminAccess: (s: { roles?: string[] } | null | undefined) => !!s?.roles?.includes("access"),
}));

vi.mock("~/features/crm/reps", () => ({
  findRepByLoginEmail: async (email: string) => {
    bag.repCalls.push(email);
    return bag.repImpl ? bag.repImpl(email) : bag.rep;
  },
}));

vi.mock("next/navigation", () => ({
  notFound: (): never => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

const { crmRoleFromRoles, crmUserFromRequest, isDirector, publicUser, requireCrmUser } =
  await import("./identity");

const KELSEA: CrmRep = {
  id: "1",
  slug: "kelsea",
  displayName: "Kelsea Kosco",
  firstName: "Kelsea",
  initials: "KK",
  role: "rep",
  email: "kelsea@headpinz.com",
  ssoSub: null,
  bmiUserId: "28267036",
  bmiUsername: "Kelsea Kosco",
  sevenShiftsUserId: null,
  voxDid: "+12395550141",
  threecxExtension: "141",
  teamsChatId: "19:abc@thread.v2",
  phoneE164: null,
  centres: ["HPFM", "FT"],
  active: true,
  sortOrder: 10,
};

function session(roles: string[], extra: Record<string, unknown> = {}) {
  return {
    user: { email: "Kelsea@HeadPinz.com", name: "Kelsea Kosco" },
    roles,
    sub: "oid-kelsea",
    expires: "2026-09-13T00:00:00.000Z",
    ...extra,
  };
}

beforeEach(() => {
  bag.session = null;
  bag.authImpl = null;
  bag.rep = null;
  bag.repImpl = null;
  bag.repCalls.length = 0;
});

describe("crmRoleFromRoles", () => {
  it("director beats rep; access alone is nothing", () => {
    expect(crmRoleFromRoles(["access", "sales", "sales-director"])).toBe("director");
    expect(crmRoleFromRoles(["access", "sales-director"])).toBe("director");
    expect(crmRoleFromRoles(["access", "sales"])).toBe("rep");
    expect(crmRoleFromRoles(["access"])).toBeNull();
    expect(crmRoleFromRoles([])).toBeNull();
    expect(crmRoleFromRoles(undefined)).toBeNull();
    // The prefixed Entra value never reaches us, and must not be accepted if it did.
    expect(crmRoleFromRoles(["access", "fasttrax-admin.sales"])).toBeNull();
  });
});

describe("crmUserFromRequest — the route-handler variant", () => {
  it("director: both sales roles, lowercased email, sub carried, rep looked up by the lowercased key", async () => {
    bag.session = session(["access", "sales", "sales-director"], {
      user: { email: "Eric@HeadPinz.com", name: "Eric Osborn" },
      sub: "oid-eric",
    });
    const r = await crmUserFromRequest();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.user).toMatchObject({
      email: "eric@headpinz.com",
      name: "Eric Osborn",
      sub: "oid-eric",
      role: "director",
      roles: ["access", "sales", "sales-director"],
      rep: null,
    });
    expect(bag.repCalls).toEqual(["eric@headpinz.com"]);
    expect(isDirector(r.user)).toBe(true);
  });

  it("rep: the sales role, with the crm_reps row attached", async () => {
    bag.session = session(["access", "sales"]);
    bag.rep = KELSEA;
    const r = await crmUserFromRequest();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.user.role).toBe("rep");
    expect(r.user.rep).toEqual(KELSEA);
    expect(isDirector(r.user)).toBe(false);
  });

  it("access alone → 403 (signed in, not a salesperson)", async () => {
    bag.session = session(["access"]);
    expect(await crmUserFromRequest()).toEqual({ ok: false, status: 403 });
    expect(bag.repCalls).toEqual([]);
  });

  it("a sales role without access → 403 — the gate's rule still applies", async () => {
    bag.session = session(["sales"]);
    expect(await crmUserFromRequest()).toEqual({ ok: false, status: 403 });
  });

  it("no session → 401", async () => {
    bag.session = null;
    expect(await crmUserFromRequest()).toEqual({ ok: false, status: 401 });
  });

  it("a session with no email → 401, never a user with an empty actor_email", async () => {
    bag.session = session(["access", "sales"], { user: { name: "No Mail" } });
    expect(await crmUserFromRequest()).toEqual({ ok: false, status: 401 });
  });

  it("auth() rejecting (broken env block) → 401, never a throw", async () => {
    bag.authImpl = () => Promise.reject(new Error("AUTH_SECRET missing"));
    await expect(crmUserFromRequest()).resolves.toEqual({ ok: false, status: 401 });
  });

  it("a Neon failure on the rep lookup degrades to rep: null, not a refusal", async () => {
    bag.session = session(["access", "sales"]);
    bag.repImpl = () => Promise.reject(new Error("DATABASE_URL is not set"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const r = await crmUserFromRequest();
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.user.rep).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("falls back to the email as the display name when the profile carries none", async () => {
    bag.session = session(["access", "sales"], { user: { email: "kelsea@headpinz.com" } });
    const r = await crmUserFromRequest();
    if (r.ok) expect(r.user.name).toBe("kelsea@headpinz.com");
    expect(r.ok).toBe(true);
  });
});

describe("requireCrmUser — the page variant", () => {
  it("returns the user for a salesperson", async () => {
    bag.session = session(["access", "sales"]);
    bag.rep = KELSEA;
    const u = await requireCrmUser();
    expect(u.email).toBe("kelsea@headpinz.com");
    expect(u.rep?.slug).toBe("kelsea");
  });

  it("404s for access-only staff, for no session, and when auth() throws", async () => {
    bag.session = session(["access"]);
    await expect(requireCrmUser()).rejects.toThrow("NEXT_NOT_FOUND");
    bag.session = null;
    await expect(requireCrmUser()).rejects.toThrow("NEXT_NOT_FOUND");
    bag.authImpl = () => Promise.reject(new Error("boom"));
    await expect(requireCrmUser()).rejects.toThrow("NEXT_NOT_FOUND");
  });
});

describe("publicUser — what the browser may see", () => {
  it("keeps the identity and the public rep fields, drops DIDs, chat ids and Office names", async () => {
    bag.session = session(["access", "sales"]);
    bag.rep = KELSEA;
    const r = await crmUserFromRequest();
    if (!r.ok) throw new Error("expected a user");
    const pub = publicUser(r.user);
    expect(pub).toEqual({
      email: "kelsea@headpinz.com",
      name: "Kelsea Kosco",
      role: "rep",
      roles: ["access", "sales"],
      rep: {
        id: "1",
        slug: "kelsea",
        displayName: "Kelsea Kosco",
        firstName: "Kelsea",
        initials: "KK",
        role: "rep",
        centres: ["HPFM", "FT"],
      },
    });
    const json = JSON.stringify(pub);
    for (const secret of ["+12395550141", "141", "19:abc", "28267036", "oid-kelsea"]) {
      expect(json, secret).not.toContain(secret);
    }
  });

  it("carries rep: null through for a director without a row", async () => {
    bag.session = session(["access", "sales-director"]);
    const r = await crmUserFromRequest();
    if (!r.ok) throw new Error("expected a user");
    expect(publicUser(r.user).rep).toBeNull();
  });
});
