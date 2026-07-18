/**
 * CRT-591 frame codec — pure functions, no DOM, no transport.
 *
 * Wire format (spec 1.2):
 *
 *   STX(F2) ADDR LENH LENL [TEXT] ETX(03) BCC
 *
 *   TEXT (command)  = 'C' CM PM DATA(0–512)            LEN = 3 + N
 *   TEXT (positive) = 'P' CM PM st0 st1 st2 DATA       LEN = 6 + N
 *   TEXT (negative) = 'N' CM PM e1 e0 DATA             LEN = 5 + N
 *
 * LEN is the big-endian byte count of TEXT only. BCC is the XOR of every
 * byte from STX through ETX inclusive. Both readings come from the spec's
 * framing diagrams (a scanned doc) — parse failures carry a precise reason
 * so a mis-read shows up in the panel log instead of failing silently.
 */
import {
  ACK,
  CMD_HEAD,
  DEFAULT_ADDR,
  EOT,
  ETX,
  MAX_DATA_LEN,
  MAX_TEXT_LEN,
  NAK,
  NEGATIVE_HEADS,
  POSITIVE_HEAD,
  STX,
} from "./constants";

/** XOR checksum over bytes[start..endInclusive]. */
export function bcc(bytes: Uint8Array, start: number, endInclusive: number): number {
  let x = 0;
  for (let i = start; i <= endInclusive; i++) x ^= bytes[i];
  return x;
}

export interface CommandSpec {
  cm: number;
  pm: number;
  data?: Uint8Array;
  addr?: number;
}

export function buildCommandFrame({
  cm,
  pm,
  data = new Uint8Array(0),
  addr = DEFAULT_ADDR,
}: CommandSpec): Uint8Array {
  if (data.length > MAX_DATA_LEN) {
    throw new RangeError(`CRT-591 DATA is ${data.length} bytes; max is ${MAX_DATA_LEN}`);
  }
  const len = 3 + data.length;
  const out = new Uint8Array(4 + len + 2);
  out[0] = STX;
  out[1] = addr;
  out[2] = (len >> 8) & 0xff;
  out[3] = len & 0xff;
  out[4] = CMD_HEAD;
  out[5] = cm;
  out[6] = pm;
  out.set(data, 7);
  out[out.length - 2] = ETX;
  out[out.length - 1] = bcc(out, 0, out.length - 2);
  return out;
}

export interface CrtStatusBytes {
  st0: number;
  st1: number;
  st2: number;
}

export type ParsedFrame =
  | {
      kind: "positive";
      addr: number;
      cm: number;
      pm: number;
      st: CrtStatusBytes;
      data: Uint8Array;
      raw: Uint8Array;
    }
  | {
      kind: "negative";
      addr: number;
      cm: number;
      pm: number;
      e1: number;
      e0: number;
      /** The two error bytes as the ASCII pair the spec's table uses, e.g. "B0". */
      code: string;
      data: Uint8Array;
      raw: Uint8Array;
    };

export type BadFrameReason = "bcc" | "len" | "head" | "overflow";

export type FrameEvent =
  | { type: "ack" }
  | { type: "nak" }
  | { type: "eot" }
  | { type: "frame"; frame: ParsedFrame }
  | { type: "badFrame"; reason: BadFrameReason; raw: Uint8Array }
  | { type: "garbage"; bytes: Uint8Array };

function parseText(raw: Uint8Array, len: number): ParsedFrame | null {
  const addr = raw[1];
  const head = raw[4];
  const cm = raw[5];
  const pm = raw[6];
  const textEnd = 4 + len; // exclusive
  if (head === POSITIVE_HEAD) {
    if (len < 6) return null;
    return {
      kind: "positive",
      addr,
      cm,
      pm,
      st: { st0: raw[7], st1: raw[8], st2: raw[9] },
      data: raw.slice(10, textEnd),
      raw,
    };
  }
  if (NEGATIVE_HEADS.includes(head)) {
    if (len < 5) return null;
    const e1 = raw[7];
    const e0 = raw[8];
    return {
      kind: "negative",
      addr,
      cm,
      pm,
      e1,
      e0,
      code: String.fromCharCode(e1, e0),
      data: raw.slice(9, textEnd),
      raw,
    };
  }
  return null;
}

/**
 * Stateful frame extractor over an arbitrary byte-chunk stream — chunks may
 * split or merge frames and control bytes arbitrarily.
 *
 * Top level: single bytes ACK/NAK/EOT are control events; 0xF2 opens a frame;
 * anything else is a "garbage" run (skipped, but reported so a desynced line
 * is observable). Inside a frame ALL bytes are content — a 0x06 in DATA must
 * not read as an ACK.
 *
 * Recovery: when a frame's boundary is sound (ETX where LEN says it should
 * be) but BCC/head validation fails, the whole frame is consumed — the
 * boundary was right, a byte inside was corrupt, and the engine NAKs for a
 * resend. When the boundary itself is wrong (ETX missing — a truncated frame
 * mis-assembled with the next one), only the STX is dropped and the buffer is
 * re-scanned so the genuine frame inside is found. A frame truncated by a
 * dead device stalls here by design — the engine's response timeout ends
 * with `reset()` via the EOT line-clear.
 */
export class FrameAccumulator {
  private buf: number[] = [];

  reset(): void {
    this.buf = [];
  }

  push(chunk: Uint8Array): FrameEvent[] {
    for (const b of chunk) this.buf.push(b);

    const events: FrameEvent[] = [];
    let garbage: number[] = [];
    const flushGarbage = () => {
      if (garbage.length) {
        events.push({ type: "garbage", bytes: Uint8Array.from(garbage) });
        garbage = [];
      }
    };

    let i = 0;
    while (i < this.buf.length) {
      const b = this.buf[i];
      if (b === ACK || b === NAK || b === EOT) {
        flushGarbage();
        events.push({ type: b === ACK ? "ack" : b === NAK ? "nak" : "eot" });
        i++;
        continue;
      }
      if (b !== STX) {
        garbage.push(b);
        i++;
        continue;
      }
      flushGarbage();
      const avail = this.buf.length - i;
      if (avail < 4) break; // header incomplete — wait for more bytes
      const len = (this.buf[i + 2] << 8) | this.buf[i + 3];
      if (len < 5 || len > MAX_TEXT_LEN) {
        events.push({
          type: "badFrame",
          reason: len > MAX_TEXT_LEN ? "overflow" : "len",
          raw: Uint8Array.from(this.buf.slice(i, i + 4)),
        });
        i++; // drop this STX, rescan the rest
        continue;
      }
      const total = 4 + len + 2; // envelope + ETX + BCC
      if (avail < total) break; // frame incomplete — wait
      const raw = Uint8Array.from(this.buf.slice(i, i + total));
      if (raw[total - 2] !== ETX) {
        // Boundary slip — drop the STX only and rescan for a frame inside.
        events.push({ type: "badFrame", reason: "len", raw });
        i++;
        continue;
      }
      if (bcc(raw, 0, total - 2) !== raw[total - 1]) {
        // Boundary sound, content corrupt — consume it; the engine NAKs.
        events.push({ type: "badFrame", reason: "bcc", raw });
        i += total;
        continue;
      }
      const frame = parseText(raw, len);
      if (!frame) {
        events.push({ type: "badFrame", reason: "head", raw });
        i += total;
        continue;
      }
      events.push({ type: "frame", frame });
      i += total;
    }

    this.buf = this.buf.slice(i);
    flushGarbage();
    return events;
  }
}
