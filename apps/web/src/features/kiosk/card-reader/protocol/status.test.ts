import { describe, expect, it } from "vitest";
import { parseStatus } from "./status";

/**
 * The CRT-591-(R02)HB-HDN reports the reject-bin state in the status block's
 * st2 byte: 0x30 ('0') = empty, 0x32 ('2') = full. Owner-confirmed 2026-07-19 —
 * the admin panel already showed ok ↔ "unknown" tracking empty ↔ full; decoding
 * 0x32 as full turns that "unknown" into the real "full".
 */
const st = (st2: number) => ({ st0: 0x30, st1: 0x32, st2 });

describe("parseStatus — reject bin (st2)", () => {
  it("st2 0x30 → ok (bin empty)", () => {
    expect(parseStatus(st(0x30)).errorBin).toBe("ok");
  });

  it("st2 0x32 → full (this unit's full code)", () => {
    expect(parseStatus(st(0x32)).errorBin).toBe("full");
  });

  it("st2 0x31 → full (documented full code)", () => {
    expect(parseStatus(st(0x31)).errorBin).toBe("full");
  });

  it("unmapped st2 → unknown (never a false 'ok')", () => {
    expect(parseStatus(st(0x39)).errorBin).toBe("unknown");
  });
});
