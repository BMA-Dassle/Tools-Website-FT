import { afterEach, describe, expect, it } from "vitest";
import { bmiKeyScope } from "@/lib/bmi-key-scope";
import { ARENA_CENTERS, activeArenaCenters, arenaCenterForLocation } from "./centers";
import { HP_FM_LOCATION_ID, HP_NAPLES_LOCATION_ID, arenaLocationMeta } from "./constants";

const FASTTRAX_LOCATION_ID = "LAB52GY480CJF";

describe("bmiKeyScope", () => {
  it("keeps the legacy (empty) shape for the shared FM BMI server", () => {
    // Byte-identical legacy keys are the no-migration guarantee: every
    // live FM dedup/ticket key must still be found after this change.
    expect(bmiKeyScope(FASTTRAX_LOCATION_ID)).toBe("");
    expect(bmiKeyScope(HP_FM_LOCATION_ID)).toBe("");
  });

  it("maps absent/blank locationIds to the legacy shape (back-compat)", () => {
    expect(bmiKeyScope(undefined)).toBe("");
    expect(bmiKeyScope(null)).toBe("");
    expect(bmiKeyScope("")).toBe("");
    expect(bmiKeyScope("  ")).toBe("");
  });

  it("scopes Naples (separate BMI server) with a locationId segment", () => {
    expect(bmiKeyScope(HP_NAPLES_LOCATION_ID)).toBe(`${HP_NAPLES_LOCATION_ID}:`);
  });

  it("produces colliding-id-proof keys across BMI servers", () => {
    // Same numeric BMI ids at FM and Naples must land on DIFFERENT keys.
    const sid = 55;
    const pid = 12345;
    const fmKey = `ticket:bySession:${bmiKeyScope(HP_FM_LOCATION_ID)}${sid}:${pid}`;
    const naplesKey = `ticket:bySession:${bmiKeyScope(HP_NAPLES_LOCATION_ID)}${sid}:${pid}`;
    expect(fmKey).toBe("ticket:bySession:55:12345"); // legacy shape preserved
    expect(naplesKey).toBe(`ticket:bySession:${HP_NAPLES_LOCATION_ID}:55:12345`);
    expect(fmKey).not.toBe(naplesKey);
  });
});

describe("arena centers", () => {
  afterEach(() => {
    delete process.env.ARENA_NAPLES;
  });

  it("serves FM and Naples by default (kill switch defaults ON)", () => {
    delete process.env.ARENA_NAPLES;
    const keys = activeArenaCenters().map((c) => c.key);
    expect(keys).toEqual(["hp-fm", "hp-naples"]);
  });

  it("drops Naples only on the explicit kill switch value", () => {
    process.env.ARENA_NAPLES = "false";
    expect(activeArenaCenters().map((c) => c.key)).toEqual(["hp-fm"]);
    // Any other value keeps it on — kill switch, not an opt-in gate.
    process.env.ARENA_NAPLES = "true";
    expect(activeArenaCenters().map((c) => c.key)).toEqual(["hp-fm", "hp-naples"]);
  });

  it("never disables FM", () => {
    process.env.ARENA_NAPLES = "false";
    expect(activeArenaCenters().some((c) => c.key === "hp-fm")).toBe(true);
  });

  it("resolves centers by locationId", () => {
    expect(arenaCenterForLocation(HP_FM_LOCATION_ID)?.key).toBe("hp-fm");
    expect(arenaCenterForLocation(HP_NAPLES_LOCATION_ID)?.key).toBe("hp-naples");
    expect(arenaCenterForLocation(FASTTRAX_LOCATION_ID)).toBeNull();
    expect(arenaCenterForLocation(undefined)).toBeNull();
  });

  it("keeps each center's guest-facing contact details location-correct", () => {
    const fm = arenaCenterForLocation(HP_FM_LOCATION_ID)!;
    const naples = arenaCenterForLocation(HP_NAPLES_LOCATION_ID)!;
    expect(fm.address).toContain("Fort Myers");
    expect(naples.address).toContain("Naples");
    // Contact details that a GUEST reads stay per-location. The phone
    // numbers guests call are unaffected by the A2P sender consolidation.
    expect(fm.phoneTel).not.toBe(naples.phoneTel);
    // Both centers ride the same probed dayplanner resource name.
    for (const c of ARENA_CENTERS) {
      expect(c.resources).toContain("HP Arena");
    }
  });

  it("sends BOTH centers from the one A2P number", () => {
    // Inverted deliberately. This used to assert the two centers had
    // DIFFERENT senders, which was the right drift guard when three DIDs
    // carried automated traffic. They are now one number on purpose:
    // guests reply STOP to a single sender whose inbound webhook we own,
    // and the templates already lead with the brand so a shared DID stays
    // unambiguous. A per-center sender reappearing here would silently
    // reintroduce replies landing on a number nothing listens to.
    const fm = arenaCenterForLocation(HP_FM_LOCATION_ID)!;
    const naples = arenaCenterForLocation(HP_NAPLES_LOCATION_ID)!;
    expect(fm.smsFrom).toBe(naples.smsFrom);
    expect(fm.smsFrom).toBe("+12394412867");
  });

  it("falls back to FM meta for legacy/unknown ticket locationIds", () => {
    expect(arenaLocationMeta(undefined).address).toContain("Fort Myers");
    expect(arenaLocationMeta("SOMETHINGELSE").address).toContain("Fort Myers");
    expect(arenaLocationMeta(HP_NAPLES_LOCATION_ID).address).toContain("Naples");
  });
});
