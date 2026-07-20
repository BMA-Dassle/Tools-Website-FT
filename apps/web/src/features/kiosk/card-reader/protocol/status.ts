/**
 * CRT-591 status decoding — spec 2.1.2 (st0/st1/st2) and 3.1.2 (sensors).
 * Status bytes are ASCII digits on the wire ('0' = 0x30 …).
 */
import type { CrtStatusBytes } from "./frame";

export type CardPosition = "none" | "atGate" | "atRfIcPosition" | "unknown";
export type StackerLevel = "empty" | "few" | "enough" | "unknown";
export type ErrorBinLevel = "ok" | "full" | "unknown";

export interface CrtStatus {
  card: CardPosition;
  stacker: StackerLevel;
  errorBin: ErrorBinLevel;
  raw: CrtStatusBytes;
}

const CARD_BY_BYTE: Record<number, CardPosition> = {
  0x30: "none",
  0x31: "atGate",
  0x32: "atRfIcPosition",
};
const STACKER_BY_BYTE: Record<number, StackerLevel> = {
  0x30: "empty",
  0x31: "few",
  0x32: "enough",
};
const BIN_BY_BYTE: Record<number, ErrorBinLevel> = {
  0x30: "ok",
  0x31: "full",
};

/** Unknown bytes map to "unknown" (kept alongside `raw`) rather than throwing —
 *  the physical unit is a different family member than the doc'd model. */
export function parseStatus(st: CrtStatusBytes): CrtStatus {
  return {
    card: CARD_BY_BYTE[st.st0] ?? "unknown",
    stacker: STACKER_BY_BYTE[st.st1] ?? "unknown",
    errorBin: BIN_BY_BYTE[st.st2] ?? "unknown",
    raw: st,
  };
}

export interface SensorStatus {
  /** S1–S7: true = card present at that sensor — spec 3.1.2 (31h = with card). */
  sensors: boolean[];
  /** S8 is "Reserve" in the spec; kept raw for the diagnostics log. */
  s8Raw: number | null;
  /** Reject-bin state derived from this block — the RELIABLE bin signal on the
   *  HB-HDN unit (st2 always reads "unknown"). See binStateFromSensors. */
  binState: ErrorBinLevel;
}

/**
 * STATUS pm=31h returns the sensor block. The spec says 8 bytes in the text
 * and sketches 10 in the diagram — parse the first 7 as S1–S7 and keep the
 * 8th raw; tolerate any actual length.
 */
export function parseSensors(data: Uint8Array): SensorStatus {
  const sensors: boolean[] = [];
  for (let i = 0; i < 7; i++) sensors.push(data[i] === 0x31);
  return { sensors, s8Raw: data.length > 7 ? data[7] : null, binState: binStateFromSensors(data) };
}

/**
 * Reject-bin state from the SENSOR block (STATUS pm=31h) — the RELIABLE signal
 * on the HB-HDN unit (the card-status `st2` byte reads "unknown"). The LAST
 * sensor byte — `data[16]`, the one right before the ETX — is the bin-full flag:
 * 0x31 ('1') = full, 0x30 ('0') = empty. Live-confirmed 2026-07-19; emptying the
 * bin flips it 1→0 once. Only this byte is used — an earlier draft also required
 * data[2]='0', but that byte doesn't reliably return to '0' on empty, so "ok"
 * never fired and Resume never unlocked. Any other value → "unknown".
 */
export function binStateFromSensors(data: Uint8Array): ErrorBinLevel {
  if (data.length <= 16) return "unknown";
  if (data[16] === 0x31) return "full";
  if (data[16] === 0x30) return "ok";
  return "unknown";
}
