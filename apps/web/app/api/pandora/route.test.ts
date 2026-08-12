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

// ── POST: the cloud-first mint seam ─────────────────────────────────────────
// This route is the ONE place all 16 person-mint call sites funnel through
// (KioskPartyManager ×6, KioskPeopleStep ×6, mobile join ×2, check-in, web group
// event — all via lib/pandora.ts). Switching the rail here moves every surface,
// so these tests pin the switch, the kill switch, and the guardian exception.

// SPREAD THE REAL MODULE (`async (orig) => ({...(await orig())})`) — the idiom
// bmi-attach.test.ts / attach-order-id.test.ts use. A bare replacement strips
// every other export for any test sharing this worker's module registry, which
// is exactly how the first cut of these tests broke five unrelated signage
// suites that pass in isolation.
const officeMock = { createOfficePerson: vi.fn() };
vi.mock("@/lib/bmi-office-actions", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  createOfficePerson: (...a: unknown[]) =>
    (officeMock.createOfficePerson as (...a: unknown[]) => unknown)(...a),
}));
const queueMock = { enqueueSync: vi.fn(async () => ({ id: 1 })) };
vi.mock("@/lib/bmi-sync-queue", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  enqueueSync: (...a: unknown[]) => (queueMock.enqueueSync as (...a: unknown[]) => unknown)(...a),
}));

const postReq = (body: Record<string, unknown>) =>
  new NextRequest("https://x/api/pandora", { method: "POST", body: JSON.stringify(body) });

const NEW_GUEST = {
  firstName: "Ann",
  lastName: "Lee",
  birthdate: "1990-01-01",
  email: "a@b.c",
  phone: "(239) 555-1234",
  location: "fasttrax",
};

describe("POST /api/pandora — cloud-first person mint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.PERSON_MINT_CLOUD_FIRST;
    officeMock.createOfficePerson.mockResolvedValue({ personId: "63000000008163503" });
  });

  it("mints on the OFFICE cloud rail and keeps the { personId } contract its 16 callers expect", async () => {
    const { POST } = await import("./route");
    const body = await (await POST(postReq(NEW_GUEST))).json();
    expect(body.personId).toBe("63000000008163503");
    expect(body.rail).toBe("office-cloud");
    expect(officeMock.createOfficePerson).toHaveBeenCalledWith(
      expect.objectContaining({ firstName: "Ann", lastName: "Lee", birthdate: "1990-01-01" }),
    );
  });

  /**
   * Every new person gets the DEFAULT REGISTRATION membership (owner
   * 2026-08-12). This assertion exists because the membership handler shipped
   * with NO enqueuer wired — the machinery looked present while a signer's
   * Memberships tab stayed empty in BMI, caught live on "Test 14". A mechanism
   * with no trigger is worse than none, so the trigger is pinned here.
   */
  it("always queues the REGISTRATION membership, behind person-local", async () => {
    const { POST } = await import("./route");
    await POST(postReq(NEW_GUEST));
    expect(queueMock.enqueueSync).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "add-membership",
        barrier: "person-local",
        barrierRef: "63000000008163503",
      }),
    );
  });

  it("with a birthdate it does NOT queue a repair — an Office mint lands readable", async () => {
    const { POST } = await import("./route");
    await POST(postReq(NEW_GUEST));
    const kinds = queueMock.enqueueSync.mock.calls.map((c) => (c[0] as { kind: string }).kind);
    expect(kinds).toContain("add-membership");
    expect(kinds).not.toContain("repair-person-details");
  });

  it("with NO birthdate it queues the repair — that record would read 500 on Pandora forever", async () => {
    const { POST } = await import("./route");
    const noDob = { ...NEW_GUEST, birthdate: undefined };
    await POST(postReq(noDob));
    const kinds = queueMock.enqueueSync.mock.calls.map((c) => (c[0] as { kind: string }).kind);
    expect(kinds).toContain("repair-person-details");
    // …and the registration still rides along.
    expect(kinds).toContain("add-membership");
  });

  it("routes Naples to its own client key", async () => {
    const { POST } = await import("./route");
    await POST(postReq({ ...NEW_GUEST, location: "naples" }));
    expect(officeMock.createOfficePerson).toHaveBeenCalledWith(
      expect.objectContaining({ centerCode: "naples" }),
    );
  });

  it("a GUARDIAN-linked minor stays on Pandora — the cloud create has no guardian field", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: { personID: "8593399" } }),
      })),
    );
    const { POST } = await import("./route");
    const body = await (await POST(postReq({ ...NEW_GUEST, guardianID: "8593300" }))).json();
    expect(body.rail).toBe("pandora-local");
    expect(body.personId).toBe("8593399");
    expect(officeMock.createOfficePerson).not.toHaveBeenCalled();
  });

  it("PERSON_MINT_CLOUD_FIRST=false reverts to the Pandora mint", async () => {
    process.env.PERSON_MINT_CLOUD_FIRST = "false";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: { personID: "8593400" } }),
      })),
    );
    const { POST } = await import("./route");
    const body = await (await POST(postReq(NEW_GUEST))).json();
    expect(body.rail).toBe("pandora-local");
    expect(officeMock.createOfficePerson).not.toHaveBeenCalled();
  });

  it("still rejects a nameless request before touching any rail", async () => {
    const { POST } = await import("./route");
    const res = await POST(postReq({ firstName: "", lastName: "" }));
    expect(res.status).toBe(400);
    expect(officeMock.createOfficePerson).not.toHaveBeenCalled();
  });

  it("a failed enqueue does NOT fail the mint — the queue is a backstop", async () => {
    queueMock.enqueueSync.mockRejectedValueOnce(new Error("db down"));
    const { POST } = await import("./route");
    const noDob = { ...NEW_GUEST, birthdate: undefined };
    const body = await (await POST(postReq(noDob))).json();
    expect(body.personId).toBe("63000000008163503");
  });
});
