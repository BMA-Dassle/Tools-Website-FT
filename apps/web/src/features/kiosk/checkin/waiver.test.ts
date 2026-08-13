import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const store = { hasUnexpiredCapturedWaiver: vi.fn<(id: string) => Promise<boolean>>() };
vi.mock("@/lib/waiver-signature-store", () => ({
  hasUnexpiredCapturedWaiver: (id: string) => store.hasUnexpiredCapturedWaiver(id),
}));

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
  // Default: we hold nothing. Every pre-existing test keeps its original meaning.
  store.hasUnexpiredCapturedWaiver.mockResolvedValue(false);
  vi.spyOn(console, "log").mockImplementation(() => {});
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

/**
 * OUR RECORD COUNTS — the read that makes "stop waiting for cloud→local sync"
 * safe (2026-08-13).
 *
 * The kiosk now finishes a waiver before BMI has it, so for ~20-30s Pandora
 * honestly answers "no waiver" while the push is in the queue. Without this union
 * the delay is not removed, it MOVES to the check-in desk — a guest who signed a
 * minute ago is sent back to a signature pad, now with staff involved.
 *
 * The fail-closed rule that guards the karts is intact: we only ever ADD a YES on
 * evidence we hold (a drawn signature, terms version, and an unexpired date). A
 * person with nothing in either place is still refused.
 */
describe("checkRacerWaiverValid — Neon union while the vendor push is in flight", () => {
  it("counts a signature WE hold when BMI reports none yet", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ok(null)),
    );
    store.hasUnexpiredCapturedWaiver.mockResolvedValue(true);
    expect(await checkRacerWaiverValid("63000000008220449")).toBe(true);
  });

  it("still refuses a racer neither side has ever seen", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ok(null)),
    );
    store.hasUnexpiredCapturedWaiver.mockResolvedValue(false);
    expect(await checkRacerWaiverValid("63000000008220449")).toBe(false);
  });

  it("does NOT ask Neon when BMI already says yes — one read is enough", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ok("2027-08-13T13:00:00.000Z")),
    );
    expect(await checkRacerWaiverValid("58096162")).toBe(true);
    expect(store.hasUnexpiredCapturedWaiver).not.toHaveBeenCalled();
  });

  it("an UNREADABLE record (null-birthdate 500) falls back to our record", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => err500),
    );
    store.hasUnexpiredCapturedWaiver.mockResolvedValue(true);
    expect(await checkRacerWaiverValid("63000000008220449")).toBe(true);
  });

  it("a vendor OUTAGE falls back to our record instead of failing the guest", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNRESET");
      }),
    );
    store.hasUnexpiredCapturedWaiver.mockResolvedValue(true);
    expect(await checkRacerWaiverValid("63000000008220449")).toBe(true);
  });

  it("a Neon failure during the fallback still fails CLOSED", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => err500),
    );
    store.hasUnexpiredCapturedWaiver.mockRejectedValue(new Error("db down"));
    expect(await checkRacerWaiverValid("63000000008220449")).toBe(false);
  });
});
