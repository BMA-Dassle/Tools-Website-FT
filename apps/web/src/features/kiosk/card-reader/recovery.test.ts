import { describe, expect, it } from "vitest";
import { classifyFault, type FaultBehavior } from "./recovery";
import { decodeError } from "./protocol/errors";
import type { CrtStatus } from "./protocol/status";

const st = (over: Partial<CrtStatus> = {}): CrtStatus => ({
  card: "none",
  stacker: "enough",
  errorBin: "ok",
  raw: { st0: 0x30, st1: 0x32, st2: 0x30 },
  ...over,
});

/** Decode a device e1/e0 code (two ASCII chars) to its CrtErrorInfo. */
const info = (code: string) => decodeError(code.charCodeAt(0), code.charCodeAt(1));

describe("classifyFault", () => {
  it("retryable → transparent retry, no reinit", () => {
    expect(classifyFault(info("04"))).toEqual({ kind: "retry", maxTries: 2, reinit: false });
  });

  it("needsInit → retry after init", () => {
    for (const c of ["B0", "02", "45"]) {
      expect(classifyFault(info(c))).toEqual({ kind: "retry", maxTries: 1, reinit: true });
    }
  });

  it("cardError → card-retry", () => {
    for (const c of ["61", "05", "41", "60", "67"]) {
      expect(classifyFault(info(c))).toEqual({ kind: "card-retry" });
    }
  });

  it("fatal → abort with attendant message", () => {
    const b = classifyFault(info("00"));
    expect(b.kind).toBe("abort");
    if (b.kind === "abort") expect(b.message).toMatch(/attendant/i);
  });

  it("A0 stacker empty → hold, Resume gated until refilled, no reinit", () => {
    const b = classifyFault(info("A0")) as Extract<FaultBehavior, { kind: "hold" }>;
    expect(b.kind).toBe("hold");
    expect(b.reinitOnResume).toBe(false);
    expect(b.resumeReady!(st({ stacker: "empty" }))).toBe(false);
    expect(b.resumeReady!(st({ stacker: "unknown" }))).toBe(false);
    expect(b.resumeReady!(st({ stacker: "few" }))).toBe(true);
    expect(b.resumeReady!(st({ stacker: "enough" }))).toBe(true);
  });

  it("A1 / 50 bin full → hold, Resume gated until bin reads empty, reinit", () => {
    for (const c of ["A1", "50"]) {
      const b = classifyFault(info(c)) as Extract<FaultBehavior, { kind: "hold" }>;
      expect(b.kind).toBe("hold");
      expect(b.reinitOnResume).toBe(true);
      expect(b.resumeReady!(st({ errorBin: "full" }))).toBe(false);
      expect(b.resumeReady!(st({ errorBin: "ok" }))).toBe(true);
    }
  });

  it("10 / 40 jam → hold, Resume gated until the card is gone, reinit", () => {
    for (const c of ["10", "40"]) {
      const b = classifyFault(info(c)) as Extract<FaultBehavior, { kind: "hold" }>;
      expect(b.kind).toBe("hold");
      expect(b.reinitOnResume).toBe(true);
      expect(b.resumeReady!(st({ card: "atGate" }))).toBe(false);
      expect(b.resumeReady!(st({ card: "none" }))).toBe(true);
    }
  });

  it("motor / sensor / size (no sensor signal) → hold with Resume enabled immediately, reinit", () => {
    for (const c of ["51", "12", "13", "14", "43"]) {
      const b = classifyFault(info(c)) as Extract<FaultBehavior, { kind: "hold" }>;
      expect(b.kind).toBe("hold");
      expect(b.resumeReady).toBeUndefined();
      expect(b.reinitOnResume).toBe(true);
    }
  });

  it("unknown device code → fatal → abort", () => {
    expect(classifyFault(info("ZZ")).kind).toBe("abort");
  });

  it("synthetic link/timeout infos classify by category", () => {
    expect(classifyFault({ code: "T/O", message: "", category: "retryable" }).kind).toBe("retry");
    expect(classifyFault({ code: "LNK", message: "", category: "fatal" }).kind).toBe("abort");
    expect(classifyFault({ code: "CAN", message: "", category: "retryable" }).kind).toBe("retry");
  });
});
