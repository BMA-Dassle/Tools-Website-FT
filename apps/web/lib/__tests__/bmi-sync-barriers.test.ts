import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const office = { fetchOfficePerson: vi.fn<(id: string, ck?: string) => Promise<unknown>>() };
vi.mock("@/lib/bmi-office-actions", () => ({
  fetchOfficePerson: (...a: unknown[]) =>
    (office.fetchOfficePerson as (...a: unknown[]) => unknown)(...a),
}));

import { personLocalBarrier, personCloudBarrier, projectLocalBarrier } from "../bmi-sync-barriers";

const reply = (status: number, body: unknown = {}) =>
  ({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }) as unknown as Response;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SWAGGER_ADMIN_KEY = "test-key";
});
afterEach(() => {
  vi.unstubAllGlobals();
});

// ── the rule the whole cloud-first design rests on ──────────────────────────
// Measured live 2026-08-12: a cloud-minted person answers 500 "Response
// Validator Error" while its birthdate is null — it IS present locally. Only a
// 404 means absent. A barrier that waited for 200 would wait forever on a row
// that had already landed (and would starve the repair handler that fixes the
// very 500 it is looking at).
describe("personLocalBarrier — 404 vs 500 vs 200", () => {
  it("404 is the ONLY absent verdict → closed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => reply(404, { success: false, message: "No person found with that ID." })),
    );
    const r = await personLocalBarrier("LAB52GY480CJF", "63000000009999999");
    expect(r.verdict).toBe("closed");
    expect(r.detail).toMatch(/404/);
  });

  it("500 Response Validator Error is PRESENT → open (so the repair handler can run)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => reply(500, { success: false, error: "Response Validator Error" })),
    );
    const r = await personLocalBarrier("LAB52GY480CJF", "63000000008158427");
    expect(r.verdict).toBe("open");
    expect(r.detail).toMatch(/birthdate null/i);
  });

  it("200 → open", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => reply(200, { success: true, data: { id: "1" } })),
    );
    expect((await personLocalBarrier("LAB52GY480CJF", "1")).verdict).toBe("open");
  });

  it("other failures are 'error' (could not ask), never a false 'open'", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => reply(503)),
    );
    expect((await personLocalBarrier("LAB52GY480CJF", "1")).verdict).toBe("error");
  });

  it("a network throw is 'error', not 'open'", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("ECONNRESET"))),
    );
    const r = await personLocalBarrier("LAB52GY480CJF", "1");
    expect(r.verdict).toBe("error");
    expect(r.detail).toMatch(/ECONNRESET/);
  });

  it("missing creds is 'error' — never assume visibility", async () => {
    delete process.env.SWAGGER_ADMIN_KEY;
    expect((await personLocalBarrier("LAB52GY480CJF", "1")).verdict).toBe("error");
  });
});

describe("personCloudBarrier (local→cloud, the jam-prone direction)", () => {
  it("opens when the Office person resolves", async () => {
    office.fetchOfficePerson.mockResolvedValueOnce({ id: "63000000008163503" });
    expect((await personCloudBarrier("63000000008163503")).verdict).toBe("open");
  });
  it("closes when it does not (not synced up yet, or Office unwell — both mean wait)", async () => {
    office.fetchOfficePerson.mockResolvedValueOnce(null);
    expect((await personCloudBarrier("63000000008163503")).verdict).toBe("closed");
  });
  it("forwards the clientKey", async () => {
    office.fetchOfficePerson.mockResolvedValueOnce({ id: "x" });
    await personCloudBarrier("x", "headpinznaples");
    expect(office.fetchOfficePerson).toHaveBeenCalledWith("x", "headpinznaples");
  });
});

describe("projectLocalBarrier (cloud→local reservation sync)", () => {
  it("404 → closed (not synced down yet)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => reply(404, { success: false })),
    );
    expect((await projectLocalBarrier("LAB52GY480CJF", "63000000008065144")).verdict).toBe(
      "closed",
    );
  });
  it("200 + success:true → open", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => reply(200, { success: true, data: {} })),
    );
    expect((await projectLocalBarrier("LAB52GY480CJF", "63000000008065144")).verdict).toBe("open");
  });
  it("200 with success:false → closed, NOT open (the 200-is-not-success trap)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => reply(200, { success: false })),
    );
    const r = await projectLocalBarrier("LAB52GY480CJF", "63000000008065144");
    expect(r.verdict).toBe("closed");
  });
  it("5xx → error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => reply(500, {})),
    );
    expect((await projectLocalBarrier("LAB52GY480CJF", "1")).verdict).toBe("error");
  });
});

// ── partyReadyBarrier — the gate on the Confirmation Kiosk/Express flip ──────
// Owner 2026-08-12: the flip "should happen only when the rest of the party has
// sync'ed and we have verified all have the waivers". Staff read that state as
// "party is here and checked in", so it must never be stamped on a maybe. Note
// the deliberate asymmetry with personLocalBarrier: there a 500 is OPEN (present
// but unreadable is what the repair fixes); HERE a 500 is closed, because an
// unreadable record cannot prove a waiver and proving one is the whole job.
import { partyReadyBarrier } from "../bmi-sync-barriers";

const person = (waiverExpiry: string | null, status = 200) =>
  ({
    status,
    ok: status >= 200 && status < 300,
    json: async () => ({ success: status === 200, data: { waiverExpiry } }),
    text: async () => "",
  }) as unknown as Response;

const future = new Date(Date.now() + 86_400_000).toISOString();
const past = new Date(Date.now() - 86_400_000).toISOString();

describe("partyReadyBarrier", () => {
  beforeEach(() => {
    process.env.SWAGGER_ADMIN_KEY = "k";
  });

  it("opens only when EVERY member is local with a live waiver", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => person(future)),
    );
    const r = await partyReadyBarrier("LAB52GY480CJF", ["1", "2", "3"]);
    expect(r.verdict).toBe("open");
    expect(r.detail).toContain("3");
  });

  it("one member not yet synced closes the gate", async () => {
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => (++n === 2 ? person(null, 404) : person(future))),
    );
    const r = await partyReadyBarrier("LAB52GY480CJF", ["1", "2", "3"]);
    expect(r.verdict).toBe("closed");
    expect(r.detail).toMatch(/not synced local/);
  });

  it("one member without a waiver closes the gate — the state would be a false claim", async () => {
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => (++n === 3 ? person(null) : person(future))),
    );
    const r = await partyReadyBarrier("LAB52GY480CJF", ["1", "2", "3"]);
    expect(r.verdict).toBe("closed");
    expect(r.detail).toMatch(/without a valid waiver/);
  });

  it("an EXPIRED waiver is not a waiver", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => person(past)),
    );
    expect((await partyReadyBarrier("LAB52GY480CJF", ["1"])).verdict).toBe("closed");
  });

  it("a 500 (present but unreadable) closes HERE, unlike personLocalBarrier", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => person(null, 500)),
    );
    const r = await partyReadyBarrier("LAB52GY480CJF", ["1"]);
    expect(r.verdict).toBe("closed");
    expect(r.detail).toMatch(/unreadable/);
  });

  it("an empty party list closes — stamping on nothing is the false claim we are preventing", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    const r = await partyReadyBarrier("LAB52GY480CJF", []);
    expect(r.verdict).toBe("closed");
    expect(f).not.toHaveBeenCalled();
  });

  it("dedupes members so one person on two rows is asked about once", async () => {
    const f = vi.fn(async () => person(future));
    vi.stubGlobal("fetch", f);
    await partyReadyBarrier("LAB52GY480CJF", ["7", "7", "7"]);
    expect(f).toHaveBeenCalledTimes(1);
  });
});
