/**
 * Hardware QR scanner model registry — the seam that keeps the driver
 * pluggable across scanner models. Entries are PURE DATA; the one
 * serial-line code path lives in useQrScanner. Another serial model is one
 * new literal here (the Opticon was exactly that); a non-serial model adds
 * a `kind` union member, and TypeScript's exhaustiveness check flags every
 * switch site that must handle it. See docs/qr-scanner/README.md.
 */

export interface LineFramingOptions {
  /**
   * Cap on buffered chars with no line terminator. A scanner programmed
   * without a suffix (or a wrong-baud garbage stream) would otherwise grow
   * the buffer forever. Default 8192 — above QR's max capacity (~7k numeric).
   */
  maxLineBytes?: number;
}

/** A scanner that streams `<payload><CR LF>` lines over a USB-serial COM port. */
export interface SerialLineScannerModel {
  kind: "serial-line";
  id: string;
  /** Admin dropdown text. */
  label: string;
  /** Starting baud — a per-device override lives in KioskConfig.qrScannerBaud. */
  defaultBaudRate: number;
  /** Rates the panel's baud select offers, most likely first. Never probed —
   *  a read-only device has no handshake; staff scan a test code per rate. */
  baudCandidates: number[];
  /** Only when the model is NOT 8-N-1 (all known models are). */
  lineSettings?: {
    dataBits?: 7 | 8;
    parity?: "none" | "even" | "odd";
    stopBits?: 1 | 2;
  };
  framing: LineFramingOptions;
  /**
   * Expected USB vendor/product ids — DISPLAY/DIAGNOSTIC ONLY. Never a
   * requestPort filter (staff must see all ports) and never the reconnect
   * key (the saved qrScannerPortInfo is).
   */
  expectedUsbIds: Array<{ usbVendorId: number; usbProductId?: number }>;
  /** True once expectedUsbIds were read off a real unit via port.getInfo(). */
  usbIdsConfirmed: boolean;
  /** Panel hint under the model select. */
  notes?: string;
}

/** Grows to `SerialLineScannerModel | <NonSerialModel>` if a non-serial unit arrives. */
export type ScannerModel = SerialLineScannerModel;

export const DEFAULT_SCANNER_MODEL_ID = "honeywell-3320g";

const MODELS: Record<string, ScannerModel> = {
  "honeywell-3320g": {
    kind: "serial-line",
    id: "honeywell-3320g",
    label: "Honeywell 3320g (USB serial)",
    defaultBaudRate: 115200,
    baudCandidates: [115200, 57600, 38400, 19200, 9600],
    framing: {},
    // Common Honeywell / Hand Held Products VID — NOT yet confirmed off the
    // real unit. The panel compares the connected port's getInfo() against
    // this and says so either way; flip usbIdsConfirmed once verified.
    expectedUsbIds: [{ usbVendorId: 0x0c2e }],
    usbIdsConfirmed: false,
    notes:
      "USB serial (CDC) mode; suffix 990D0A → every scan ends CR LF. " +
      "Default 115200 8-N-1 per the guide — confirm on the unit: if the feed " +
      "shows garbage or nothing, step through the baud rates and scan again.",
  },
  "opticon-2d": {
    kind: "serial-line",
    id: "opticon-2d",
    label: "Opticon 2D imaging scanner (USB serial)",
    // Seeded AHEAD of hardware (2026-07-24; brand corrected from Posiflex →
    // Opticon 2026-07-24) — no unit tested yet. 9600 8-N-1 is Opticon's
    // classic serial default; if the unit is true USB-CDC the rate may not
    // even matter. The feed + baud stepping decides.
    defaultBaudRate: 9600,
    baudCandidates: [9600, 115200, 57600, 38400, 19200, 4800],
    framing: {},
    // Opticon, Inc.'s registered USB VID — NOT confirmed off a unit.
    // Some scanner lines enumerate under a USB-serial bridge VID instead
    // (FTDI 0403 / CH340 1a86 / CP210x 10c4); the panel shows the real ids
    // and flags a mismatch — record whatever it reports here.
    expectedUsbIds: [{ usbVendorId: 0x065a }],
    usbIdsConfirmed: false,
    notes:
      "UNCONFIRMED — provisioned ahead of hardware. Program the unit to USB " +
      "Virtual COM (USB-COM) mode first (if it types into text fields it's in " +
      "keyboard mode) and program a CR and/or LF suffix so each scan ends the " +
      "line. Then scan a test code: garbage or nothing → step through the baud " +
      "rates and scan again; record the working rate + USB ids in models.ts " +
      "and docs/qr-scanner/README.md.",
  },
};

export function listScannerModels(): ScannerModel[] {
  return Object.values(MODELS);
}

/**
 * Unknown/legacy id → null. A config saved by a NEWER build (Neon restore
 * after a reimage) must degrade to the default model on an older build, not
 * crash — callers fall back to DEFAULT_SCANNER_MODEL_ID and surface a note.
 */
export function getScannerModel(id: string | null | undefined): ScannerModel | null {
  return (id && MODELS[id]) || null;
}
