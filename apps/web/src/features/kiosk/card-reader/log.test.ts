import { describe, expect, it } from "vitest";
import { hexDump, LogRing } from "./log";

const entry = (decoded: string) => ({
  dir: "tx" as const,
  t: 0,
  bytes: Uint8Array.from([0xf2]),
  decoded,
  level: "info" as const,
});

describe("hexDump", () => {
  it("formats spaced uppercase hex", () => {
    expect(hexDump(Uint8Array.from([0xf2, 0x00, 0x03, 0xab]))).toBe("F2 00 03 AB");
    expect(hexDump(new Uint8Array(0))).toBe("");
  });
});

describe("LogRing", () => {
  it("assigns monotonic ids and wraps at capacity", () => {
    const ring = new LogRing(3);
    for (let i = 1; i <= 5; i++) ring.push(entry(`e${i}`));
    const snap = ring.snapshot();
    expect(snap.map((e) => e.decoded)).toEqual(["e3", "e4", "e5"]);
    expect(snap.map((e) => e.id)).toEqual([3, 4, 5]);
  });

  it("keeps snapshot identity stable between mutations (useSyncExternalStore contract)", () => {
    const ring = new LogRing(10);
    ring.push(entry("a"));
    const s1 = ring.snapshot();
    expect(ring.snapshot()).toBe(s1);
    ring.push(entry("b"));
    expect(ring.snapshot()).not.toBe(s1);
  });

  it("notifies subscribers on push and clear", () => {
    const ring = new LogRing(10);
    let fired = 0;
    const unsub = ring.subscribe(() => fired++);
    ring.push(entry("a"));
    ring.clear();
    expect(fired).toBe(2);
    expect(ring.snapshot()).toHaveLength(0);
    unsub();
    ring.push(entry("b"));
    expect(fired).toBe(2);
  });
});
