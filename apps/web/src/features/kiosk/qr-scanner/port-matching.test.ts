import { describe, expect, it } from "vitest";
import { matchScannerPort, type PortLike } from "./port-matching";

const port = (usbVendorId?: number, usbProductId?: number): PortLike => ({
  getInfo: () => ({ usbVendorId, usbProductId }),
});

const honeywell = port(0x0c2e, 0x0b61);
const ftdi = port(0x0403, 0x6001); // the CRT-591's USB-serial adapter
const nativeCom = port();

describe("matchScannerPort", () => {
  it("saved VID+PID → the exact port among many grants", () => {
    expect(
      matchScannerPort([ftdi, honeywell, nativeCom], { usbVendorId: 0x0c2e, usbProductId: 0x0b61 }),
    ).toBe(honeywell);
  });

  it("saved VID+PID with a wrong PID present → null (never 'close enough')", () => {
    expect(
      matchScannerPort([port(0x0c2e, 0x9999)], { usbVendorId: 0x0c2e, usbProductId: 0x0b61 }),
    ).toBeNull();
  });

  it("saved VID only → matches any PID with that VID", () => {
    expect(matchScannerPort([ftdi, honeywell], { usbVendorId: 0x0c2e })).toBe(honeywell);
  });

  it("saved ids with no matching grant → null, even for a lone grant with fallback on", () => {
    expect(matchScannerPort([ftdi], { usbVendorId: 0x0c2e }, true)).toBeNull();
  });

  it("no saved ids → null by default (strict), lone grant only when opted in", () => {
    expect(matchScannerPort([honeywell], null)).toBeNull();
    expect(matchScannerPort([honeywell], null, true)).toBe(honeywell);
  });

  it("no saved ids + several grants → null even when opted in (never guesses among many)", () => {
    expect(matchScannerPort([ftdi, honeywell], null, true)).toBeNull();
  });

  it("no grants at all → null", () => {
    expect(matchScannerPort([], { usbVendorId: 0x0c2e })).toBeNull();
    expect(matchScannerPort([], null, true)).toBeNull();
  });
});
