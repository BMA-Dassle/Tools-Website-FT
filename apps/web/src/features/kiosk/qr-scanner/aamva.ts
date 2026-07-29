/**
 * AAMVA driver's-license barcode (PDF417) → name + DOB. Pure — no transport,
 * no React. See docs/qr-scanner/README.md § License scans.
 *
 * TRANSPORT SHAPE: the AAMVA payload separates data elements with LF and the
 * header with CR/RS, so LineAccumulator emits ONE physical scan as ~35 separate
 * per-line QrScan events (verified on a real FL license 2026-07-23 — every
 * line landed inside the same millisecond). AamvaBurst regroups them; the
 * consumer flushes after a quiet gap and hands the lines here.
 *
 * PRIVACY (owner stance): the license also carries the address, sex, license
 * number, and document dates — those are deliberately NEVER extracted. Only
 * the name + date of birth leave this parser; nothing else is stored,
 * transmitted, or logged anywhere.
 */

export interface AamvaLicense {
  /** Given name as printed (ALL CAPS on most licenses) — callers format it. */
  firstName: string;
  middleName?: string;
  lastName: string;
  /** Date of birth, "YYYY-MM-DD". */
  dobIso: string;
  /** True when the license flags the first or last name as truncated (DDE/DDF). */
  truncatedName?: boolean;
}

/** Sanity window for a plausible date of birth. */
const DOB_YEAR_MIN = 1900;

/**
 * Decode an 8-digit AAMVA date. USA encodes MMDDCCYY, Canada CCYYMMDD
 * (AAMVA D20 § date fields; DCG carries the country). The wrong-order
 * fallback covers pre-2005 US issuances that used CCYYMMDD.
 */
function decodeDate(raw: string, country: string | undefined): string | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.length !== 8) return null;
  const tryOrder = (order: "mdY" | "Ymd"): string | null => {
    const [y, m, d] =
      order === "mdY"
        ? [digits.slice(4, 8), digits.slice(0, 2), digits.slice(2, 4)]
        : [digits.slice(0, 4), digits.slice(4, 6), digits.slice(6, 8)];
    const yn = Number(y);
    const mn = Number(m);
    const dn = Number(d);
    if (yn < DOB_YEAR_MIN || yn > new Date().getFullYear()) return null;
    if (mn < 1 || mn > 12 || dn < 1 || dn > 31) return null;
    // Real calendar check (Feb 30 etc.) — Date rolls over, so compare back.
    const probe = new Date(yn, mn - 1, dn);
    if (probe.getMonth() !== mn - 1 || probe.getDate() !== dn) return null;
    return `${y}-${m}-${d}`;
  };
  const preferred = country === "CAN" ? ("Ymd" as const) : ("mdY" as const);
  const other = preferred === "mdY" ? ("Ymd" as const) : ("mdY" as const);
  return tryOrder(preferred) ?? tryOrder(other);
}

/**
 * The header line carries the "ANSI " preamble, the subfile designator block,
 * then the first subfile's data inline (e.g. `ANSI 636010090002DL00410269
 * ZF03100075DLDAQ…`). Designators are `DL`/`ID`/`ZF` + 8 digits, so the first
 * spot where DL/ID is immediately followed by a letter-triple is where element
 * data begins — return everything from that inner element onward.
 */
function elementDataOfHeader(line: string): string | null {
  const m = line.match(/(?:DL|ID)(?=[A-Z]{3})/);
  if (!m || m.index === undefined) return null;
  return line.slice(m.index + 2);
}

/**
 * Parse the burst lines of one physical scan. Returns null unless a first
 * name, last name, and plausible DOB were all present (i.e. this wasn't a
 * license — a random QR code never yields all three).
 */
export function parseAamvaLines(lines: readonly string[]): AamvaLicense | null {
  const fields = new Map<string, string>();
  let sawAnsiHeader = false;

  for (const raw of lines) {
    // Strip stray control chars (the RS \x1e between "@" and "ANSI" survives
    // LineAccumulator's trim — it isn't whitespace).
    // eslint-disable-next-line no-control-regex
    const line = raw.replace(/[\x00-\x1f]/g, "").trim();
    if (!line || line === "@") continue;
    let elementLine = line;
    if (/^@?ANSI\b/.test(line) || /^@?AAMVA\b/.test(line)) {
      sawAnsiHeader = true;
      const data = elementDataOfHeader(line);
      if (!data) continue;
      elementLine = data;
    }
    const code = elementLine.slice(0, 3);
    if (!/^[A-Z]{3}$/.test(code)) continue;
    const value = elementLine.slice(3).trim();
    // First write wins: the DL subfile precedes jurisdiction subfiles, and a
    // duplicate code in a later subfile must not overwrite the real one.
    if (!fields.has(code)) fields.set(code, value);
  }

  // Names — current spec (v04+) codes first, then the legacy fallbacks:
  // DCT (v02–03) is the full given name ("FIRST MIDDLE"), DAA (v01) the full
  // name ("LAST,FIRST,MIDDLE"), DAB (v01) the last name alone.
  let firstName = fields.get("DAC") ?? "";
  let middleName = fields.get("DAD") ?? "";
  let lastName = fields.get("DCS") ?? fields.get("DAB") ?? "";
  if (!firstName && fields.get("DCT")) {
    const [first, ...mid] = fields
      .get("DCT")!
      .split(/[\s,]+/)
      .filter(Boolean);
    firstName = first ?? "";
    if (!middleName) middleName = mid.join(" ");
  }
  if ((!firstName || !lastName) && fields.get("DAA")) {
    const parts = fields
      .get("DAA")!
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length >= 2) {
      lastName = lastName || parts[0];
      firstName = firstName || parts[1];
      if (!middleName && parts[2]) middleName = parts[2];
    }
  }

  // "NONE" is a real AAMVA filler value for absent middle names.
  if (/^NONE$/i.test(middleName)) middleName = "";

  const dobIso = fields.has("DBB") ? decodeDate(fields.get("DBB")!, fields.get("DCG")) : null;

  // Require the ANSI header for multi-line bursts EXCEPT when the fields alone
  // are conclusive — a wedge of three matching elements without a header is
  // still unmistakably a license fragment, and requiring the header would make
  // a clipped first chunk (slow trigger pull) drop the whole scan.
  if (!firstName.trim() || !lastName.trim() || !dobIso) return null;
  if (!sawAnsiHeader && fields.size < 3) return null;

  const truncated = fields.get("DDE") === "T" || fields.get("DDF") === "T";
  return {
    firstName: firstName.trim(),
    ...(middleName.trim() ? { middleName: middleName.trim() } : {}),
    lastName: lastName.trim(),
    dobIso,
    ...(truncated ? { truncatedName: true } : {}),
  };
}

/**
 * Regroups the per-line QrScan events of one physical scan. Pure and
 * timer-free: the consumer pushes every payload and calls flush() after its
 * own quiet-gap timeout (useLicenseScan uses 350 ms — a real burst lands in
 * single-digit milliseconds, so the gap is generous yet invisible).
 */
export class AamvaBurst {
  private lines: string[] = [];

  push(payload: string): void {
    this.lines.push(payload);
  }

  get size(): number {
    return this.lines.length;
  }

  /** Take the buffered burst's raw lines, clearing it — the consumer decides
   *  what they are (AAMVA license vs a single-line QR like the SMS-Timing
   *  member code). */
  flushLines(): string[] {
    const lines = this.lines;
    this.lines = [];
    return lines;
  }

  /** Take the buffered burst (clearing it) and parse. Null = not a license. */
  flush(): AamvaLicense | null {
    const lines = this.flushLines();
    if (lines.length === 0) return null;
    return parseAamvaLines(lines);
  }

  reset(): void {
    this.lines = [];
  }
}
