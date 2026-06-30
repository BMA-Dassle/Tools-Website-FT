import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * getRacerAccounts drives the SHARED lib/bmi-racer-lookup with the server
 * transport. We assert: the search→person→deposits flow resolves a racer, a
 * 17-digit-looking person id survives as an unrounded string (parseWithRawIds),
 * contact-person stubs (no login tag) are dropped, and one phone can yield
 * multiple racers.
 */

const officeGet = vi.fn();
vi.mock("@/lib/bmi-office-client", () => ({
  BMI_CLIENT_KEY: "headpinzftmyers",
  officeGet: (...args: unknown[]) => officeGet(...args),
}));
vi.mock("@/lib/redis", () => ({ default: { get: vi.fn(), set: vi.fn() } }));
// Faithful double of @ft/db parseWithRawIds (vitest can't resolve the cross-package
// alias for an un-mocked load). Mirrors the shipping regex; the real helper has
// its own tests in packages/db.
vi.mock("@ft/db", () => {
  const BMI_ID_FIELDS = ["id", "personId", "personID", "orderId", "billId"];
  function parseWithRawIds(jsonText: string, idFields: readonly string[] = BMI_ID_FIELDS) {
    let text = jsonText;
    for (const field of idFields) {
      text = text.replace(new RegExp(`("${field}"\\s*:\\s*)(\\d+)`, "g"), '$1"$2"');
    }
    return JSON.parse(text);
  }
  return { parseWithRawIds, BMI_ID_FIELDS };
});

import { getRacerAccounts } from "./bmi-race";

afterEach(() => vi.clearAllMocks());

/** Route the mocked officeGet by path, returning a raw JSON body string. */
function route(map: { search?: string; persons?: Record<string, string>; deposits?: string }) {
  officeGet.mockImplementation((path: string) => {
    if (path.includes("/search/person"))
      return Promise.resolve({ status: 200, body: map.search ?? "[]" });
    if (path.includes("/deposit/history"))
      return Promise.resolve({ status: 200, body: map.deposits ?? "[]" });
    const m = path.match(/\/person\/(\d+)/);
    if (m && map.persons?.[m[1]]) return Promise.resolve({ status: 200, body: map.persons[m[1]] });
    return Promise.resolve({ status: 404, body: "{}" });
  });
}

describe("getRacerAccounts", () => {
  it("resolves a racer and preserves a 17-digit person id as a string", async () => {
    route({
      search:
        '[{"localId":10,"description":"Ada Lap (1990) phone: 2395551234 Memberships: Pro Last seen: 2026-06-01"}]',
      persons: {
        // UNQUOTED 17-digit id — JSON.parse would round it; parseWithRawIds must not.
        "10": '{"id":63000000000021716,"firstName":"Ada","name":"Lap","lastLineUp":"2026-06-01T12:00:00","tags":[{"tag":"ADA123","lastSeen":"2026-06-01"}],"memberships":[{"name":"Pro License Fee"}]}',
      },
      deposits: '[{"depositKind":"Race Credit","balance":5},{"depositKind":"Snack","balance":9}]',
    });

    const accounts = await getRacerAccounts("a@b.com", "+12395551234");

    expect(accounts).toHaveLength(1);
    expect(accounts[0].personId).toBe("63000000000021716");
    expect(accounts[0].personId).not.toBe("63000000000021720");
    expect(accounts[0].fullName).toBe("Ada Lap");
    expect(accounts[0].races).toBe(1);
    // Only credit/pass deposits with a positive balance.
    expect(accounts[0].credits).toEqual([{ kind: "Race Credit", balance: 5 }]);
  });

  it("drops contact-person stubs (no check-in tag) and keeps the real racer", async () => {
    route({
      search:
        '[{"localId":1,"description":"Bob Stub phone: 2395550000"},{"localId":2,"description":"Cy Real (1985) Memberships: x Last seen: 2026-05-01"}]',
      persons: {
        "1": '{"id":111,"firstName":"Bob","name":"Stub","tags":[]}',
        "2": '{"id":222,"firstName":"Cy","name":"Real","tags":[{"tag":"CY9","lastSeen":"2026-05-01"}]}',
      },
    });

    const accounts = await getRacerAccounts("p", "+12395550000");
    expect(accounts.map((a) => a.fullName)).toEqual(["Cy Real"]);
  });

  it("returns multiple racers linked to one phone", async () => {
    route({
      search:
        '[{"localId":1,"description":"Mom One (1980) Memberships: a"},{"localId":2,"description":"Kid Two (2012) Memberships: b"}]',
      persons: {
        "1": '{"id":1,"firstName":"Mom","name":"One","tags":[{"tag":"M1"}],"memberships":[{"name":"Pro"}]}',
        "2": '{"id":2,"firstName":"Kid","name":"Two","tags":[{"tag":"K2"}],"memberships":[{"name":"Intermediate"}]}',
      },
    });

    const accounts = await getRacerAccounts("p", "+12395551234");
    expect(accounts).toHaveLength(2);
    expect(accounts.map((a) => a.fullName).sort()).toEqual(["Kid Two", "Mom One"]);
  });

  it("returns [] for a non-10-digit phone without calling the API", async () => {
    const accounts = await getRacerAccounts("p", "+1239");
    expect(accounts).toEqual([]);
    expect(officeGet).not.toHaveBeenCalled();
  });
});
