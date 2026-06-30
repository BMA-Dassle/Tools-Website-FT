import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The whole point of routing BMI reads through parseWithRawIds: a 17-digit
 * personId must survive as a full-precision STRING. If anything JSON.parses it,
 * 63000000000021716 rounds to ...720 and we look up the WRONG racer.
 */

const officeGet = vi.fn();
vi.mock("@/lib/bmi-office-client", () => ({
  BMI_CLIENT_KEY: "headpinzftmyers",
  officeGet: (...args: unknown[]) => officeGet(...args),
}));
// Faithful double of @ft/db's parseWithRawIds (vitest can't resolve the
// cross-package alias for an un-mocked load — packages/db is outside the
// apps/web vite root). The double mirrors the SHIPPING regex verbatim: it
// pre-quotes unquoted numeric id fields so 17-digit ids survive as strings.
// The real helper has its own tests in packages/db; this verifies bmi-race
// reads res.text() and runs the parse (it does NOT JSON.parse the id away).
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
// bmi-race imports redis at module load (for resolveBmiPerson); stub it so the
// test never opens a real connection.
vi.mock("@/lib/redis", () => ({ default: { get: vi.fn(), set: vi.fn() } }));

import { searchBmiPersonByPhone } from "./bmi-race";

afterEach(() => vi.clearAllMocks());

describe("searchBmiPersonByPhone — id precision", () => {
  it("preserves a 17-digit personId as an unrounded string", async () => {
    // UNQUOTED 17-digit id in the raw body — exactly the shape that JSON.parse
    // would corrupt. parseWithRawIds must quote it before parsing.
    officeGet.mockResolvedValue({
      status: 200,
      body: '{"persons":[{"personId":63000000000021716,"firstName":"Ada","lastName":"Lap","phoneNumber":"(239) 555-1234"}]}',
    });

    const res = await searchBmiPersonByPhone("+12395551234");

    expect(res.ambiguous).toBe(false);
    expect(res.person?.personId).toBe("63000000000021716");
    // Guard against the rounded value sneaking through.
    expect(res.person?.personId).not.toBe("63000000000021720");
    expect(res.person?.firstName).toBe("Ada");
  });

  it("flags >1 phone-exact match as ambiguous (never auto-picks)", async () => {
    officeGet.mockResolvedValue({
      status: 200,
      body: '{"persons":[{"personId":63000000000000001,"firstName":"A","lastName":"X","phone":"2395551234"},{"personId":63000000000000002,"firstName":"B","lastName":"Y","phone":"239-555-1234"}]}',
    });

    const res = await searchBmiPersonByPhone("+12395551234");

    expect(res.ambiguous).toBe(true);
    expect(res.person).toBeNull();
    expect(res.candidates.map((c) => c.personId)).toEqual([
      "63000000000000001",
      "63000000000000002",
    ]);
  });

  it("returns empty for a non-10-digit phone without calling the API", async () => {
    const res = await searchBmiPersonByPhone("+1239");
    expect(res.person).toBeNull();
    expect(officeGet).not.toHaveBeenCalled();
  });
});
