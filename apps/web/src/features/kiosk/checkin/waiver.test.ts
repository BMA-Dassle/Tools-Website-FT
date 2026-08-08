import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { checkRacerWaiverValid, checkRacerWaivers } from "./waiver";

/**
 * The null-birthdate 500 (proven live 2026-08-07).
 *
 * Pandora's GET /bmi/person returns 500 "Response Validator Error" when the
 * person has no birthdate — the record EXISTS, the vendor's own response schema
 * rejects it. Booking creates people without one, so this is the normal state
 * of anyone who booked online and never signed anywhere. For weeks it rendered
 * as a confident "Waiver needed" for guests who HAD signed: Eric's waiver was
 * valid to 2027-08-08 the whole time the kiosk was asking him to sign again.
 *
 * These pin the behaviour that matters: an unreadable record STILL fails closed
 * (never let an unverified racer onto a kart), but it is no longer silent.
 */

const ok = (waiverExpiry: string | null) => ({
  ok: true,
  status: 200,
  json: async () => ({ success: true, data: { waiverExpiry } }),
});
const err500 = {
  ok: false,
  status: 500,
  json: async () => ({
    success: false,
    message: "Server Error",
    error: "Response Validator Error",
  }),
};

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("checkRacerWaiverValid", () => {
  it("is true for a live waiver", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ok("2027-08-08T13:00:00.000Z")),
    );
    await expect(checkRacerWaiverValid("58096162")).resolves.toBe(true);
  });

  it("is false for an expired waiver", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ok("2020-01-01T00:00:00.000Z")),
    );
    await expect(checkRacerWaiverValid("58096162")).resolves.toBe(false);
  });

  it("is false when the record reads cleanly with NO waiver — a real negative", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ok(null)),
    );
    await expect(checkRacerWaiverValid("58096162")).resolves.toBe(false);
    // A genuine "no waiver" is not an anomaly, so it must NOT be logged as one.
    expect(warn).not.toHaveBeenCalled();
  });

  it("FAILS CLOSED on the null-birthdate 500, and says so", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => err500),
    );
    await expect(checkRacerWaiverValid("63000000007642347")).resolves.toBe(false);
    const msg = String(warn.mock.calls[0]?.[0] ?? "");
    expect(msg).toContain("63000000007642347");
    expect(msg).toContain("UNREADABLE");
    // The log has to name the cause, or it is just noise.
    expect(msg).toContain("birthdate");
  });

  it("fails closed and logs on a network error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("timeout");
      }),
    );
    await expect(checkRacerWaiverValid("58096162")).resolves.toBe(false);
    expect(String(warn.mock.calls[0]?.[0] ?? "")).toContain("timeout");
  });

  it("is false for an empty person id without calling out", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    await expect(checkRacerWaiverValid("")).resolves.toBe(false);
    expect(f).not.toHaveBeenCalled();
  });
});

describe("checkRacerWaivers", () => {
  it("maps each id, and an unreadable one does not poison the readable ones", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).includes("63000000007642347") ? err500 : ok("2027-08-08T13:00:00.000Z"),
      ),
    );
    const out = await checkRacerWaivers(["58096162", "63000000007642347", null, undefined]);
    expect(out.get("58096162")).toBe(true);
    expect(out.get("63000000007642347")).toBe(false);
    // Ids that were never real are absent rather than false.
    expect(out.size).toBe(2);
  });
});
