/**
 * CRT-591 serial protocol constants.
 *
 * Source of truth: docs/crt-591/protocol.md (transcribed from the CREATOR
 * CRT-591-M001 communication protocol spec, 2013-07-02 v1.0). Framing and the
 * dispenser/status/error model are shared across the CRT-591 family; the
 * physical unit at the kiosk is likely a CRT-591-(R02)HB-HDN whose magstripe
 * command set is NOT in the doc — those commands arrive additively via the
 * raw-command path once the vendor doc is in hand.
 */

/* Control characters — spec 1.1.2 */
export const STX = 0xf2; // start of text (frame lead)
export const ETX = 0x03; // end of text
export const ACK = 0x06; // acknowledge
export const NAK = 0x15; // negative acknowledge → resend
export const EOT = 0x04; // clear the line / cancel

/* TEXT heads — spec 1.2.1–1.2.3 */
export const CMD_HEAD = 0x43; // 'C' — host command
export const POSITIVE_HEAD = 0x50; // 'P' — success response
/**
 * Negative head: the spec prints «(N' , 45H)» — but ASCII 'N' is 4EH while
 * 45H is 'E'. A scan typo one way or the other; accept both and let the
 * TX/RX log record which one the real device sends (docs step-8 checklist).
 */
export const NEGATIVE_HEADS: readonly number[] = [0x4e, 0x45];

export const DEFAULT_ADDR = 0x00; // DIP-switch address, factory default — spec 1.3
export const MAX_DATA_LEN = 512; // DATA field bound — spec 1.2.1
/** Longest legal TEXT: positive head (6 fixed bytes) + max DATA. */
export const MAX_TEXT_LEN = 6 + MAX_DATA_LEN;

/**
 * The device auto-scans baud at the first INIT after power-on (spec 3.1.1),
 * so probe order only affects reconnect latency. The CRT-591-(R02)HB-HDN unit
 * at the kiosk runs at 115200 (confirmed on hardware 2026-07-17) — it leads
 * the list. The remaining rates are the M001-documented set as a fallback.
 */
export const BAUD_CANDIDATES = [115200, 9600, 38400, 19200, 57600] as const;

/** Host must see ACK within 300 ms of sending a command — spec 1.4.2 Case 1. */
export const ACK_TIMEOUT_MS = 300;

/* Command bytes (CM) — spec 2.1.1 command list */
export const CM = {
  INIT: 0x30,
  STATUS: 0x31,
  MOVE: 0x32,
  ENTRY: 0x33,
  CARD_TYPE: 0x50,
  CPU: 0x51,
  SAM: 0x52,
  SLE: 0x53,
  I2C: 0x54,
  RF: 0x60,
  SERIAL_NUMBER: 0xa2,
  READ_CONFIG: 0xa3,
  READ_VERSION: 0xa4,
  BIN_COUNTER: 0xa5,
  PCSC_RESET: 0xa6,
} as const;

/* INIT parameters (PM) — spec 3.1.1 */
export const INIT_PM = {
  holdCard: 0x30, // move a present card to the gate
  capture: 0x31, // capture a present card to the error bin
  leaveCard: 0x33, // leave a present card where it is (non-destructive)
  holdCardCounted: 0x34, // 30h + retract counter
  captureCounted: 0x35, // 31h + retract counter
  leaveCardCounted: 0x37, // 33h + retract counter
} as const;
export type InitMode = keyof typeof INIT_PM;

/* MOVE parameters (PM) — spec 3.1.3 */
export const MOVE_PM = {
  holding: 0x30,
  icPosition: 0x31, // feeds a card from the stacker when none is inside
  rfPosition: 0x32,
  errorBin: 0x33, // capture
  outOfGate: 0x39, // present/eject
} as const;
export type MoveTarget = keyof typeof MOVE_PM;

/**
 * Execution-timeout classes. The 300 ms link timeout only covers the ACK;
 * the response after execution takes as long as the operation does — motor
 * moves run seconds, INIT after power-on includes a baud scan and a
 * mechanical sweep.
 */
export type CommandClass = "quick" | "cardIo" | "move" | "init";
export const EXEC_TIMEOUT_MS: Record<CommandClass, number> = {
  quick: 2_000,
  cardIo: 8_000,
  move: 15_000,
  init: 30_000,
};
