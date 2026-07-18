/**
 * Typed CRT-591 command builders + response parsers — pure functions.
 * Each builder yields a CommandRequest the engine can send; each parser
 * turns the positive response's DATA into a typed value.
 *
 * Spec section numbers refer to docs/crt-591/protocol.md.
 */
import {
  CM,
  INIT_PM,
  MOVE_PM,
  type CommandClass,
  type InitMode,
  type MoveTarget,
} from "./constants";
import { CrtCardSwError } from "./errors";

export interface CommandRequest {
  cm: number;
  pm: number;
  data?: Uint8Array;
  commandClass: CommandClass;
}

function ascii(data: Uint8Array): string {
  let out = "";
  for (const b of data) if (b >= 0x20 && b < 0x7f) out += String.fromCharCode(b);
  return out.trim();
}

/* ---------------------------------------------------------------- */
/* Dispenser operation — spec 3.1                                    */
/* ---------------------------------------------------------------- */

export function initCommand(mode: InitMode = "leaveCard"): CommandRequest {
  return { cm: CM.INIT, pm: INIT_PM[mode], commandClass: "init" };
}

/** INIT's positive DATA is the firmware/model string, e.g. "CRT-591-M001". */
export function parseFirmware(data: Uint8Array): string {
  return ascii(data);
}

export function statusCommand(): CommandRequest {
  return { cm: CM.STATUS, pm: 0x30, commandClass: "quick" };
}

export function sensorsCommand(): CommandRequest {
  return { cm: CM.STATUS, pm: 0x31, commandClass: "quick" };
}

export function moveCommand(target: MoveTarget): CommandRequest {
  return { cm: CM.MOVE, pm: MOVE_PM[target], commandClass: "move" };
}

export function entryCommand(enabled: boolean): CommandRequest {
  return { cm: CM.ENTRY, pm: enabled ? 0x30 : 0x31, commandClass: "quick" };
}

/* ---------------------------------------------------------------- */
/* Contactless (RF) — spec 3.6                                       */
/* ---------------------------------------------------------------- */

export type RfActivateOrder = "AB" | "BA" | "A" | "B";

const RF_ORDER_BYTES: Record<RfActivateOrder, number[]> = {
  AB: [0x41, 0x42],
  BA: [0x42, 0x41],
  A: [0x41, 0x30],
  B: [0x42, 0x30],
};

export function rfActivateCommand(order?: RfActivateOrder): CommandRequest {
  return {
    cm: CM.RF,
    pm: 0x30,
    data: order ? Uint8Array.from(RF_ORDER_BYTES[order]) : undefined,
    commandClass: "cardIo",
  };
}

export function rfDeactivateCommand(): CommandRequest {
  return { cm: CM.RF, pm: 0x31, commandClass: "quick" };
}

export function rfStatusCommand(): CommandRequest {
  return { cm: CM.RF, pm: 0x32, commandClass: "quick" };
}

export interface RfActivation {
  type: "mifare" | "typeA" | "typeB" | "unknown";
  /** Only for Mifare — derived from ATQA (spec 3.6.1). */
  card: "s50" | "s70" | "ultralight" | null;
  uidHex: string | null;
  atqaHex: string | null;
  sakHex: string | null;
  atsHex: string | null;
  atqbHex: string | null;
}

function hex(bytes: Uint8Array | number[]): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

/**
 * RF activate (60h/30h) response DATA:
 *   Mifare / Type A: Rtype ATQA(2) UID_len(1) UID(n) SAK(1) [ATS…]
 *   Type B:          Rtype ATQB(12)
 * The ATQA byte order on the wire is not pinned by the scanned doc, so the
 * card model accepts either endianness of 0004/0002/0044.
 */
export function parseRfActivation(data: Uint8Array): RfActivation {
  const none: RfActivation = {
    type: "unknown",
    card: null,
    uidHex: null,
    atqaHex: null,
    sakHex: null,
    atsHex: null,
    atqbHex: null,
  };
  if (data.length === 0) return none;
  const rtype = data[0];
  if (rtype === 0x42) {
    return { ...none, type: "typeB", atqbHex: data.length > 1 ? hex(data.slice(1)) : null };
  }
  if (rtype !== 0x4d && rtype !== 0x41) return none;
  const type = rtype === 0x4d ? "mifare" : "typeA";
  if (data.length < 4) return { ...none, type };
  const atqa = data.slice(1, 3);
  const uidLen = data[3];
  const uid = data.slice(4, 4 + uidLen);
  const sakIdx = 4 + uidLen;
  const sak = data.length > sakIdx ? data[sakIdx] : null;
  const ats = data.length > sakIdx + 1 ? data.slice(sakIdx + 1) : null;
  const atqaVal = (atqa[0] << 8) | atqa[1];
  const atqaSwapped = (atqa[1] << 8) | atqa[0];
  const card =
    atqaVal === 0x0004 || atqaSwapped === 0x0004
      ? "s50"
      : atqaVal === 0x0002 || atqaSwapped === 0x0002
        ? "s70"
        : atqaVal === 0x0044 || atqaSwapped === 0x0044
          ? "ultralight"
          : null;
  return {
    type,
    card: type === "mifare" ? card : null,
    uidHex: uid.length ? hex(uid) : null,
    atqaHex: hex(atqa),
    sakHex: sak != null ? hex([sak]) : null,
    atsHex: ats && ats.length ? hex(ats) : null,
    atqbHex: null,
  };
}

export interface RfStatus {
  active: boolean;
  card: "s50" | "s70" | "ultralight" | "typeAcpu" | "typeBcpu" | null;
}

/** RF status (60h/32h) DATA = sti stj (ASCII digits) — spec 3.6.3. */
export function parseRfStatus(data: Uint8Array): RfStatus {
  const sti = data[0];
  const stj = data[1];
  if (sti === 0x30) return { active: false, card: null };
  if (sti === 0x31) {
    return {
      active: true,
      card: stj === 0x30 ? "s50" : stj === 0x31 ? "s70" : stj === 0x32 ? "ultralight" : null,
    };
  }
  if (sti === 0x32) return { active: true, card: "typeAcpu" };
  if (sti === 0x33) return { active: true, card: "typeBcpu" };
  return { active: true, card: null };
}

/* ---------------------------------------------------------------- */
/* Mifare 1 pseudo-APDU ops (60h/33h) — spec 3.6.4                   */
/* ---------------------------------------------------------------- */

export type MifareKey = "A" | "B";

function keyByte(key: MifareKey): number {
  return key === "A" ? 0x00 : 0x01;
}

export function parseKeyHex(keyHex: string): Uint8Array {
  const clean = keyHex.replace(/[\s:]/g, "");
  if (!/^[0-9a-fA-F]{12}$/.test(clean)) {
    throw new RangeError("Mifare key must be 12 hex characters (6 bytes)");
  }
  const out = new Uint8Array(6);
  for (let i = 0; i < 6; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Verify a key sent inline — spec 3.6.4.1 (00h 20h). */
export function mifareVerifyKeyCommand(a: {
  key: MifareKey;
  sector: number;
  keyHex: string;
}): CommandRequest {
  const key = parseKeyHex(a.keyHex);
  return {
    cm: CM.RF,
    pm: 0x33,
    data: Uint8Array.from([0x00, 0x20, keyByte(a.key), a.sector, 0x06, ...key]),
    commandClass: "cardIo",
  };
}

/** Verify using a key stored in the RF module's EEPROM — spec 3.6.4.2 (00h 21h). */
export function mifareVerifyEepromKeyCommand(a: {
  key: MifareKey;
  sector: number;
}): CommandRequest {
  return {
    cm: CM.RF,
    pm: 0x33,
    data: Uint8Array.from([0x00, 0x21, keyByte(a.key), a.sector]),
    commandClass: "cardIo",
  };
}

/** Store a key into the RF module's EEPROM (32 slots) — spec 3.6.4.4 (00h D0h). */
export function mifareDownloadKeyCommand(a: {
  key: MifareKey;
  sector: number;
  keyHex: string;
}): CommandRequest {
  const key = parseKeyHex(a.keyHex);
  return {
    cm: CM.RF,
    pm: 0x33,
    data: Uint8Array.from([0x00, 0xd0, keyByte(a.key), a.sector, 0x06, ...key]),
    commandClass: "cardIo",
  };
}

/**
 * MIFARE geometry: sectors 00h–1Fh have 4 blocks (trailer = 3); S70's large
 * sectors 20h–27h have 16 blocks (trailer = 15). (The scanned table is
 * off-by-one on the S70 boundary; this follows the actual MIFARE layout.)
 */
export function trailerBlock(sector: number): number {
  return sector <= 0x1f ? 3 : 15;
}

export function isTrailerBlock(sector: number, block: number): boolean {
  return block === trailerBlock(sector);
}

/** Read `blocks` blocks starting at sector/block — spec 3.6.4.5 (00h B0h). */
export function mifareReadCommand(a: {
  sector: number;
  block: number;
  blocks: number;
}): CommandRequest {
  return {
    cm: CM.RF,
    pm: 0x33,
    data: Uint8Array.from([0x00, 0xb0, a.sector, a.block, a.blocks]),
    commandClass: "cardIo",
  };
}

/**
 * Write whole blocks starting at sector/block — spec 3.6.4.6 (00h D1h).
 * Client-side foot-gun guard: refuses a range that touches the sector
 * trailer (keys + access bits) — the spec says the device also prohibits it,
 * but we never rely on that alone.
 */
export function mifareWriteCommand(a: {
  sector: number;
  block: number;
  data: Uint8Array;
  /** 16 for S50/S70 (default); 4 for Ultralight. */
  blockSize?: 4 | 16;
}): CommandRequest {
  const blockSize = a.blockSize ?? 16;
  if (a.data.length === 0 || a.data.length % blockSize !== 0) {
    throw new RangeError(`Write data must be a positive multiple of ${blockSize} bytes`);
  }
  const blocks = a.data.length / blockSize;
  if (blockSize === 16) {
    for (let b = a.block; b < a.block + blocks; b++) {
      if (isTrailerBlock(a.sector, b)) {
        throw new RangeError(
          `Refusing to write sector ${a.sector} block ${b} — that is the sector trailer (keys/access bits)`,
        );
      }
    }
  }
  return {
    cm: CM.RF,
    pm: 0x33,
    data: Uint8Array.from([0x00, 0xd1, a.sector, a.block, blocks, ...a.data]),
    commandClass: "cardIo",
  };
}

/**
 * Mifare/I2C pseudo-APDU responses end with SW1SW2. Returns the payload with
 * the status word stripped; throws CrtCardSwError when SW ≠ 9000.
 */
export function parseSwResult(data: Uint8Array): Uint8Array {
  if (data.length < 2) throw new CrtCardSwError(0x6f, 0x00);
  const sw1 = data[data.length - 2];
  const sw2 = data[data.length - 1];
  if (sw1 !== 0x90 || sw2 !== 0x00) throw new CrtCardSwError(sw1, sw2);
  return data.slice(0, data.length - 2);
}

/* ---------------------------------------------------------------- */
/* Identity / housekeeping — spec 3.6.7–3.6.10                       */
/* ---------------------------------------------------------------- */

export function serialNumberCommand(): CommandRequest {
  return { cm: CM.SERIAL_NUMBER, pm: 0x30, commandClass: "quick" };
}

/** A2h/30h DATA = len(1) + serial bytes — spec 3.6.7. */
export function parseSerialNumber(data: Uint8Array): string {
  if (data.length === 0) return "";
  const len = data[0];
  return ascii(data.slice(1, 1 + len));
}

export function readConfigCommand(): CommandRequest {
  return { cm: CM.READ_CONFIG, pm: 0x30, commandClass: "quick" };
}

/** A4h/30h — response DATA format is undocumented; treated as ASCII. */
export function readVersionCommand(): CommandRequest {
  return { cm: CM.READ_VERSION, pm: 0x30, commandClass: "quick" };
}

export function parseVersion(data: Uint8Array): string {
  return ascii(data);
}

export function binCounterReadCommand(): CommandRequest {
  return { cm: CM.BIN_COUNTER, pm: 0x30, commandClass: "quick" };
}

/** A5h/30h DATA = "000".."999" — spec 3.6.9.1. */
export function parseBinCounter(data: Uint8Array): number | null {
  const text = ascii(data);
  if (!/^\d{1,3}$/.test(text)) return null;
  return parseInt(text, 10);
}

export function binCounterSetCommand(count = 0): CommandRequest {
  if (!Number.isInteger(count) || count < 0 || count > 999) {
    throw new RangeError("Bin counter must be an integer 0–999");
  }
  const text = count.toString().padStart(3, "0");
  return {
    cm: CM.BIN_COUNTER,
    pm: 0x31,
    data: Uint8Array.from([...text].map((c) => c.charCodeAt(0))),
    commandClass: "quick",
  };
}

export function pcscResetCommand(): CommandRequest {
  return { cm: CM.PCSC_RESET, pm: 0x30, commandClass: "quick" };
}

/* ---------------------------------------------------------------- */
/* Magnetic stripe — NOT in the M001 doc; reverse-engineered from a  */
/* CRT-591-(R02)HB-HDN debug capture (2026-07-17). The unit answers  */
/* the read with head 'N' and the track buffer in the payload, so    */
/* callers use engine.sendRaw (accept-negative), not send.           */
/* ---------------------------------------------------------------- */

export const CM_MAG = 0x36;

/** Move the card to the magnetic read position (MOVE PM=34, from the capture). */
export function moveMagPositionCommand(): CommandRequest {
  return { cm: CM.MOVE, pm: 0x34, commandClass: "move" };
}

/** Read all magnetic tracks — capture: `C 36 37`. */
export function magReadCommand(): CommandRequest {
  return { cm: CM_MAG, pm: 0x37, commandClass: "cardIo" };
}

/**
 * "Permit mag card in" — ENTRY PM=32h. This is the variant the CRT-591-(R02)HB
 * debug tool uses before a reload (confirmed 2026-07-17); it permits a card to
 * be inserted at the gate and auto-carried to the read station. (M001 documents
 * only 30h enable / 31h disable for ENTRY; 32h is the mag-variant extension.)
 */
export function permitEntryCommand(): CommandRequest {
  return { cm: CM.ENTRY, pm: 0x32, commandClass: "quick" };
}

/**
 * "Stop allowing mag cards in" — ENTRY PM=30h. The vendor tool sends this after
 * a reload dispenses, so the gate stops accepting cards once one reload is done
 * (confirmed 2026-07-17). Pair it with permitEntryCommand (32h).
 */
export function prohibitEntryCommand(): CommandRequest {
  return { cm: CM.ENTRY, pm: 0x30, commandClass: "quick" };
}

export interface MagTracks {
  /** Cleaned per-track strings, in the order the device returned them. */
  tracks: string[];
  /** Best-guess account/card number (digits after the last '=', longest run). */
  cardNumber: string | null;
  /** All digit-string candidates found, for the operator to match to the card. */
  candidates: string[];
  /** The full decoded payload as ASCII, for display. */
  ascii: string;
  /** Raw payload bytes (post CM/PM), for the hex view. */
  raw: Uint8Array;
}

/**
 * Parse a magnetic-read reply frame into tracks. The reply's payload (the
 * bytes after CM/PM — for the negative-head reply that's e1,e0 + DATA) is an
 * ASCII track buffer with '~' between tracks and '=' as a field separator,
 * e.g. `…P6283=7496003776810700729~P6283=0000000001037356~N…`.
 *
 * Framing of the leading status bytes and the trailing marker isn't fully
 * documented, so we parse generously and ALSO surface the raw payload — the
 * operator confirms which field is the account number against a known card,
 * then this can be tightened. Returns candidates rather than guessing blindly.
 */
export function parseMagRead(frame: {
  kind: "positive" | "negative";
  data: Uint8Array;
  e1?: number;
  e0?: number;
}): MagTracks {
  // Reconstruct the payload after CM/PM. A negative-head reply repurposes the
  // e1/e0 slots as the first two payload bytes, so include them.
  const parts: number[] = [];
  if (frame.kind === "negative" && frame.e1 != null && frame.e0 != null) {
    parts.push(frame.e1, frame.e0);
  }
  for (const b of frame.data) parts.push(b);
  const raw = Uint8Array.from(parts);

  let ascii = "";
  for (const b of raw) ascii += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".";

  const tracks = ascii
    .split("~")
    .map((t) => t.replace(/[^\x20-\x7e]/g, "").trim())
    .filter((t) => t.length > 0);

  // Per-track account field = the digits after '=' (Intercard: "P6283=<account>").
  const candidates: string[] = [];
  for (const t of tracks) {
    const eq = t.lastIndexOf("=");
    const tail = eq >= 0 ? t.slice(eq + 1) : t;
    const digits = tail.replace(/\D/g, "");
    if (digits.length >= 4) candidates.push(digits);
  }
  // The Intercard account number lives on TRACK 2 (confirmed against a printed
  // card 2026-07-17 — the 16-digit field, not the longer track-1 field). Fall
  // back to track 1, then to any candidate, so a partial read still yields
  // something rather than null.
  const cardNumber = candidates[1] ?? candidates[0] ?? null;

  return { tracks, cardNumber, candidates, ascii, raw };
}
