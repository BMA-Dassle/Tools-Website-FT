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
