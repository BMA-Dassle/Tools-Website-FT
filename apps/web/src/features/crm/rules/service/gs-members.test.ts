import { describe, expect, it } from "vitest";
import { REPS } from "../test-support";
import {
  GS_BLOCK_NO_BUCKET,
  GS_BLOCK_NO_EMAIL,
  GS_BLOCK_SERVICE,
  GS_REFUSE_INELIGIBLE,
  GS_REFUSE_UNKNOWN,
  classifyGsMembers,
  gsLoginRefusal,
  isInternalEmail,
  isServiceAccount,
  ownRepBlock,
  type GsDepartmentUser,
} from "./gs-members";

/**
 * The department membership of `635186` as probed live on 2026-09-13 (§5.7b),
 * in miniature: two directors WITH their own rep rows, one real call-centre
 * agent, one service account, one personal address.
 *
 * Both halves of the owner's rule are pinned here:
 *   (1) nothing is derived from membership — Eric and Jacob default OFF and
 *       cannot be ticked, because ticking them would sign a DIRECTOR in as the
 *       Guest Services bucket and lose their own row;
 *   (2) a real agent is offered the toggle, and once a `crm_rep_logins` row
 *       points at the bucket the screen shows it ON.
 */

const GS_REP_ID = "4"; // REPS[3] — slug 'gs'

const member = (id: number, first: string, last: string, email?: string): GsDepartmentUser => ({
  id,
  first_name: first,
  last_name: last,
  email,
  departmentIds: [635186],
});

const USERS: GsDepartmentUser[] = [
  member(1001, "Eric", "Osborn", "Eric@Headpinz.com "),
  member(1002, "Jacob", "Elliott", "jacob@headpinz.com"),
  member(1003, "Jasmine", "Reyes", "jasmine@headpinz.com"),
  member(1004, "Reporting", "User", "noreply@headpinz.com"),
  member(1005, "Alex", "Trepasso", "alextrepasso@gmail.com"),
  member(1006, "Kiosk", "Tablet"),
];

/** Each rep's own mailbox is a login (`findRepByLoginEmail`), so eric@ → the eric row. */
const ownMailboxes = new Map(REPS.filter((r) => r.email).map((r) => [r.email as string, r.id]));

function classify(extra: ReadonlyMap<string, string> = new Map()) {
  return classifyGsMembers({
    users: USERS,
    repIdByEmail: new Map([...ownMailboxes, ...extra]),
    reps: REPS,
    gsRepId: GS_REP_ID,
  });
}

const byId = (rows: ReturnType<typeof classify>, id: number) =>
  rows.find((m) => m.sevenShiftsUserId === id)!;

describe("classifyGsMembers", () => {
  it("a director in the department defaults OFF and cannot be ticked", () => {
    const rows = classify();
    for (const id of [1001, 1002]) {
      const m = byId(rows, id);
      expect(m.worksAsGs).toBe(false);
      expect(m.eligible).toBe(false);
      expect(m.ownRep?.slug).toBe(id === 1001 ? "eric" : "jacob");
      expect(m.blockedReason).toBe(ownRepBlock(m.ownRep!.displayName));
    }
  });

  it("a real agent with no rep row is offered the toggle, and a login row shows it ON", () => {
    const off = byId(classify(), 1003);
    expect(off).toMatchObject({
      email: "jasmine@headpinz.com",
      worksAsGs: false,
      eligible: true,
      blockedReason: null,
      external: false,
      ownRep: null,
      departmentIds: [635186],
    });

    const on = byId(classify(new Map([["jasmine@headpinz.com", GS_REP_ID]])), 1003);
    expect(on.worksAsGs).toBe(true);
    expect(on.eligible).toBe(true);
  });

  it("service accounts and users with no email are never eligible; personal addresses are flagged", () => {
    const rows = classify();
    expect(byId(rows, 1004)).toMatchObject({
      eligible: false,
      blockedReason: GS_BLOCK_SERVICE,
    });
    expect(byId(rows, 1006)).toMatchObject({
      email: null,
      eligible: false,
      blockedReason: GS_BLOCK_NO_EMAIL,
    });
    expect(byId(rows, 1005)).toMatchObject({ external: true, eligible: true });
    expect(isInternalEmail("alextrepasso@gmail.com")).toBe(false);
    expect(isServiceAccount("someone@headpinz.com", "Reporting User")).toBe(true);
  });

  it("emails are compared lowercased and trimmed, and the list is sorted by name", () => {
    const rows = classify();
    expect(byId(rows, 1001).email).toBe("eric@headpinz.com");
    expect(rows.map((m) => m.name)).toEqual([
      "Alex Trepasso",
      "Eric Osborn",
      "Jacob Elliott",
      "Jasmine Reyes",
      "Kiosk Tablet",
      "Reporting User",
    ]);
  });

  it("with no bucket row nobody can be ticked at all", () => {
    const rows = classifyGsMembers({
      users: USERS,
      repIdByEmail: ownMailboxes,
      reps: REPS,
      gsRepId: null,
    });
    expect(byId(rows, 1003).blockedReason).toBe(GS_BLOCK_NO_BUCKET);
  });
});

describe("gsLoginRefusal — the same rule on the wire", () => {
  it("refuses an unknown address, an ineligible member, and lets an eligible one through", () => {
    const rows = classify();
    expect(gsLoginRefusal(undefined, true)).toBe(GS_REFUSE_UNKNOWN);
    expect(gsLoginRefusal(byId(rows, 1001), true)).toBe(GS_REFUSE_INELIGIBLE);
    expect(gsLoginRefusal(byId(rows, 1004), true)).toBe(GS_REFUSE_INELIGIBLE);
    expect(gsLoginRefusal(byId(rows, 1003), true)).toBeNull();
  });

  it("untick only ever removes a bucket mapping — it can never unmap a director's own row", () => {
    const on = byId(classify(new Map([["jasmine@headpinz.com", GS_REP_ID]])), 1003);
    expect(gsLoginRefusal(on, false)).toBeNull();
    expect(gsLoginRefusal(byId(classify(), 1001), false)).toBe("login_belongs_to_another_rep");
  });
});
