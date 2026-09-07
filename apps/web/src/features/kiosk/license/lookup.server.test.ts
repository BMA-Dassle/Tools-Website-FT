/**
 * THE 2026-08-17 CROSS-CENTER DEFECT, pinned.
 *
 * A BMI person id only resolves on the local server it came from. The kiosk
 * name+DOB lookup took a `location` and dropped it, so search-before-create at
 * a NAPLES kiosk searched FORT MYERS, the match gate adopted the guest's Fort
 * Myers id, and every later Naples write against it 404d — the waiver push, the
 * bill attach, the licence grant. Two guests stranded on 2026-08-17 (Zachary
 * Petcu 63000000003838742, Guy Garza 7406926), Naples running a 15.9% waiver
 * failure rate against ~0.4% at Fort Myers.
 *
 * These tests assert the CLIENT KEY THAT REACHES THE WIRE, on both the search
 * that finds ids and the person detail that confirms them, because a `location`
 * that is merely accepted is exactly what shipped before.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("~/features/daily-events/data/bmi-office", () => ({
  fetchPersonRaw: vi.fn(),
  getOfficeToken: vi.fn(async () => "tok"),
  OfficeApiError: class OfficeApiError extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  },
}));

// Neon-backed code cache — never touched by the name+DOB path, stubbed so the
// module graph carries no DB.
vi.mock("./code-cache", () => ({
  personIdForCode: vi.fn(async () => null),
  rememberCodes: vi.fn(async () => undefined),
}));

/** Captured search requests, in order. */
const searchPaths: string[] = [];
/** Body the fake Office search answers with next. */
let searchBody = "[]";

/** Status the fake Office search answers with (the real client reads
 *  `res.statusCode || 500`, so this must be set explicitly). */
let searchStatus = 200;

vi.mock("https", () => {
  const get = (
    opts: { path: string; headers: Record<string, string> },
    cb: (res: {
      statusCode: number;
      on: (ev: string, fn: (chunk?: string) => void) => void;
    }) => void,
  ) => {
    searchPaths.push(opts.path);
    // Header and path must agree — BMI authorises on the `clientkey` header and
    // routes on the path segment; a mismatch is a silent wrong-server read.
    const seg = /^\/api\/([^/]+)\//.exec(opts.path)?.[1];
    if (seg && opts.headers.clientkey !== seg) {
      throw new Error(`clientkey header ${opts.headers.clientkey} != path ${seg}`);
    }
    const handlers: Record<string, (chunk?: string) => void> = {};
    cb({
      statusCode: searchStatus,
      on: (ev, fn) => {
        handlers[ev] = fn;
        if (ev === "end") {
          handlers.data?.(searchBody);
          fn();
        }
      },
    });
    return { on: () => undefined, setTimeout: () => undefined, destroy: () => undefined };
  };
  return { default: { get }, get };
});

import { fetchPersonRaw, getOfficeToken } from "~/features/daily-events/data/bmi-office";
import { clientKeyForLookup, lookupLicenseMatches, warmLicenseLookup } from "./lookup.server";

const mockPerson = vi.mocked(fetchPersonRaw);
const mockToken = vi.mocked(getOfficeToken);

/** The Naples record for a returning guest. */
const NAPLES_HIT = JSON.stringify([
  { localId: "4227791", description: "Zach Petcu (2/4/2013) Last seen: 4/26/2025" },
]);
/** The Fort Myers record for the SAME human — a different id entirely. */
const FM_HIT = JSON.stringify([
  { localId: "63000000003838742", description: "Zachary Petcu (2/4/2013) Last seen: 6/13/2026" },
]);

beforeEach(() => {
  searchPaths.length = 0;
  searchBody = "[]";
  searchStatus = 200;
  mockPerson.mockReset();
  mockToken.mockClear();
  mockToken.mockResolvedValue("tok");
  mockPerson.mockResolvedValue({
    firstName: "Zach",
    name: "Petcu",
    birthDate: "2013-02-04T00:00:00",
    memberships: [],
    tags: [],
    addresses: [],
  });
});

/** The clientKey the search actually addressed. */
const searchedKey = () => /^\/api\/([^/]+)\//.exec(searchPaths[0] ?? "")?.[1] ?? "";
/** The clientKey the person-detail confirmation actually addressed. */
const confirmedKey = () => mockPerson.mock.calls[0]?.[0];

describe("clientKeyForLookup", () => {
  it("maps naples to its own BMI server", () => {
    expect(clientKeyForLookup("naples")).toBe("headpinznaples");
  });

  it("maps both Fort Myers brands to the shared FM server", () => {
    // FastTrax and HP Fort Myers are the SAME local server (61/61 ids
    // byte-identical, 2026-08-15) — they must not diverge.
    expect(clientKeyForLookup("fasttrax")).toBe("headpinzftmyers");
    expect(clientKeyForLookup("headpinz")).toBe("headpinzftmyers");
  });

  it("falls back to Fort Myers for missing or unknown slugs", () => {
    // Every caller predating Naples support omits it. Falling back beats
    // throwing: a guest at a kiosk must never be blocked by a lookup.
    expect(clientKeyForLookup(undefined)).toBe("headpinzftmyers");
    expect(clientKeyForLookup("")).toBe("headpinzftmyers");
    expect(clientKeyForLookup("mars")).toBe("headpinzftmyers");
  });

  it("is case- and whitespace-insensitive", () => {
    expect(clientKeyForLookup("  Naples ")).toBe("headpinznaples");
  });
});

describe("lookupLicenseMatches addresses the caller's center", () => {
  it("searches NAPLES when the kiosk is at Naples", async () => {
    searchBody = NAPLES_HIT;
    const matches = await lookupLicenseMatches({
      lastName: "Petcu",
      dobIso: "2013-02-04",
      firstName: "Zachary",
      location: "naples",
    });
    expect(searchedKey()).toBe("headpinznaples");
    expect(matches.map((m) => m.personId)).toEqual(["4227791"]);
  });

  it("confirms the hit against the SAME server it was found on", async () => {
    // The two calls must agree. Numeric ids collide across servers, so
    // confirming a Naples hit against Fort Myers would validate a different
    // human who happens to share the id.
    searchBody = NAPLES_HIT;
    await lookupLicenseMatches({ lastName: "Petcu", dobIso: "2013-02-04", location: "naples" });
    expect(confirmedKey()).toBe("headpinznaples");
    expect(confirmedKey()).toBe(searchedKey());
  });

  it("searches FORT MYERS for fasttrax and headpinz", async () => {
    searchBody = FM_HIT;
    for (const location of ["fasttrax", "headpinz"]) {
      searchPaths.length = 0;
      mockPerson.mockClear();
      mockPerson.mockResolvedValue({
        firstName: "Zachary",
        name: "Petcu",
        birthDate: "2013-02-04T00:00:00",
      });
      await lookupLicenseMatches({ lastName: "Petcu", dobIso: "2013-02-04", location });
      expect(searchedKey()).toBe("headpinzftmyers");
      expect(confirmedKey()).toBe("headpinzftmyers");
    }
  });

  it("still defaults to Fort Myers when no location is given", async () => {
    searchBody = FM_HIT;
    mockPerson.mockResolvedValue({
      firstName: "Zachary",
      name: "Petcu",
      birthDate: "2013-02-04T00:00:00",
    });
    await lookupLicenseMatches({ lastName: "Petcu", dobIso: "2013-02-04" });
    expect(searchedKey()).toBe("headpinzftmyers");
  });

  it("REGRESSION: a Naples lookup never returns the guest's Fort Myers id", async () => {
    // The exact 8/17 failure. Naples has no record for this guest, so the
    // honest answer is NO MATCH — which sends the match gate to `create` and
    // mints a Naples record. Adopting 7406926 here is what stranded Guy Garza:
    // it attaches, then 404s on every Naples write.
    searchBody = "[]"; // Naples genuinely has nobody
    const matches = await lookupLicenseMatches({
      lastName: "Garza",
      dobIso: "2010-06-16",
      firstName: "Guy",
      location: "naples",
    });
    expect(searchedKey()).toBe("headpinznaples");
    expect(matches).toEqual([]);
    // And it must not have gone shopping on the other server for a fallback.
    expect(searchPaths.every((p) => p.includes("headpinznaples"))).toBe(true);
    expect(mockPerson).not.toHaveBeenCalled();
  });

  it("sends the DOB token with no leading zeros, per center", async () => {
    // Upstream matches "M/D/YYYY" only — "06/16/2010" matches nothing. Pinned
    // here because the token travels in the same URL as the client key.
    searchBody = "[]";
    await lookupLicenseMatches({ lastName: "Garza", dobIso: "2010-06-16", location: "naples" });
    expect(decodeURIComponent(searchPaths[0])).toContain("Garza 6/16/2010");
  });
});

describe("lookupLicenseMatches — the typed phone joins the search (2026-09-06)", () => {
  // Jack Parker was minted at the kiosk on top of Jay parker: same phone, same
  // birthday, different first name. The name+DOB search found Jay, but the
  // first-name test failed, so the gate let the create through. The phone
  // path exists so that record reaches the picker flagged `viaPhone`.
  it("searches the phone (both stored shapes) and flags same-birthday hits viaPhone", async () => {
    searchBody = JSON.stringify([
      {
        localId: "54231275",
        description: "Jay parker (8/1/2007) phone: 2397771795 Last seen: 7/9/2026",
      },
    ]);
    mockPerson.mockResolvedValue({
      firstName: "Jay",
      name: "parker",
      birthDate: "2007-08-01T00:00:00",
      memberships: [{ name: "Customer Registration", stops: "2027-07-08" }],
      tags: [],
      addresses: [{ mobile: "2397771795" }],
    });
    const matches = await lookupLicenseMatches({
      lastName: "Parker",
      firstName: "Jack",
      dobIso: "2007-08-01",
      phone: "2397771795",
    });
    const tokens = searchPaths.map((p) => decodeURIComponent(p).match(/token=([^&]+)/)?.[1]);
    expect(tokens).toEqual(
      expect.arrayContaining(["Parker 8/1/2007", "2397771795", "12397771795"]),
    );
    expect(matches).toHaveLength(1);
    expect(matches[0].personId).toBe("54231275");
    expect(matches[0].viaPhone).toBe(true);
    // Code-less, and still listed — with what it carries.
    expect(matches[0].loginCode).toBe("");
    expect(matches[0].licenseActive).toBe(false);
  });

  it("a phone hit with a DIFFERENT birthday is not this guest (the family's other records)", async () => {
    searchBody = JSON.stringify([
      { localId: "1", description: "Nancy Rosales (2/2/1970) phone: 2394837953" },
    ]);
    const matches = await lookupLicenseMatches({
      lastName: "Rosales",
      dobIso: "2004-03-24",
      phone: "2394837953",
    });
    expect(matches).toEqual([]);
  });

  it("no phone → no phone search (the scan path is unchanged)", async () => {
    await lookupLicenseMatches({ lastName: "Petcu", dobIso: "2013-02-04" });
    expect(searchPaths).toHaveLength(1);
  });
});

describe("warmLicenseLookup", () => {
  it("warms the token for the caller's own center", async () => {
    // The Office token is cached PER CLIENT KEY — warming Fort Myers from a
    // Naples kiosk leaves that guest paying the auth on their first scan.
    await warmLicenseLookup("naples");
    expect(mockToken).toHaveBeenCalledWith("headpinznaples");
  });

  it("warms Fort Myers when no center is given", async () => {
    await warmLicenseLookup();
    expect(mockToken).toHaveBeenCalledWith("headpinzftmyers");
  });
});
