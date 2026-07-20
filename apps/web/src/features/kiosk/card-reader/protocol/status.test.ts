import { describe, expect, it } from "vitest";
import { binStateFromSensors } from "./status";

/**
 * Real STATUS pm=31h sensor-block DATA fields captured from the physical
 * CRT-591-(R02)HB-HDN kiosk unit on 2026-07-19 — the 17 bytes AFTER the
 * P(0x50)/CM(0x31)/PM(0x31) response header. Filling the reject bin (nothing
 * else touched) flips sensor byte 3 (data[2]) '0'→'2' and the last sensor byte
 * (data[16]) '0'→'1'; both read '0' when the bin is clear.
 */
// prettier-ignore
const NOT_FULL = Uint8Array.from([
  0x30, 0x32, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x31, 0x31, 0x30,
]);
// prettier-ignore
const FULL = Uint8Array.from([
  0x30, 0x32, 0x32, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x31, 0x31, 0x31,
]);

describe("binStateFromSensors", () => {
  it('reads "ok" from the empty-bin capture', () => {
    expect(binStateFromSensors(NOT_FULL)).toBe("ok");
  });

  it('reads "full" from the full-bin capture', () => {
    expect(binStateFromSensors(FULL)).toBe("full");
  });

  it('reads "full" when only the boolean flag byte (data[16]) is set', () => {
    const d = NOT_FULL.slice();
    d[16] = 0x31;
    expect(binStateFromSensors(d)).toBe("full");
  });

  it('reads "full" when only the level byte (data[2]) is set', () => {
    const d = NOT_FULL.slice();
    d[2] = 0x32;
    expect(binStateFromSensors(d)).toBe("full");
  });

  it('reads "unknown" when the block is too short to tell', () => {
    expect(binStateFromSensors(Uint8Array.from([0x30, 0x32, 0x30]))).toBe("unknown");
  });

  it('reads "unknown" for an unexpected byte value (never a false "ok")', () => {
    const d = NOT_FULL.slice();
    d[16] = 0x39; // neither 0x30 nor 0x31
    expect(binStateFromSensors(d)).toBe("unknown");
  });
});
