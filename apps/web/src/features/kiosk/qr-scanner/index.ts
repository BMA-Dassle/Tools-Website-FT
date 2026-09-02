/**
 * Hardware QR scanner (serial-line, e.g. Honeywell 3320g) — public surface.
 * See docs/qr-scanner/README.md for the integration guide.
 */
export {
  useQrScanner,
  type QrScan,
  type QrScanner,
  type QrScannerConnection,
  type QrScannerInfo,
  type UseQrScannerOptions,
} from "./useQrScanner";
export {
  DEFAULT_SCANNER_MODEL_ID,
  getScannerModel,
  listScannerModels,
  type LineFramingOptions,
  type ScannerModel,
  type SerialLineScannerModel,
} from "./models";
export { LineAccumulator } from "./line-accumulator";
export {
  SCAN_COOLDOWN_MS,
  SCAN_ECHO_MS,
  holdScanGate,
  peekScanGate,
  resetScanGate,
  takeScanGate,
  type ScanGateVerdict,
} from "./scan-gate";
export { matchScannerPort, type PortLike } from "./port-matching";
export { deriveScannerCheck, type ScannerCheck, type SerialGrantProbe } from "./scanner-check";
export { AamvaBurst, parseAamvaLines, type AamvaLicense } from "./aamva";
export { extractGanCandidate, type GanExtraction } from "./gift-card-qr";
export { parseMemberQr, parseMemberCode, type MemberQr } from "./member-qr";
export { useLicenseScan, type LicenseScan, type UseLicenseScanOptions } from "./useLicenseScan";
