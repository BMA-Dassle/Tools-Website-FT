import { describe, expect, it } from "vitest";
import { CM } from "./constants";
import { FrameAccumulator } from "./frame";
import { CrtError, decodeError, type CrtErrorCategory } from "./errors";
import { buildNegativeResponse } from "./testing";

function code(s: string): [number, number] {
  return [s.charCodeAt(0), s.charCodeAt(1)];
}

describe("decodeError", () => {
  const expectations: Array<[string, CrtErrorCategory]> = [
    ["00", "fatal"],
    ["01", "fatal"],
    ["02", "needsInit"],
    ["03", "fatal"],
    ["04", "retryable"],
    ["05", "cardError"],
    ["10", "attention"],
    ["12", "attention"],
    ["13", "attention"],
    ["14", "attention"],
    ["40", "attention"],
    ["41", "cardError"],
    ["43", "attention"],
    ["45", "needsInit"],
    ["50", "attention"],
    ["51", "attention"],
    ["60", "cardError"],
    ["61", "cardError"],
    ["62", "cardError"],
    ["65", "cardError"],
    ["66", "cardError"],
    ["67", "cardError"],
    ["68", "cardError"],
    ["69", "cardError"],
    ["A0", "attention"],
    ["A1", "attention"],
    ["B0", "needsInit"],
  ];

  it.each(expectations)("decodes %s as %s", (c, category) => {
    const info = decodeError(...code(c));
    expect(info.code).toBe(c);
    expect(info.category).toBe(category);
    expect(info.message).not.toMatch(/unknown/i);
  });

  it("maps an undefined code to fatal/unknown with the model hint", () => {
    const info = decodeError(...code("77"));
    expect(info.category).toBe("fatal");
    expect(info.message).toMatch(/unknown device error "77"/i);
    expect(info.hint).toMatch(/variant/i);
  });

  it("attention errors carry staff hints", () => {
    for (const c of ["10", "A0", "A1", "B0"]) {
      expect(decodeError(...code(c)).hint, c).toBeTruthy();
    }
  });
});

describe("CrtError", () => {
  it("wraps a parsed negative frame with decoded info", () => {
    const acc = new FrameAccumulator();
    const [ev] = acc.push(buildNegativeResponse({ cm: CM.MOVE, pm: 0x31, code: "A0" }));
    if (ev.type !== "frame" || ev.frame.kind !== "negative") throw new Error("expected negative");
    const err = new CrtError(ev.frame);
    expect(err.info.code).toBe("A0");
    expect(err.info.category).toBe("attention");
    expect(err.cm).toBe(CM.MOVE);
    expect(err.message).toMatch(/stacker/i);
  });
});
