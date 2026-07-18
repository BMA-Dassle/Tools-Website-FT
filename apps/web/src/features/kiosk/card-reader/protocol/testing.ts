/**
 * Test-support builders for DEVICE→HOST frames (production code only ever
 * builds command frames). Imported by *.test.ts files and the scripted fake
 * transport — never by runtime code.
 */
import { DEFAULT_ADDR, ETX, POSITIVE_HEAD, STX } from "./constants";
import { bcc } from "./frame";

function envelope(text: number[], addr: number): Uint8Array {
  const len = text.length;
  const out = new Uint8Array(4 + len + 2);
  out[0] = STX;
  out[1] = addr;
  out[2] = (len >> 8) & 0xff;
  out[3] = len & 0xff;
  out.set(text, 4);
  out[out.length - 2] = ETX;
  out[out.length - 1] = bcc(out, 0, out.length - 2);
  return out;
}

export function buildPositiveResponse(opts: {
  cm: number;
  pm: number;
  st?: [number, number, number];
  data?: number[] | Uint8Array;
  addr?: number;
}): Uint8Array {
  const st = opts.st ?? [0x30, 0x32, 0x30];
  const data = Array.from(opts.data ?? []);
  return envelope([POSITIVE_HEAD, opts.cm, opts.pm, ...st, ...data], opts.addr ?? DEFAULT_ADDR);
}

export function buildNegativeResponse(opts: {
  cm: number;
  pm: number;
  code: string; // e.g. "B0"
  data?: number[] | Uint8Array;
  addr?: number;
  head?: number; // default 'N' (0x4e); tests also exercise 0x45
}): Uint8Array {
  const data = Array.from(opts.data ?? []);
  const [e1, e0] = [opts.code.charCodeAt(0), opts.code.charCodeAt(1)];
  return envelope(
    [opts.head ?? 0x4e, opts.cm, opts.pm, e1, e0, ...data],
    opts.addr ?? DEFAULT_ADDR,
  );
}
