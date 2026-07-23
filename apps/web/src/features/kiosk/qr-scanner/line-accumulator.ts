/**
 * Pure bytes→scan-payload framing for serial-line scanners. The Honeywell
 * 3320g (suffix 990D0A) terminates every scan with CR LF, so a scan is one
 * line: split on \n, strip a trailing \r, trim, drop empties. Splitting on
 * either CR or LF also tolerates LF-only / CR-only devices with zero config.
 *
 * USB chunks split/merge arbitrarily — a payload can arrive across several
 * chunks, or several scans in one — so the tail stays buffered until its
 * terminator shows up. The decoder streams ({stream: true}) because a
 * multibyte UTF-8 character WILL eventually straddle a chunk boundary.
 */
import type { LineFramingOptions } from "./models";

const DEFAULT_MAX_LINE = 8192; // > QR max capacity (~7k numeric chars)

export class LineAccumulator {
  private buf = "";
  private decoder = new TextDecoder();
  private readonly maxLineBytes: number;

  constructor(opts: LineFramingOptions = {}) {
    this.maxLineBytes = opts.maxLineBytes ?? DEFAULT_MAX_LINE;
  }

  /** Feed one raw chunk; returns 0..n complete scan payloads. */
  push(chunk: Uint8Array): string[] {
    this.buf += this.decoder.decode(chunk, { stream: true });
    const parts = this.buf.split(/[\r\n]/);
    this.buf = parts.pop() ?? "";
    // A "line" this long isn't a scan — it's a scanner with no suffix
    // programmed, or wrong-baud garbage. Drop it so the buffer can't grow
    // forever; the panel's rx counter still shows data arriving.
    if (this.buf.length > this.maxLineBytes) this.buf = "";
    return parts.map((p) => p.trim()).filter((p) => p.length > 0);
  }

  /** Drop any buffered partial (call when the port closes). */
  reset(): void {
    this.buf = "";
    this.decoder = new TextDecoder();
  }
}
