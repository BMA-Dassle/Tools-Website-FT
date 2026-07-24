/**
 * Device-check derivation for the COM QR scanner row — pure so the state
 * matrix is unit-tested. Grant-presence + VID/PID attribution ONLY (same
 * depth as the CRT-591 row): the check must never open the port, because
 * Web Serial opens are exclusive and a probe-open would steal the scanner
 * from whatever flow surface is listening.
 */
import type { KioskConfig } from "../config";
import { matchScannerPort } from "./port-matching";

/** The device check's one getPorts() probe, as stored infos (not live ports). */
export type SerialGrantProbe = "testing" | "unsupported" | readonly SerialPortInfo[];

export type ScannerCheck =
  | "off" // qrScannerEnabled falsy (or config null)
  | "testing" // getPorts() still in flight
  | "unsupported" // no navigator.serial in this browser
  | "no-saved-port" // enabled but no saved VID yet — set up in admin
  | "no-match" // saved ids, but no granted port carries them — replug/re-grant
  | "matched"; // a granted port matches the saved VID/PID

export function deriveScannerCheck(
  config: Pick<KioskConfig, "qrScannerEnabled" | "qrScannerPortInfo"> | null,
  grants: SerialGrantProbe,
): ScannerCheck {
  if (!config?.qrScannerEnabled) return "off";
  if (grants === "testing") return "testing";
  if (grants === "unsupported") return "unsupported";
  // Checked explicitly rather than left to matchScannerPort returning null,
  // so the row can distinguish "set it up in admin" from "replug it".
  if (config.qrScannerPortInfo?.usbVendorId == null) return "no-saved-port";
  const match = matchScannerPort(
    grants.map((info) => ({ getInfo: () => info })),
    config.qrScannerPortInfo,
    // Strict — the CRT-591 and MSR share this origin's grants (useLicenseScan).
    false,
  );
  return match ? "matched" : "no-match";
}
