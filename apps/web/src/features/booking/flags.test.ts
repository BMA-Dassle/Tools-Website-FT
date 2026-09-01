/**
 * Kill-switch semantics, pinned.
 *
 * House rule: a merged feature is ON, and a flag exists only to turn it OFF.
 * Every flag here must therefore be `!== "false"` — never `=== "true"`.
 *
 * This test exists because v3 shipped as an opt-in gate and production ran for
 * weeks on a single `NEXT_PUBLIC_BOWLING_ONE_TIME_FLOW="true"` row in Vercel.
 * Deleting that row would have reverted every guest to the classic flow with no
 * deploy and no alert, and nothing in the repo would have explained it.
 */
import { describe, expect, it, afterEach, vi } from "vitest";

vi.mock("@/lib/redis", () => ({ default: {} }));

import {
  bowlingOneTimeFlowEnabled,
  bowlingV3Active,
  fasttraxQamfDuckpinEnabled,
  fasttraxPlayNowEnabled,
  playNowActive,
} from "./flags";

const VAR = "NEXT_PUBLIC_BOWLING_ONE_TIME_FLOW";
const original = process.env[VAR];

afterEach(() => {
  if (original === undefined) delete process.env[VAR];
  else process.env[VAR] = original;
});

describe("bowlingOneTimeFlowEnabled — kill switch, not an opt-in gate", () => {
  it("is ON when the var is absent (the whole point of the flip)", () => {
    delete process.env[VAR];
    expect(bowlingOneTimeFlowEnabled()).toBe(true);
  });

  it('is OFF only for the literal string "false"', () => {
    process.env[VAR] = "false";
    expect(bowlingOneTimeFlowEnabled()).toBe(false);
  });

  it("stays ON for every other value, including the old opt-in and near-misses", () => {
    for (const v of ["true", "", "0", "FALSE", "False", "off", "no", "1"]) {
      process.env[VAR] = v;
      expect(bowlingOneTimeFlowEnabled(), `value ${JSON.stringify(v)}`).toBe(true);
    }
  });

  it("reads env at CALL time, so a change takes effect without a module reload", () => {
    process.env[VAR] = "false";
    expect(bowlingOneTimeFlowEnabled()).toBe(false);
    delete process.env[VAR];
    expect(bowlingOneTimeFlowEnabled()).toBe(true);
  });
});

describe("bowlingV3Active", () => {
  it("is on for a plain session now that the default is on", () => {
    delete process.env[VAR];
    expect(bowlingV3Active({ context: {} })).toBe(true);
  });

  it("the ?bowlingV3=1 preview param can only force ON, never off", () => {
    process.env[VAR] = "false";
    expect(bowlingV3Active({ context: {} })).toBe(false);
    expect(bowlingV3Active({ context: { bowlingV3: true } })).toBe(true);
  });
});

describe("the other booking flags are already kill switches", () => {
  it.each([
    ["NEXT_PUBLIC_FASTTRAX_QAMF_DUCKPIN", fasttraxQamfDuckpinEnabled],
    ["NEXT_PUBLIC_FASTTRAX_PLAY_NOW", fasttraxPlayNowEnabled],
  ])('%s defaults on and dies only on "false"', (name, fn) => {
    const prev = process.env[name];
    try {
      delete process.env[name];
      expect(fn()).toBe(true);
      process.env[name] = "true";
      expect(fn()).toBe(true);
      process.env[name] = "false";
      expect(fn()).toBe(false);
    } finally {
      if (prev === undefined) delete process.env[name];
      else process.env[name] = prev;
    }
  });

  it("playNowActive is never globally on — it needs a scanned per-lane QR", () => {
    delete process.env.NEXT_PUBLIC_FASTTRAX_PLAY_NOW;
    expect(playNowActive({ context: {} })).toBe(false);
    expect(playNowActive({ context: { playNow: true } })).toBe(true);
    process.env.NEXT_PUBLIC_FASTTRAX_PLAY_NOW = "false";
    expect(playNowActive({ context: { playNow: true } })).toBe(false);
    delete process.env.NEXT_PUBLIC_FASTTRAX_PLAY_NOW;
  });
});
