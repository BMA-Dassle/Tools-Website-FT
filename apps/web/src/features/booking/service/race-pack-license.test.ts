import { describe, it, expect, vi, beforeEach } from "vitest";

// The license gate reads the BMI Office person record — mock that boundary so
// these tests exercise ONLY the money-safety decision logic (no network / DB).
vi.mock("~/features/daily-events/data/bmi-office", () => ({
  fetchPersonRaw: vi.fn(),
}));

import { fetchPersonRaw } from "~/features/daily-events/data/bmi-office";
import { personHasActiveLicense, personNeedsLicense } from "./race-pack-license.server";

const mockFetch = vi.mocked(fetchPersonRaw);

beforeEach(() => {
  mockFetch.mockReset();
});

describe("personHasActiveLicense", () => {
  it("true when an active License Fee membership is on file", async () => {
    mockFetch.mockResolvedValue({ memberships: [{ name: "License Fee", stops: null }] });
    expect(await personHasActiveLicense("123")).toBe(true);
  });

  it("true when the license membership stops in the future", async () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    mockFetch.mockResolvedValue({ memberships: [{ name: "License Fee", stops: future }] });
    expect(await personHasActiveLicense("123")).toBe(true);
  });

  it("false when the only license membership has already lapsed", async () => {
    mockFetch.mockResolvedValue({
      memberships: [{ name: "License Fee", stops: "2020-01-01T00:00:00Z" }],
    });
    expect(await personHasActiveLicense("123")).toBe(false);
  });

  it("false when no license membership exists", async () => {
    mockFetch.mockResolvedValue({ memberships: [{ name: "Intermediate", stops: null }] });
    expect(await personHasActiveLicense("123")).toBe(false);
  });

  it("null when the record can't be read (Office lag / error)", async () => {
    mockFetch.mockRejectedValue(new Error("404"));
    expect(await personHasActiveLicense("123")).toBe(null);
  });

  it("null for a non-numeric personId (never touches the network)", async () => {
    expect(await personHasActiveLicense("not-an-id")).toBe(null);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("personNeedsLicense (money-safe gate)", () => {
  it("NEVER charges a verified-licensed racer, even if the client says new", async () => {
    mockFetch.mockResolvedValue({ memberships: [{ name: "License Fee", stops: null }] });
    expect(await personNeedsLicense("123", true)).toBe(false);
  });

  it("charges a verified-unlicensed racer (e.g. lapsed license) regardless of the hint", async () => {
    mockFetch.mockResolvedValue({ memberships: [] });
    expect(await personNeedsLicense("123", false)).toBe(true);
  });

  it("falls back to the new-racer hint when the record can't be read", async () => {
    mockFetch.mockRejectedValue(new Error("Office lag"));
    expect(await personNeedsLicense("123", true)).toBe(true);
    expect(await personNeedsLicense("123", false)).toBe(false);
  });
});
