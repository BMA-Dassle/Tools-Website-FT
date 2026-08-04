/**
 * anyDuplicateWaiverValid: OR the Pandora waiver check across a racer's hidden
 * duplicate records. The invariants under test are the safety ones — an empty
 * cluster costs no fetch, ANY valid duplicate wins, and every failure mode
 * (non-OK, throw, malformed body) resolves to false so a transport hiccup can
 * never fake a signed waiver.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { anyDuplicateWaiverValid } from "./waiver-duplicates";

afterEach(() => vi.restoreAllMocks());

function mockFetch(byId: Record<string, { ok?: boolean; valid?: unknown; throw?: boolean }>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const id = new URL(url, "http://x").searchParams.get("personId") ?? "";
      const entry = byId[id];
      if (!entry || entry.throw) throw new Error("network");
      return {
        ok: entry.ok ?? true,
        json: async () => ({ valid: entry.valid }),
      } as Response;
    }),
  );
}

describe("anyDuplicateWaiverValid", () => {
  it("returns false and never fetches for an empty / undefined cluster", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    expect(await anyDuplicateWaiverValid(undefined)).toBe(false);
    expect(await anyDuplicateWaiverValid([])).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("returns true when ANY duplicate has a valid waiver", async () => {
    mockFetch({ "1": { valid: false }, "2": { valid: true }, "3": { valid: false } });
    expect(await anyDuplicateWaiverValid(["1", "2", "3"])).toBe(true);
  });

  it("returns false when no duplicate is valid", async () => {
    mockFetch({ "1": { valid: false }, "2": { valid: false } });
    expect(await anyDuplicateWaiverValid(["1", "2"])).toBe(false);
  });

  it("treats non-OK, thrown, and non-boolean responses as not-valid", async () => {
    mockFetch({
      "1": { ok: false, valid: true }, // 4xx/5xx — ignored
      "2": { throw: true }, // network error — swallowed
      "3": { valid: "true" }, // string, not strict true — not valid
    });
    expect(await anyDuplicateWaiverValid(["1", "2", "3"])).toBe(false);
  });

  it("forwards the location query when provided", async () => {
    const spy = vi.fn(async () => ({ ok: true, json: async () => ({ valid: true }) }) as Response);
    vi.stubGlobal("fetch", spy);
    await anyDuplicateWaiverValid(["9"], "fasttrax");
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("location=fasttrax"));
  });
});
