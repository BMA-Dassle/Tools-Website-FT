import { describe, expect, it, vi } from "vitest";
import type { CrmUser } from "../../core/types";
import type { CallRow } from "../contracts";
import type { CallUpsert } from "../data/calls-db";
import { dialBlockedReason, startCall, type DialDeps } from "./dial";

/**
 * Click-to-call. The two things worth pinning:
 *   1. the Neon row is written BEFORE 3CX is asked anything (R2), so a refused
 *      call is still on the board;
 *   2. it NEVER throws at the rep — every failure comes back as an outcome plus
 *      a `tel:` link. `makeCall` was never probed live (it would have rung a
 *      real handset), so "the PBX refuses" is a case we assume will happen.
 */

function user(partial: Partial<CrmUser["rep"]> | null): CrmUser {
  return {
    email: "kelsea@headpinz.com",
    name: "Kelsea Kosco",
    sub: null,
    roles: ["access", "sales"],
    role: "rep",
    rep: partial
      ? {
          id: "7",
          slug: "kelsea",
          displayName: "Kelsea Kosco",
          firstName: "Kelsea",
          initials: "KK",
          role: "rep",
          email: "kelsea@headpinz.com",
          ssoSub: null,
          bmiUserId: null,
          bmiUsername: null,
          sevenShiftsUserId: null,
          voxDid: null,
          threecxExtension: "9025",
          teamsChatId: null,
          phoneE164: null,
          centres: [],
          active: true,
          sortOrder: 1,
          ...partial,
        }
      : null,
  };
}

function deps(overrides: Partial<DialDeps> = {}) {
  const saved: CallUpsert[] = [];
  const order: string[] = [];
  const d: DialDeps & { saved: CallUpsert[]; order: string[] } = {
    saved,
    order,
    save: async (row: CallUpsert) => {
      order.push("save");
      saved.push(row);
      return { id: "101", ...row } as unknown as CallRow;
    },
    match: async () => ({ contactId: "5", leadId: "9", repId: "7", matchedBy: "phone" as const }),
    ring: vi.fn(async () => {
      order.push("ring");
      return {};
    }),
    activity: async () => {
      order.push("activity");
      return "1";
    },
    configured: () => true,
    enabled: () => true,
    now: () => new Date("2026-09-13T18:00:00Z"),
    ...overrides,
  };
  return d;
}

describe("dialBlockedReason", () => {
  it("names the kill switch, the credential and the missing extension, in that order", () => {
    expect(dialBlockedReason(user({}), { enabled: () => false, configured: () => true })).toBe(
      "Click-to-call is switched off",
    );
    expect(dialBlockedReason(user({}), { enabled: () => true, configured: () => false })).toBe(
      "3CX is not configured",
    );
    expect(
      dialBlockedReason(user({ threecxExtension: null }), {
        enabled: () => true,
        configured: () => true,
      }),
    ).toBe("No 3CX extension on your rep record");
    expect(dialBlockedReason(user({}), { enabled: () => true, configured: () => true })).toBeNull();
  });
});

describe("startCall", () => {
  it("writes the Neon intent row BEFORE it asks 3CX for anything", async () => {
    const d = deps();
    await startCall({ number: "(239) 555-1234", user: user({}) }, d);
    expect(d.order).toEqual(["save", "ring", "activity"]);
    expect(d.saved[0]).toMatchObject({
      direction: "out",
      toE164: "+12395551234",
      extension: "9025",
      repId: "7",
      leadId: "9",
      status: "Dialing",
      source: "click",
      actorEmail: "kelsea@headpinz.com",
    });
  });

  it("reports `ringing` and hands back a tel: link anyway", async () => {
    const res = await startCall({ number: "2395551234", user: user({}) }, deps());
    expect(res.outcome).toBe("ringing");
    expect(res.telHref).toBe("tel:+12395551234");
    expect(res.error).toBeNull();
  });

  it("degrades to `fallback` when the PBX refuses — and still saved the row", async () => {
    const d = deps({
      ring: vi.fn(async () => {
        throw new Error("3cx makecall/9025 403");
      }),
    });
    const res = await startCall({ number: "2395551234", user: user({}) }, d);
    expect(res.outcome).toBe("fallback");
    expect(res.error).toContain("403");
    expect(res.telHref).toBe("tel:+12395551234");
    expect(d.saved).toHaveLength(1);
  });

  it("does not ring at all when the kill switch is off, and says so", async () => {
    const d = deps({ enabled: () => false });
    const res = await startCall({ number: "2395551234", user: user({}) }, d);
    expect(res.outcome).toBe("disabled");
    expect(res.error).toBe("Click-to-call is switched off");
    expect(d.ring).not.toHaveBeenCalled();
    expect(d.saved).toHaveLength(1);
  });

  it("does not ring when the rep has no extension — today's seeded state", async () => {
    const d = deps();
    const res = await startCall(
      { number: "2395551234", user: user({ threecxExtension: null }) },
      d,
    );
    expect(res.outcome).toBe("disabled");
    expect(d.ring).not.toHaveBeenCalled();
  });

  it("prefers the lead the rep was looking at over the one the number matched", async () => {
    const d = deps();
    await startCall({ number: "2395551234", leadId: "77", user: user({}) }, d);
    expect(d.saved[0]?.leadId).toBe("77");
  });

  it("keeps an unparseable number as typed rather than losing the attempt", async () => {
    const d = deps({
      match: async () => ({
        contactId: null,
        leadId: null,
        repId: null,
        matchedBy: "none" as const,
      }),
    });
    const res = await startCall({ number: "x", user: user({}) }, d);
    expect(d.saved).toHaveLength(1);
    expect(res.telHref).toBe("tel:x");
  });
});
