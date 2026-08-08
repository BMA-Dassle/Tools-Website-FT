import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "./route";

/**
 * "Not found" was a lie for a whole class of person.
 *
 * A BMI person whose BIRTHDATE IS NULL makes Pandora's GET /bmi/person return
 * 500 "Response Validator Error" — the record EXISTS, the vendor's own response
 * schema rejects it. Booking creates people without a birthdate, so this is the
 * normal state of anyone who booked online and never signed anywhere. This
 * proxy reported all of it as `reason: "Not found"`, which is how a guest who
 * HAD signed was told to sign again for weeks (proven live 2026-08-07).
 *
 * Still `valid: false` — fail closed, never wave through an unverified racer —
 * but the caller can now tell "no such person" from "we couldn't read them",
 * and the second kind is repairable.
 */

const req = (personId: string) =>
  new NextRequest(`https://x/api/pandora?personId=${personId}&location=fasttrax`);

beforeEach(() => vi.spyOn(console, "warn").mockImplementation(() => {}));
afterEach(() => vi.restoreAllMocks());

describe("GET /api/pandora — unreadable vs not found", () => {
  it("flags the null-birthdate 500 as UNREADABLE, not 'Not found'", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 500,
        json: async () => ({
          success: false,
          message: "Server Error",
          error: "Response Validator Error",
        }),
      })),
    );
    const body = await (await GET(req("63000000007642347"))).json();
    expect(body.valid).toBe(false); // fail closed, unchanged
    expect(body.unreadable).toBe(true);
    expect(body.reason).toContain("500");
    expect(body.reason).not.toContain("Not found");
  });

  it("still reports a genuine 404 as not found, and not as unreadable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 404,
        json: async () => ({ success: false, message: "Not found" }),
      })),
    );
    const body = await (await GET(req("999"))).json();
    expect(body.valid).toBe(false);
    expect(body.unreadable).toBe(false);
    expect(body.reason).toBe("Not found");
  });

  it("returns a live waiver as valid", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: { waiverExpiry: "2027-08-08T13:00:00.000Z", firstName: "Test7" },
        }),
      })),
    );
    const body = await (await GET(req("63000000007654827"))).json();
    expect(body.valid).toBe(true);
  });

  it("a readable person with no waiver is valid:false but NOT unreadable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: { waiverExpiry: null } }),
      })),
    );
    const body = await (await GET(req("58096162"))).json();
    expect(body.valid).toBe(false);
    // The distinction that matters: this one is a real answer, not a failure.
    expect(body.unreadable).toBeUndefined();
  });
});
