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
export { matchScannerPort, type PortLike } from "./port-matching";
export { AamvaBurst, parseAamvaLines, type AamvaLicense } from "./aamva";
export { useLicenseScan, type LicenseScan, type UseLicenseScanOptions } from "./useLicenseScan";
