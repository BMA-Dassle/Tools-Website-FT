/**
 * CRT-591 error decoding — the e1/e0 table from spec 2.2, plus the typed
 * error hierarchy the engine/client reject with.
 *
 * e1/e0 arrive as two ASCII characters (e.g. "B0" = 42h 30h on the wire).
 */
import type { CommandClass } from "./constants";
import type { ParsedFrame } from "./frame";

export type CrtErrorCategory =
  /** Communication/data hiccup — safe to resend the same command. */
  | "retryable"
  /** Device wants an INIT first (power-cycled, or command out of sequence). */
  | "needsInit"
  /** Physical intervention needed — jam, empty stacker, full bin, motor. */
  | "attention"
  /** The card is the problem (bad IC contact, unsupported card), not the machine. */
  | "cardError"
  /** Wrong usage or wrong hardware — retrying the same bytes cannot succeed. */
  | "fatal";

export interface CrtErrorInfo {
  code: string;
  message: string;
  category: CrtErrorCategory;
  hint?: string;
}

const MODEL_HINT =
  "If this happens on a documented command, the unit may be a different CRT-591 variant " +
  "than the M001 protocol doc — check the model banner and docs/crt-591/README.md.";

/** Defined codes from spec 2.2; the table's blank rows fall through to unknown. */
const ERROR_TABLE: Record<string, Omit<CrtErrorInfo, "code">> = {
  "00": { message: "Reception of undefined command", category: "fatal", hint: MODEL_HINT },
  "01": { message: "Command parameter error", category: "fatal" },
  "02": {
    message: "Command sequence error",
    category: "needsInit",
    hint: "Run Init, then retry the operation in order.",
  },
  "03": { message: "Command not supported by this hardware", category: "fatal", hint: MODEL_HINT },
  "04": { message: "Command data error (communication package data)", category: "retryable" },
  "05": {
    message: "IC card contact not released",
    category: "cardError",
    hint: "Power the card down (deactivate) before moving it.",
  },
  "10": {
    message: "Card jam",
    category: "attention",
    hint: "Open the transport, clear the jammed card, then press Init.",
  },
  "12": {
    message: "Sensor error",
    category: "attention",
    hint: "Check for debris over the sensors; power-cycle if it persists.",
  },
  "13": {
    message: "Card too long",
    category: "attention",
    hint: "Remove the card and check stock.",
  },
  "14": {
    message: "Card too short",
    category: "attention",
    hint: "Remove the card and check stock.",
  },
  "40": {
    message: "Unable to retract card",
    category: "attention",
    hint: "Card may be held at the gate — remove it, then press Init.",
  },
  "41": { message: "IC card magnet error", category: "cardError" },
  "43": {
    message: "Unable to move card to IC position",
    category: "attention",
    hint: "Check the transport path and stacker, then press Init.",
  },
  "45": {
    message: "Card was moved manually",
    category: "needsInit",
    hint: "Press Init so the device re-finds the card position.",
  },
  "50": {
    message: "Retract counter overflow",
    category: "attention",
    hint: "Empty the error bin and reset the bin counter.",
  },
  "51": {
    message: "Motor error",
    category: "attention",
    hint: "Power-cycle the unit; if it repeats, the transport needs service.",
  },
  "60": { message: "Short circuit on IC card power supply", category: "cardError" },
  "61": {
    message: "Card activation failed",
    category: "cardError",
    hint: "Re-seat or replace the card.",
  },
  "62": { message: "Command not supported by this IC card", category: "cardError" },
  "65": { message: "IC card disabled", category: "cardError" },
  "66": { message: "Command not supported by the current IC card", category: "cardError" },
  "67": { message: "IC card transmission error", category: "cardError" },
  "68": { message: "IC card transmission timeout", category: "cardError" },
  "69": { message: "CPU/SAM card is not EMV-compliant", category: "cardError" },
  A0: {
    message: "Card stacker is empty",
    category: "attention",
    hint: "Refill the stacker with blank cards.",
  },
  A1: {
    message: "Error card bin is full",
    category: "attention",
    hint: "Empty the error bin, then reset the bin counter.",
  },
  B0: {
    message: "Device has not been reset since power-on",
    category: "needsInit",
    hint: "Run Init — the device rejects everything else until then.",
  },
};

export function decodeError(e1: number, e0: number): CrtErrorInfo {
  const code = String.fromCharCode(e1, e0);
  const known = ERROR_TABLE[code];
  if (known) return { code, ...known };
  return {
    code,
    message: `Unknown device error "${code}"`,
    category: "fatal",
    hint: MODEL_HINT,
  };
}

/** The device answered with a negative response. */
export class CrtError extends Error {
  readonly info: CrtErrorInfo;
  readonly cm: number;
  readonly pm: number;
  readonly frame: Extract<ParsedFrame, { kind: "negative" }>;

  constructor(frame: Extract<ParsedFrame, { kind: "negative" }>) {
    const info = decodeError(frame.e1, frame.e0);
    super(`CRT-591 error ${info.code}: ${info.message}`);
    this.name = "CrtError";
    this.info = info;
    this.cm = frame.cm;
    this.pm = frame.pm;
    this.frame = frame;
  }
}

export type CrtLinkFailure =
  | "ackTimeout"
  | "nakRetriesExhausted"
  | "badResponseRetriesExhausted"
  | "portClosed";

/** The line itself failed — no (usable) response ever arrived. */
export class CrtLinkError extends Error {
  readonly failure: CrtLinkFailure;

  constructor(failure: CrtLinkFailure, detail?: string) {
    super(
      {
        ackTimeout: "Device did not acknowledge the command (link dead or wrong baud)",
        nakRetriesExhausted: "Device kept rejecting the command (NAK) — line noise or framing bug",
        badResponseRetriesExhausted: "Device kept sending corrupted responses",
        portClosed: "Serial port closed while a command was in flight",
      }[failure] + (detail ? ` — ${detail}` : ""),
    );
    this.name = "CrtLinkError";
    this.failure = failure;
  }
}

/** ACKed but never answered within the command class's execution budget. */
export class CrtTimeoutError extends Error {
  readonly commandClass: CommandClass;
  readonly elapsedMs: number;

  constructor(commandClass: CommandClass, elapsedMs: number) {
    super(`CRT-591 did not finish a "${commandClass}" command within ${elapsedMs} ms`);
    this.name = "CrtTimeoutError";
    this.commandClass = commandClass;
    this.elapsedMs = elapsedMs;
  }
}

/** The in-flight command was cancelled (EOT) by the host. */
export class CrtCancelledError extends Error {
  constructor() {
    super("Command cancelled (line cleared)");
    this.name = "CrtCancelledError";
  }
}

/**
 * A magnetic read completed but didn't yield a clean card number — a partial /
 * settling / stale-buffer read (garbage or only track 1). Categorized as a CARD
 * fault so callers retry the read / re-dispense a fresh blank rather than credit
 * a mis-read account. NEVER surfaced as a valid card number.
 */
export class CrtReadError extends Error {
  readonly deviceCode: string;
  readonly ascii: string;
  constructor(deviceCode: string, ascii: string) {
    super(`Magnetic read didn't return a valid card number (device ${deviceCode})`);
    this.name = "CrtReadError";
    this.deviceCode = deviceCode;
    this.ascii = ascii;
  }
}

/**
 * The device answered POSITIVELY but the embedded card operation failed —
 * Mifare/I2C pseudo-APDU responses end in SW1SW2 (spec 3.6.4): 9000 success,
 * 6F00 fail, 6B00 address overflow, 6700 length overflow.
 */
export class CrtCardSwError extends Error {
  readonly sw1: number;
  readonly sw2: number;
  readonly sw: string;

  constructor(sw1: number, sw2: number) {
    const sw =
      `${sw1.toString(16).padStart(2, "0")}${sw2.toString(16).padStart(2, "0")}`.toUpperCase();
    const meaning =
      {
        "6F00": "operation failed (wrong key or protected block?)",
        "6B00": "address overflow",
        "6700": "operation length overflow",
      }[sw] ?? "card operation failed";
    super(`Card returned SW ${sw}: ${meaning}`);
    this.name = "CrtCardSwError";
    this.sw1 = sw1;
    this.sw2 = sw2;
    this.sw = sw;
  }
}
