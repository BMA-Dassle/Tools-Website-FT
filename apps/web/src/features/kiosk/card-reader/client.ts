/**
 * CrtReaderClient — the typed surface over the protocol engine.
 *
 * `connect()` runs the full handshake: probe candidate bauds (EOT line-clear
 * + INIT at each), then discover the device's identity (version A4h, config
 * A3h, serial number A2h). It takes a transport FACTORY rather than a Web
 * Serial port so the whole client is testable against a scripted fake; the
 * Web Serial adapter lives in transport/serial-transport.ts.
 *
 * Model note: the protocol doc is CRT-591-M001. When the connected unit
 * reports something else (`info.modelMismatch`), everything here still holds
 * for the family-shared commands, and undocumented commands (magstripe) go
 * through `raw()` — see docs/crt-591/README.md.
 */
import {
  binCounterReadCommand,
  binCounterSetCommand,
  entryCommand,
  initCommand,
  magReadCommand,
  moveMagPositionCommand,
  parseMagRead,
  permitEntryCommand,
  prohibitEntryCommand,
  type MagTracks,
  mifareDownloadKeyCommand,
  mifareReadCommand,
  mifareVerifyEepromKeyCommand,
  mifareVerifyKeyCommand,
  mifareWriteCommand,
  moveCommand,
  parseBinCounter,
  parseFirmware,
  parseRfActivation,
  parseRfStatus,
  parseSerialNumber,
  parseSwResult,
  parseVersion,
  pcscResetCommand,
  readConfigCommand,
  readVersionCommand,
  rfActivateCommand,
  rfDeactivateCommand,
  rfStatusCommand,
  sensorsCommand,
  serialNumberCommand,
  statusCommand,
  type CommandRequest,
  type MifareKey,
  type RfActivateOrder,
  type RfActivation,
  type RfStatus,
} from "./protocol/commands";
import {
  BAUD_CANDIDATES,
  type CommandClass,
  type InitMode,
  type MoveTarget,
} from "./protocol/constants";
import { CrtError, CrtLinkError, CrtReadError } from "./protocol/errors";
import type { ParsedFrame } from "./protocol/frame";
import {
  binStateFromSensors,
  parseSensors,
  parseStatus,
  type CrtStatus,
  type ErrorBinLevel,
  type SensorStatus,
} from "./protocol/status";
import {
  CrtProtocolEngine,
  type EngineLogEvent,
  type PositiveFrame,
} from "./engine/protocol-engine";
import { hexDump } from "./log";
import type { ByteTransport } from "./transport/types";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface CrtDeviceInfo {
  /** From the INIT response DATA, e.g. "CRT-591-M001". */
  firmware: string;
  /** From READ VERSION (A4h) — null if the unit rejects the command. */
  version: string | null;
  /** From A2h — null if rejected. Doubles as the kiosk's dispenserId. */
  serialNumber: string | null;
  /** From A3h, hex — format undocumented, display-only. */
  configHex: string | null;
  baudRate: number;
  /** True when nothing the device reported contains "M001" (the doc'd model). */
  modelMismatch: boolean;
}

export interface CrtResult<T = void> {
  status: CrtStatus;
  value: T;
}

export interface ConnectOptions {
  /** Try this baud first (persisted from the last successful connect). */
  preferredBaud?: number | null;
  addr?: number;
  onLog?: (e: EngineLogEvent) => void;
  onProgress?: (message: string) => void;
}

export type TransportFactory = (baudRate: number) => Promise<ByteTransport>;

export class CrtReaderClient {
  private readonly engine: CrtProtocolEngine;
  private readonly transport: ByteTransport;
  readonly info: CrtDeviceInfo;

  private readonly statusListeners = new Set<(s: CrtStatus) => void>();
  private closed = false;

  private constructor(engine: CrtProtocolEngine, transport: ByteTransport, info: CrtDeviceInfo) {
    this.engine = engine;
    this.transport = transport;
    this.info = info;
    transport.onClose((reason) => {
      if (this.closed) return; // deliberate close() — not a surprise
      this.closed = true;
      this.engine.dispose();
      for (const cb of this.disconnectListeners) cb(reason);
      this.disconnectListeners.clear();
    });
  }

  private disconnectListeners = new Set<(reason: string | null) => void>();

  /** Fired when the transport dies underneath us (USB yank, port error). */
  onDisconnected(cb: (reason: string | null) => void): () => void {
    this.disconnectListeners.add(cb);
    return () => this.disconnectListeners.delete(cb);
  }

  static async connect(
    openTransport: TransportFactory,
    opts: ConnectOptions = {},
  ): Promise<CrtReaderClient> {
    const candidates = [
      ...new Set([opts.preferredBaud, ...BAUD_CANDIDATES].filter((b): b is number => !!b)),
    ];
    let lastLinkError: Error | null = null;

    for (const baudRate of candidates) {
      opts.onProgress?.(`Trying ${baudRate} baud…`);
      let transport: ByteTransport;
      try {
        transport = await openTransport(baudRate);
      } catch (err) {
        // Port-level failure (in use / permission) — no point trying other bauds.
        throw err;
      }
      const engine = new CrtProtocolEngine(transport, { addr: opts.addr });
      const unlog = opts.onLog ? engine.onLog(opts.onLog) : null;
      try {
        await engine.lineClear();
        opts.onProgress?.(`Initializing at ${baudRate} baud…`);
        // leaveCard: never move a card a previous session left mid-transport.
        // Tighter-than-default timeout: a real INIT answers in a few seconds;
        // keeping the probe snappy matters more than the 30s worst case here.
        const initFrame = await engine.send(initCommand("leaveCard"), {
          commandClass: "init",
          timeoutMs: 12_000,
        });
        const firmware = parseFirmware(initFrame.data);

        opts.onProgress?.("Reading device identity…");
        const version = await CrtReaderClient.tryRead(engine, readVersionCommand(), parseVersion);
        const configHex = await CrtReaderClient.tryRead(engine, readConfigCommand(), (d) =>
          d.length ? hexDump(d) : null,
        );
        const serialNumber = await CrtReaderClient.tryRead(
          engine,
          serialNumberCommand(),
          parseSerialNumber,
        );

        const reported = [firmware, version ?? ""].join(" ");
        const info: CrtDeviceInfo = {
          firmware,
          version: version || null,
          serialNumber: serialNumber || null,
          configHex,
          baudRate,
          modelMismatch: !/M001/i.test(reported),
        };
        const client = new CrtReaderClient(engine, transport, info);
        client.pushStatus(parseStatus(initFrame.st));
        if (opts.onLog) {
          // Hand the log subscription over to the client's lifetime.
          client.onClosed(() => unlog?.());
        } else {
          unlog?.();
        }
        return client;
      } catch (err) {
        unlog?.();
        engine.dispose();
        await transport.close().catch(() => undefined);
        // Any link-level failure at this baud — silence (ackTimeout), noise
        // (NAK), a corrupt reply, OR the port closing on a framing/parity error
        // — is a "wrong baud (or transient noise)" signal: close this attempt
        // and try the next candidate. transport.close() above frees the port so
        // the next openTransport() re-opens it cleanly. Only a hard open failure
        // (in use / permission), thrown from openTransport, aborts the sweep.
        if (err instanceof CrtLinkError) {
          lastLinkError = err;
          continue;
        }
        throw err;
      }
    }

    throw new CrtLinkError(
      "ackTimeout",
      `no response at ${candidates.join("/")} baud — check the COM cable, device power, and DIP address, ` +
        `close any other program using the port (vendor debug tool), then power-cycle the unit and retry` +
        (lastLinkError ? ` (last: ${lastLinkError.message})` : ""),
    );
  }

  /** Discovery reads are best-effort — a family variant may reject them. */
  private static async tryRead<T>(
    engine: CrtProtocolEngine,
    request: CommandRequest,
    parse: (data: Uint8Array) => T,
  ): Promise<T | null> {
    try {
      const frame = await engine.send(request, { commandClass: request.commandClass });
      return parse(frame.data);
    } catch (err) {
      if (err instanceof CrtError) return null;
      throw err;
    }
  }

  /* ---------------------------------------------------------------- */

  onStatus(cb: (s: CrtStatus) => void): () => void {
    this.statusListeners.add(cb);
    return () => this.statusListeners.delete(cb);
  }

  onLog(cb: (e: EngineLogEvent) => void): () => void {
    return this.engine.onLog(cb);
  }

  private closedListeners = new Set<() => void>();
  private onClosed(cb: () => void): void {
    this.closedListeners.add(cb);
  }

  private pushStatus(status: CrtStatus) {
    for (const cb of this.statusListeners) cb(status);
  }

  /**
   * Send a typed request. `idempotent` requests get ONE automatic
   * INIT(leaveCard)+retry when the device demands a reset (error category
   * "needsInit", e.g. B0 after a power-cycle). Motion/write commands never
   * auto-retry — staff decide via the panel's Re-init action.
   */
  private async run<T>(
    request: CommandRequest,
    parse: (frame: PositiveFrame) => T,
    o: { idempotent?: boolean; signal?: AbortSignal } = {},
  ): Promise<CrtResult<T>> {
    try {
      const frame = await this.engine.send(request, {
        commandClass: request.commandClass,
        signal: o.signal,
      });
      const status = parseStatus(frame.st);
      this.pushStatus(status);
      return { status, value: parse(frame) };
    } catch (err) {
      if (o.idempotent && err instanceof CrtError && err.info.category === "needsInit") {
        const initFrame = await this.engine.send(initCommand("leaveCard"), {
          commandClass: "init",
        });
        this.pushStatus(parseStatus(initFrame.st));
        const frame = await this.engine.send(request, {
          commandClass: request.commandClass,
          signal: o.signal,
        });
        const status = parseStatus(frame.st);
        this.pushStatus(status);
        return { status, value: parse(frame) };
      }
      throw err;
    }
  }

  /* --- dispenser --- */

  init(mode: InitMode = "leaveCard"): Promise<CrtResult<{ firmware: string }>> {
    return this.run(initCommand(mode), (f) => ({ firmware: parseFirmware(f.data) }));
  }

  getStatus(): Promise<CrtResult> {
    return this.run(statusCommand(), () => undefined, { idempotent: true });
  }

  getSensors(): Promise<CrtResult<SensorStatus>> {
    return this.run(sensorsCommand(), (f) => parseSensors(f.data), { idempotent: true });
  }

  /**
   * Reject-bin state, read from the SENSOR block (not the unreliable st2
   * `errorBin` byte). Idempotent — safe to poll while a hold waits for staff to
   * empty the bin. See binStateFromSensors for the byte mapping on this unit.
   */
  readBinState(): Promise<CrtResult<ErrorBinLevel>> {
    return this.run(sensorsCommand(), (f) => binStateFromSensors(f.data), { idempotent: true });
  }

  moveCard(to: MoveTarget): Promise<CrtResult> {
    return this.run(moveCommand(to), () => undefined);
  }

  /**
   * Feed a blank from the stacker and present it at the gate — MOVE 31h
   * (dispense to the IC position) then MOVE 39h (out of gate). Spec 3.1.3.
   */
  async dispenseCard(): Promise<CrtResult> {
    await this.run(moveCommand("icPosition"), () => undefined);
    return this.run(moveCommand("outOfGate"), () => undefined);
  }

  /**
   * Retract the held card to the error bin. The M001 doc says that's MOVE 33h
   * ("retract to error card bin"), but on this HB-HDN unit 33h does NOT move the
   * card — it sits at the read station (the "it kept the same card while it
   * retried" bug). MOVE 39h (the doc's "out of gate") is what actually routes a
   * card to the error bin on this unit — the same deviation the present path
   * found (39h binned instead of presenting, so present uses 30h). So we bin
   * with 39h here.
   */
  captureCard(): Promise<CrtResult> {
    return this.run(moveCommand("outOfGate"), () => undefined);
  }

  setEntry(enabled: boolean): Promise<CrtResult> {
    return this.run(entryCommand(enabled), () => undefined);
  }

  /* --- RF / Mifare --- */

  rfActivate(order?: RfActivateOrder): Promise<CrtResult<RfActivation>> {
    return this.run(rfActivateCommand(order), (f) => parseRfActivation(f.data));
  }

  rfDeactivate(): Promise<CrtResult> {
    return this.run(rfDeactivateCommand(), () => undefined);
  }

  rfStatus(): Promise<CrtResult<RfStatus>> {
    return this.run(rfStatusCommand(), (f) => parseRfStatus(f.data), { idempotent: true });
  }

  /* async so builder validation errors (bad key hex, trailer-block writes)
   * reject instead of throwing synchronously. */

  async mifareVerifyKey(a: { key: MifareKey; sector: number; keyHex: string }): Promise<CrtResult> {
    return this.run(mifareVerifyKeyCommand(a), (f) => {
      parseSwResult(f.data);
    });
  }

  async mifareVerifyEepromKey(a: { key: MifareKey; sector: number }): Promise<CrtResult> {
    return this.run(mifareVerifyEepromKeyCommand(a), (f) => {
      parseSwResult(f.data);
    });
  }

  async mifareDownloadKey(a: {
    key: MifareKey;
    sector: number;
    keyHex: string;
  }): Promise<CrtResult> {
    return this.run(mifareDownloadKeyCommand(a), (f) => {
      parseSwResult(f.data);
    });
  }

  async mifareRead(a: {
    sector: number;
    block: number;
    blocks: number;
  }): Promise<CrtResult<Uint8Array>> {
    return this.run(mifareReadCommand(a), (f) => parseSwResult(f.data));
  }

  async mifareWrite(a: {
    sector: number;
    block: number;
    data: Uint8Array;
    blockSize?: 4 | 16;
  }): Promise<CrtResult> {
    return this.run(mifareWriteCommand(a), (f) => {
      parseSwResult(f.data);
    });
  }

  /* --- magnetic stripe (CRT-591-(R02)HB-HDN; reverse-engineered) --- */

  /** Move the card to the magnetic read position (MOVE PM=34). */
  moveToMagPosition(): Promise<CrtResult> {
    return this.run(moveMagPositionCommand(), () => undefined);
  }

  /** Permit a mag card in at the gate (ENTRY 32h) — the reader auto-carries it. */
  permitEntry(): Promise<CrtResult> {
    return this.run(permitEntryCommand(), () => undefined);
  }

  /** Stop allowing cards in (ENTRY 30h) — sent after a reload dispenses. */
  prohibitEntry(): Promise<CrtResult> {
    return this.run(prohibitEntryCommand(), () => undefined);
  }

  /**
   * Read the magnetic tracks (CM 36h/PM 37h). The device replies with head
   * 'N' and the track buffer in the payload, so this uses sendRaw (which does
   * not treat the negative head as an error) and parses the tracks out.
   */
  async magRead(): Promise<MagTracks> {
    const frame = await this.engine.sendRaw(magReadCommand(), { commandClass: "cardIo" });
    const mag =
      frame.kind === "positive"
        ? parseMagRead({ kind: "positive", data: frame.data })
        : parseMagRead({ kind: "negative", data: frame.data, e1: frame.e1, e0: frame.e0 });
    if (frame.kind === "positive") this.pushStatus(parseStatus(frame.st));
    // A clean read yields the 16-digit track-2 account. No valid number means the
    // read didn't land — device rejected it (card not at the read station), or a
    // partial/settling/stale-buffer read (garbage or only track 1). Throw a CARD
    // fault so the caller retries / re-dispenses instead of crediting garbage.
    if (!mag.cardNumber) {
      const code = frame.kind === "negative" ? frame.code : "P" + frame.pm.toString(16);
      throw new CrtReadError(code, mag.ascii);
    }
    return mag;
  }

  /* --- end-to-end flows (buy a new card / reload an existing one) --- */

  /**
   * Poll status until a card appears, or time out. With `requireReadPosition`,
   * wait for the card to reach the read station (st0=2) rather than returning
   * the instant it shows at the gate — the reader auto-carries an inserted
   * card inward, and reading before it settles gets "undefined command".
   */
  async waitForCard(
    opts: { timeoutMs?: number; signal?: AbortSignal; requireReadPosition?: boolean } = {},
  ): Promise<CrtStatus> {
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (opts.signal?.aborted) throw new DOMException("aborted", "AbortError");
      const { status } = await this.getStatus();
      const ready = opts.requireReadPosition
        ? status.card === "atRfIcPosition"
        : status.card !== "none";
      if (ready) return status;
      if (Date.now() >= deadline) throw new Error("No card was inserted within the wait window.");
      await delay(800);
    }
  }

  /**
   * BUY flow, phase 1 — issue a NEW card: bring a blank from the stacker to the
   * magnetic read station and read its account. The card is left INSIDE at the
   * read station (not presented) until the purchase is confirmed — call
   * ejectCard() then.
   *
   * Order matters (and MOVE 31h is the wrong feed): 31h sends the card to the
   * GATE (st0=1), where the reader rejects the mag read, so the old sequence
   * poked the card out the front and dragged it back. Instead we feed straight
   * to the read station (MOVE 34h) — clean, no front poke. If that doesn't pull
   * a card from the stacker (read yields nothing), fall back to the documented
   * stacker dispense (31h → gate) then reposition (34h).
   */
  async issueAndReadCard(): Promise<MagTracks> {
    // MOVE 34h dispenses a blank straight from the stacker to the read station
    // (st0=2) — confirmed against the vendor tool's buy sequence.
    await this.moveToMagPosition();
    try {
      return await this.readMagAfterSettle();
    } catch (err) {
      // The read failed. Tell the two causes apart with the card sensor:
      //  • A card IS at the read station but couldn't be read (e.g. loaded facing
      //    the wrong way). Do NOT run the 31h fallback — that pokes the card out
      //    to the gate and drags it back (the "why did it go to the gate" bug).
      //    Rethrow so the caller bins it STRAIGHT to the error bin.
      //  • NO card reached the station (34h pulled nothing) — only then fall back
      //    to the documented stacker dispense (31h → gate) and reposition (34h).
      let cardPresent = true; // safe default: never poke an unread card to the gate
      try {
        cardPresent = (await this.getStatus()).status.card !== "none";
      } catch {
        /* status unavailable — keep the safe no-gate path (rethrow) */
      }
      if (cardPresent) throw err;
      await this.moveCard("icPosition"); // 31h: documented stacker dispense (→ gate)
      await this.moveToMagPosition(); // 34h: retract to the read station
      return this.readMagAfterSettle();
    }
  }

  /**
   * Read the magnetic stripe after letting the card settle under the head, with
   * one retry. A read fired the instant after MOVE 34h positions the card often
   * comes back with NO track data — the card is still moving/settling — which the
   * buy flow surfaced as "couldn't read the dispensed card." The reload path
   * already waits (waitForCard requireReadPosition) before reading; the buy path
   * did not. A short settle + a single retry makes the first read reliable.
   * (Owner 2026-07-19: new-card dispense "attempted to read, something went wrong".)
   */
  private async readMagAfterSettle(): Promise<MagTracks> {
    await delay(250);
    try {
      const first = await this.magRead();
      if (first.cardNumber) return first;
    } catch {
      /* no track data on the first pass — settle longer, then read once more */
    }
    await delay(300);
    return this.magRead();
  }

  /**
   * RELOAD flow, phase 1 — accept an EXISTING card: permit entry, wait for the
   * guest to insert one, and read its account. On insert the reader AUTO-CARRIES
   * the card to the read station (spec 3.1.4), so no positioning move is needed
   * — we just wait until it has settled there, then read.
   * The card is held inside; call ejectCard() to return it after the reload.
   */
  async acceptAndReadCard(
    opts: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<MagTracks> {
    await this.permitEntry();
    try {
      await this.waitForCard({ ...opts, requireReadPosition: true });
      return await this.magRead();
    } finally {
      // Close the gate BEFORE the caller presents the card back: with entry
      // still permitted, the unit treats the presented card as a fresh
      // insertion and auto-carries it straight back inside (spec 3.1.4) — the
      // reload "it takes the card" bug (owner 2026-07-18). Best-effort so a
      // gate error never masks the read result.
      await this.prohibitEntry().catch(() => {});
    }
  }

  /**
   * Present the held card at the gate for the customer to take — finishes both
   * the buy and reload flows. Uses MOVE 30h (holding → card at the gate), which
   * is what the vendor tool uses to hand a card back; MOVE 39h ("out of gate")
   * behaves differently on this unit and sent the card to the error bin.
   */
  presentCard(): Promise<CrtResult> {
    return this.moveCard("holding");
  }

  /* --- identity / housekeeping --- */

  readVersion(): Promise<CrtResult<string>> {
    return this.run(readVersionCommand(), (f) => parseVersion(f.data), { idempotent: true });
  }

  readSerialNumber(): Promise<CrtResult<string>> {
    return this.run(serialNumberCommand(), (f) => parseSerialNumber(f.data), { idempotent: true });
  }

  readConfig(): Promise<CrtResult<string>> {
    return this.run(readConfigCommand(), (f) => hexDump(f.data), { idempotent: true });
  }

  readBinCounter(): Promise<CrtResult<number | null>> {
    return this.run(binCounterReadCommand(), (f) => parseBinCounter(f.data), { idempotent: true });
  }

  async resetBinCounter(count = 0): Promise<CrtResult> {
    return this.run(binCounterSetCommand(count), () => undefined);
  }

  pcscReset(): Promise<CrtResult> {
    return this.run(pcscResetCommand(), () => undefined);
  }

  /**
   * Escape hatch for commands outside the M001 doc (the HB-HDN unit's
   * magstripe set, once the vendor doc arrives). Returns the parsed frame
   * verbatim — positive OR the CrtError is thrown like everywhere else.
   */
  raw(
    cm: number,
    pm: number,
    data?: Uint8Array,
    commandClass: CommandClass = "cardIo",
  ): Promise<ParsedFrame> {
    // sendRaw, not send: the raw console must surface a negative-head reply
    // (e.g. probing undocumented commands) instead of throwing it away.
    return this.engine.sendRaw({ cm, pm, data }, { commandClass });
  }

  cancel(): Promise<void> {
    return this.engine.cancel();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.engine.dispose();
    await this.transport.close().catch(() => undefined);
    for (const cb of this.closedListeners) cb();
    this.closedListeners.clear();
    this.statusListeners.clear();
  }
}
