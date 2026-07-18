/**
 * CRT-591 card reader/dispenser — public surface.
 * See docs/crt-591/README.md for the integration guide.
 */
export {
  useCardReader,
  type CardReaderConnection,
  type UseCardReaderOptions,
} from "./useCardReader";
export {
  CrtReaderClient,
  type CrtDeviceInfo,
  type CrtResult,
  type TransportFactory,
} from "./client";
export {
  CrtCancelledError,
  CrtCardSwError,
  CrtError,
  CrtLinkError,
  CrtTimeoutError,
  decodeError,
  type CrtErrorCategory,
  type CrtErrorInfo,
} from "./protocol/errors";
export type { CrtStatus, SensorStatus } from "./protocol/status";
export type {
  RfActivation,
  RfStatus,
  MifareKey,
  RfActivateOrder,
  MagTracks,
} from "./protocol/commands";
export {
  BAUD_CANDIDATES,
  type CommandClass,
  type InitMode,
  type MoveTarget,
} from "./protocol/constants";
export { hexDump, type LogEntry } from "./log";
export { parseWedgeBurst, type WedgeCapture } from "./wedge";
