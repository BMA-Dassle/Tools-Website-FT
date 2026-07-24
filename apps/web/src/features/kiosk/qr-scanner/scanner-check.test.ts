import { describe, expect, it } from "vitest";
import { deriveScannerCheck } from "./scanner-check";

const honeywell: SerialPortInfo = { usbVendorId: 0x0c2e, usbProductId: 0x0b61 };
const ftdi: SerialPortInfo = { usbVendorId: 0x0403, usbProductId: 0x6001 }; // CRT-591's adapter

const saved = { usbVendorId: 0x0c2e, usbProductId: 0x0b61 };
const enabled = { qrScannerEnabled: true, qrScannerPortInfo: saved };

describe("deriveScannerCheck", () => {
  it("null config → off", () => {
    expect(deriveScannerCheck(null, [honeywell])).toBe("off");
  });

  it("scanner disabled → off, even with grants present and a probe done", () => {
    expect(
      deriveScannerCheck({ qrScannerEnabled: false, qrScannerPortInfo: saved }, [honeywell]),
    ).toBe("off");
    expect(
      deriveScannerCheck({ qrScannerEnabled: false, qrScannerPortInfo: saved }, "testing"),
    ).toBe("off");
  });

  it("enabled + probe in flight → testing", () => {
    expect(deriveScannerCheck(enabled, "testing")).toBe("testing");
  });

  it("enabled + no Web Serial → unsupported", () => {
    expect(deriveScannerCheck(enabled, "unsupported")).toBe("unsupported");
  });

  it("enabled with no saved VID → no-saved-port (null, undefined, or empty portInfo)", () => {
    expect(
      deriveScannerCheck({ qrScannerEnabled: true, qrScannerPortInfo: null }, [honeywell]),
    ).toBe("no-saved-port");
    expect(deriveScannerCheck({ qrScannerEnabled: true, qrScannerPortInfo: {} }, [honeywell])).toBe(
      "no-saved-port",
    );
  });

  it("saved VID+PID present among several grants → matched", () => {
    expect(deriveScannerCheck(enabled, [ftdi, honeywell])).toBe("matched");
  });

  it("saved VID only (no PID) → matched on VID alone", () => {
    expect(
      deriveScannerCheck({ qrScannerEnabled: true, qrScannerPortInfo: { usbVendorId: 0x0c2e } }, [
        honeywell,
      ]),
    ).toBe("matched");
  });

  it("saved ids but scanner's grant missing → no-match (never 'close enough')", () => {
    expect(deriveScannerCheck(enabled, [ftdi])).toBe("no-match");
    expect(deriveScannerCheck(enabled, [])).toBe("no-match");
    expect(deriveScannerCheck(enabled, [{ usbVendorId: 0x0c2e, usbProductId: 0x9999 }])).toBe(
      "no-match",
    );
  });
});
