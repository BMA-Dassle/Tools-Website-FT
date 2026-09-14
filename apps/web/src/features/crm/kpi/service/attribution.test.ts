import { describe, expect, it } from "vitest";
import type { CrmRep } from "~/features/crm/core/types";
import {
  buildAttributionIndex,
  countCoverage,
  emptyCoverage,
  nameKey,
  officeUserIdFor,
  OFFICE_USER_IDS,
  ONLINE_PSEUDO_USER_IDS,
} from "./attribution";

/**
 * Who a mirrored Office project belongs to.
 *
 * OFFICE USER IDS ARE PER TENANT (brief §5.7b, probed live 2026-09-13 13:30).
 * `crm_reps.bmi_user_id` holds the FORT MYERS value only, so looking for it at
 * Naples matches nothing — which is why every Naples booking used to land in
 * nobody's row. The per-tenant table is pinned here value for value against
 * the brief, because a wrong id in it is not a wrong number on a dashboard: it
 * is the id `assignLead` would PUT onto a live guest's reservation.
 */

function rep(over: Partial<CrmRep> & { slug: string }): CrmRep {
  return {
    id: `id-${over.slug}`,
    displayName: over.slug,
    firstName: over.slug,
    initials: over.slug.slice(0, 2).toUpperCase(),
    role: "rep",
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
    sortOrder: 100,
    ...over,
  };
}

const KELSEA = rep({
  slug: "kelsea",
  displayName: "Kelsea Kosco",
  firstName: "Kelsea",
  bmiUserId: "28267036",
  bmiUsername: "Kelsea",
});
const LORI = rep({
  slug: "lori",
  displayName: "Lori Lehman",
  firstName: "Lori",
  bmiUserId: "465247",
  bmiUsername: "Lori",
});
const STEPH = rep({
  slug: "stephanie",
  displayName: "Stephanie Wegman",
  firstName: "Stephanie",
  bmiUserId: "465242",
  bmiUsername: "Stephanie",
});
const GS = rep({
  slug: "gs",
  displayName: "Guest Services",
  firstName: "Guest",
  role: "bucket",
  bmiUserId: "30080112",
  bmiUsername: "CallCenter",
});
const MKT = rep({
  slug: "mkt",
  displayName: "Marketing Director",
  firstName: "Marketing",
  role: "hold",
});

const ROSTER = [KELSEA, LORI, STEPH, GS, MKT];

describe("the probed per-tenant table", () => {
  it("carries both tenants for every salesperson the brief names", () => {
    expect(OFFICE_USER_IDS).toMatchObject({
      eric: { headpinzftmyers: "75262", headpinznaples: "25228" },
      lori: { headpinzftmyers: "465247", headpinznaples: "41096" },
      stephanie: { headpinzftmyers: "465242", headpinznaples: "1559644" },
      jacob: { headpinzftmyers: "7251049", headpinznaples: "3690605" },
      kelsea: { headpinzftmyers: "28267036", headpinznaples: "6338800" },
      gs: { headpinzftmyers: "30080112", headpinznaples: "6400642" },
    });
  });

  it("has no entry for the Marketing hold row, which has no Office user at all", () => {
    expect(OFFICE_USER_IDS.mkt).toBeUndefined();
  });
});

describe("officeUserIdFor", () => {
  it("resolves each tenant separately", () => {
    expect(officeUserIdFor(LORI, "headpinzftmyers")).toBe("465247");
    expect(officeUserIdFor(LORI, "headpinznaples")).toBe("41096");
  });

  it("falls back to bmi_user_id ONLY at Fort Myers", () => {
    const unlisted = rep({ slug: "newbie", bmiUserId: "999111" });
    expect(officeUserIdFor(unlisted, "headpinzftmyers")).toBe("999111");
    // The write hazard §5.7b names: that column holds a Fort Myers id, and
    // handing it to Naples would assign a real booking to a stranger.
    expect(officeUserIdFor(unlisted, "headpinznaples")).toBeNull();
  });

  it("never resolves the Marketing hold row", () => {
    expect(officeUserIdFor(MKT, "headpinzftmyers")).toBeNull();
    expect(officeUserIdFor(MKT, "headpinznaples")).toBeNull();
  });
});

describe("buildAttributionIndex", () => {
  const index = buildAttributionIndex(ROSTER);

  it("matches a Fort Myers project by its Fort Myers id", () => {
    expect(index.match("headpinzftmyers", "465247", "Lori")).toEqual({ rep: LORI, kind: "exact" });
  });

  it("matches a NAPLES project by the Naples id — the bug this table fixes", () => {
    expect(index.match("headpinznaples", "41096", "Lori")).toEqual({ rep: LORI, kind: "exact" });
  });

  it("does not award a Naples project to Lori because of her Fort Myers id", () => {
    // 465247 means somebody else entirely in the Naples tenant.
    const m = index.match("headpinznaples", "465247", null);
    expect(m.rep).toBeNull();
    expect(m.kind).toBe("none");
  });

  it("falls back to a NAME match, and flags it as fuzzy", () => {
    expect(index.match("headpinzftmyers", "99999999", "Kelsea")).toEqual({
      rep: KELSEA,
      kind: "fuzzy",
    });
  });

  it("returns none — never a guess — for an unknown id and an unknown name", () => {
    expect(index.match("headpinzftmyers", "99999999", "Somebody Else")).toEqual({
      rep: null,
      kind: "none",
    });
  });

  it("refuses an AMBIGUOUS name rather than awarding it to the first rep", () => {
    // Fort Myers really has a `StephanieT` beside Stephanie Wegman.
    const twins = [
      STEPH,
      rep({ slug: "steph2", displayName: "Stephanie", bmiUsername: "Stephanie" }),
    ];
    const amb = buildAttributionIndex(twins);
    expect(amb.match("headpinzftmyers", null, "Stephanie").kind).toBe("none");
  });

  it("never attributes anything to the Marketing hold row, by id or by name", () => {
    expect(index.match("headpinzftmyers", null, "Marketing Director").rep).toBeNull();
  });

  it("excludes Naples's '-6' Online pseudo-user", () => {
    expect(ONLINE_PSEUDO_USER_IDS).toContain("-6");
    expect(index.match("headpinznaples", "-6", "Online")).toEqual({ rep: null, kind: "none" });
  });

  it("matches the Guest Services bucket at both tenants", () => {
    expect(index.match("headpinzftmyers", "30080112", null).rep).toBe(GS);
    expect(index.match("headpinznaples", "6400642", null).rep).toBe(GS);
  });
});

describe("nameKey", () => {
  it("strips punctuation and collapses spaces", () => {
    expect(nameKey("Lori Coates-Lehman")).toBe("lori coates lehman");
    expect(nameKey(null)).toBe("");
  });
});

describe("coverage", () => {
  it("counts each project once under its own kind", () => {
    const c = emptyCoverage();
    countCoverage(c, "exact");
    countCoverage(c, "exact");
    countCoverage(c, "fuzzy");
    countCoverage(c, "none");
    expect(c).toEqual({ projects: 4, exact: 2, fuzzy: 1, none: 1 });
  });
});
