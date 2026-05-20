import { describe, expect, it } from "vitest";
import { validateInput } from "./validation";

const minimal = {
  code: "TEST20",
  mechanic: "percent" as const,
  amountPct: 20,
  startsAt: "2026-05-01T00:00:00Z",
  expiresAt: "2026-06-01T00:00:00Z",
  scopes: { bowling: { experienceSlugs: null } },
};

describe("validateInput", () => {
  it("accepts a minimal percent code with bowling scope", () => {
    const r = validateInput(minimal);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.code).toBe("TEST20");
      expect(r.value.mechanic).toBe("percent");
      expect(r.value.amountPct).toBe(20);
      expect(r.value.scopes.bowling).toEqual({ experienceSlugs: null });
    }
  });

  it("rejects empty body", () => {
    expect(validateInput(null).ok).toBe(false);
    expect(validateInput(undefined).ok).toBe(false);
    expect(validateInput("string").ok).toBe(false);
  });

  it("rejects malformed code", () => {
    expect(validateInput({ ...minimal, code: "" }).ok).toBe(false);
    expect(validateInput({ ...minimal, code: "ab" }).ok).toBe(false); // too short
    expect(validateInput({ ...minimal, code: "has space" }).ok).toBe(false);
    expect(validateInput({ ...minimal, code: "x".repeat(50) }).ok).toBe(false); // too long
  });

  it("rejects bogo / free_addon mechanics until they're supported", () => {
    expect(validateInput({ ...minimal, mechanic: "bogo" }).ok).toBe(false);
    expect(validateInput({ ...minimal, mechanic: "free_addon" }).ok).toBe(false);
  });

  it("requires amountPct in 1..100 for percent mechanic", () => {
    expect(validateInput({ ...minimal, amountPct: 0 }).ok).toBe(false);
    expect(validateInput({ ...minimal, amountPct: 101 }).ok).toBe(false);
    expect(validateInput({ ...minimal, amountPct: undefined }).ok).toBe(false);
  });

  it("requires positive integer amountCents for fixed mechanic", () => {
    expect(
      validateInput({ ...minimal, mechanic: "fixed", amountPct: undefined, amountCents: 0 }).ok,
    ).toBe(false);
    expect(
      validateInput({ ...minimal, mechanic: "fixed", amountPct: undefined, amountCents: 1.5 }).ok,
    ).toBe(false);
    expect(
      validateInput({ ...minimal, mechanic: "fixed", amountPct: undefined, amountCents: 100 }).ok,
    ).toBe(true);
  });

  it("rejects expiresAt <= startsAt", () => {
    expect(
      validateInput({
        ...minimal,
        startsAt: "2026-05-01T00:00:00Z",
        expiresAt: "2026-05-01T00:00:00Z",
      }).ok,
    ).toBe(false);
  });

  it("rejects weekday values outside 0..6", () => {
    expect(validateInput({ ...minimal, allowedWeekdays: [-1, 0] }).ok).toBe(false);
    expect(validateInput({ ...minimal, allowedWeekdays: [7] }).ok).toBe(false);
    expect(validateInput({ ...minimal, allowedWeekdays: [1.5] }).ok).toBe(false);
  });

  it("requires at least one domain in scopes", () => {
    expect(validateInput({ ...minimal, scopes: {} }).ok).toBe(false);
  });

  it("accepts attractions scope with slug allowlist", () => {
    const r = validateInput({
      ...minimal,
      scopes: { attractions: { slugs: ["gel-blaster", "shuffly"] } },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.scopes.attractions).toEqual({ slugs: ["gel-blaster", "shuffly"] });
  });

  it("uppercases the code on the way in", () => {
    const r = validateInput({ ...minimal, code: "may20" });
    if (r.ok) expect(r.value.code).toBe("MAY20");
  });
});
