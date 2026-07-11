import { describe, expect, it } from "vitest";

import { canonicalJson, planHash } from "./hash";

describe("canonicalJson", () => {
  it("is independent of object key insertion order (recursively)", () => {
    const a = { b: 1, a: { z: [1, 2], y: "x" }, c: null };
    const b = { c: null, a: { y: "x", z: [1, 2] }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it("keeps array order significant", () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it("drops undefined object entries but preserves null", () => {
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
  });

  it("serializes undefined array slots as null (JSON.stringify parity)", () => {
    expect(canonicalJson([undefined, 1])).toBe("[null,1]");
  });
});

describe("planHash", () => {
  const plan = {
    neonId: 42,
    phase: "pre",
    diffCents: 1250,
    steps: [{ kind: "charge_topup", amountCents: 1250 }],
  };

  it("is stable across calls", () => {
    expect(planHash(plan)).toBe(planHash({ ...plan }));
  });

  it("is a 64-char sha256 hex string", () => {
    expect(planHash(plan)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when any money-bearing field drifts", () => {
    expect(planHash(plan)).not.toBe(planHash({ ...plan, diffCents: 1251 }));
    expect(planHash(plan)).not.toBe(planHash({ ...plan, phase: "mid" }));
    expect(planHash(plan)).not.toBe(
      planHash({ ...plan, steps: [{ kind: "charge_topup", amountCents: 1350 }] }),
    );
  });
});
