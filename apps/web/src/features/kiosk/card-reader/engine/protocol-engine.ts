/**
 * CRT-591 protocol engine — the half-duplex ACK/NAK/EOT state machine
 * between the frame codec and a byte transport (spec 1.4).
 *
 * Per command:  idle → tx command → await ACK (300 ms; NAK/silence → resend,
 * bounded) → await response (per-class execution timeout) → validate →
 * tx ACK → done. Single-flight with a FIFO queue — the CRT-591 is a slave
 * device on a half-duplex line; concurrency is a protocol violation.
 *
 * Motion safety: spec Case 4 (re-send the command shortly after ACK if no
 * response) is applied ONLY to "quick" commands. Re-issuing a motor command
 * because its response was slow would double-execute it; motion commands
 * rely on the execution timeout + EOT line-clear instead.
 */
import {
  ACK,
  ACK_TIMEOUT_MS,
  CM,
  DEFAULT_ADDR,
  EOT,
  EXEC_TIMEOUT_MS,
  NAK,
  type CommandClass,
} from "../protocol/constants";
import {
  CrtCancelledError,
  CrtError,
  CrtLinkError,
  CrtTimeoutError,
  decodeError,
} from "../protocol/errors";
import {
  buildCommandFrame,
  FrameAccumulator,
  type FrameEvent,
  type ParsedFrame,
} from "../protocol/frame";
import type { ByteTransport } from "../transport/types";

export interface EngineOptions {
  addr?: number;
  ackTimeoutMs?: number;
  /** Resends after command NAK or ACK silence (spec Cases 1–2). */
  commandResendLimit?: number;
  /** NAKs we send for corrupted responses before giving up (spec Case 3). */
  responseNakLimit?: number;
  /** Case 4 — resend a "quick" command if the response lags this long. */
  quickResendAfterAckMs?: number;
  /** How long we wait for the device's EOT during a line clear. */
  eotTimeoutMs?: number;
}

export interface EngineLogEvent {
  dir: "tx" | "rx";
  t: number;
  bytes: Uint8Array;
  decoded: string;
  level: "info" | "warn" | "error";
}

export type PositiveFrame = Extract<ParsedFrame, { kind: "positive" }>;

interface SendJob {
  frameBytes: Uint8Array;
  cm: number;
  pm: number;
  commandClass: CommandClass;
  timeoutMs: number;
  signal?: AbortSignal;
  /**
   * Resolve with the frame even when it has a negative head instead of
   * rejecting with CrtError. The magnetic-read command (CM 36h) answers with
   * head 'N' and the track buffer in its payload — that's its normal reply,
   * not an error, so those callers opt in here.
   */
  acceptNegative: boolean;
  resolve: (frame: ParsedFrame) => void;
  reject: (err: Error) => void;
}

interface ActiveSend extends SendJob {
  state: "awaitAck" | "awaitResponse";
  commandResends: number;
  responseNaks: number;
  startedAt: number;
  ackTimer: ReturnType<typeof setTimeout> | null;
  execTimer: ReturnType<typeof setTimeout> | null;
  quickTimer: ReturnType<typeof setTimeout> | null;
  abortCleanup: (() => void) | null;
}

interface LineClearWait {
  resolve: () => void;
  timer: ReturnType<typeof setTimeout> | null;
  resent: boolean;
}

const CM_NAMES: Record<number, string> = {
  [CM.INIT]: "INIT",
  [CM.STATUS]: "STATUS",
  [CM.MOVE]: "MOVE",
  [CM.ENTRY]: "ENTRY",
  [CM.CARD_TYPE]: "CARD_TYPE",
  [CM.CPU]: "CPU",
  [CM.SAM]: "SAM",
  [CM.SLE]: "SLE",
  [CM.I2C]: "I2C",
  [CM.RF]: "RF",
  [CM.SERIAL_NUMBER]: "SERIAL_NO",
  [CM.READ_CONFIG]: "CONFIG",
  [CM.READ_VERSION]: "VERSION",
  [CM.BIN_COUNTER]: "BIN_CTR",
  [CM.PCSC_RESET]: "PCSC_RESET",
};

function h(n: number): string {
  return n.toString(16).padStart(2, "0").toUpperCase();
}

export function describeCommand(cm: number, pm: number): string {
  const name = CM_NAMES[cm] ?? `CM ${h(cm)}`;
  return `${name} ${h(cm)}/${h(pm)}`;
}

function describeFrame(frame: ParsedFrame): string {
  const head = describeCommand(frame.cm, frame.pm);
  if (frame.kind === "positive") {
    const st = `st=${String.fromCharCode(frame.st.st0, frame.st.st1, frame.st.st2)}`;
    const data = frame.data.length ? ` data[${frame.data.length}]` : "";
    return `P ${head} ${st}${data}`;
  }
  const info = decodeError(frame.e1, frame.e0);
  return `N ${head} e=${info.code} ${info.message}`;
}

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

export class CrtProtocolEngine {
  private readonly transport: ByteTransport;
  private readonly addr: number;
  private readonly ackTimeoutMs: number;
  private readonly commandResendLimit: number;
  private readonly responseNakLimit: number;
  private readonly quickResendAfterAckMs: number;
  private readonly eotTimeoutMs: number;

  private readonly accumulator = new FrameAccumulator();
  private readonly queue: SendJob[] = [];
  private active: ActiveSend | null = null;
  private lineClearWait: LineClearWait | null = null;
  private disposed = false;
  private closedReason: string | null | undefined;

  private readonly logListeners = new Set<(e: EngineLogEvent) => void>();
  private readonly unsolicitedListeners = new Set<(f: ParsedFrame) => void>();
  private readonly unsubscribers: Array<() => void> = [];

  constructor(transport: ByteTransport, opts: EngineOptions = {}) {
    this.transport = transport;
    this.addr = opts.addr ?? DEFAULT_ADDR;
    this.ackTimeoutMs = opts.ackTimeoutMs ?? ACK_TIMEOUT_MS;
    this.commandResendLimit = opts.commandResendLimit ?? 3;
    this.responseNakLimit = opts.responseNakLimit ?? 2;
    this.quickResendAfterAckMs = opts.quickResendAfterAckMs ?? 200;
    this.eotTimeoutMs = opts.eotTimeoutMs ?? ACK_TIMEOUT_MS;

    this.unsubscribers.push(transport.onBytes((chunk) => this.onChunk(chunk)));
    this.unsubscribers.push(
      transport.onClose((reason) => {
        this.closedReason = reason;
        this.failAll(new CrtLinkError("portClosed", reason ?? undefined));
      }),
    );
  }

  onLog(cb: (e: EngineLogEvent) => void): () => void {
    this.logListeners.add(cb);
    return () => this.logListeners.delete(cb);
  }

  onUnsolicited(cb: (f: ParsedFrame) => void): () => void {
    this.unsolicitedListeners.add(cb);
    return () => this.unsolicitedListeners.delete(cb);
  }

  /** Rejects with CrtError on a negative response (the common case). */
  send(
    cmd: { cm: number; pm: number; data?: Uint8Array },
    opts: { commandClass: CommandClass; timeoutMs?: number; signal?: AbortSignal },
  ): Promise<PositiveFrame> {
    return this.enqueue(cmd, opts, false) as Promise<PositiveFrame>;
  }

  /**
   * Like send(), but resolves with the frame whether its head is positive or
   * negative — for commands (magnetic read) whose normal reply uses head 'N'.
   */
  sendRaw(
    cmd: { cm: number; pm: number; data?: Uint8Array },
    opts: { commandClass: CommandClass; timeoutMs?: number; signal?: AbortSignal },
  ): Promise<ParsedFrame> {
    return this.enqueue(cmd, opts, true);
  }

  private enqueue(
    cmd: { cm: number; pm: number; data?: Uint8Array },
    opts: { commandClass: CommandClass; timeoutMs?: number; signal?: AbortSignal },
    acceptNegative: boolean,
  ): Promise<ParsedFrame> {
    if (this.disposed || this.closedReason !== undefined) {
      return Promise.reject(new CrtLinkError("portClosed", this.closedReason ?? "engine disposed"));
    }
    return new Promise<ParsedFrame>((resolve, reject) => {
      const job: SendJob = {
        frameBytes: buildCommandFrame({ ...cmd, addr: this.addr }),
        cm: cmd.cm,
        pm: cmd.pm,
        commandClass: opts.commandClass,
        timeoutMs: opts.timeoutMs ?? EXEC_TIMEOUT_MS[opts.commandClass],
        signal: opts.signal,
        acceptNegative,
        resolve,
        reject,
      };
      this.queue.push(job);
      this.pump();
    });
  }

  /**
   * Clear the line (spec Cases 5–6): send EOT, wait for the device's EOT
   * (resend once on silence), then drop any partial RX state. Safe with no
   * command in flight — this is the first step of the connect handshake.
   */
  async lineClear(): Promise<void> {
    if (this.active) {
      await this.cancelActive();
      return;
    }
    await this.eotExchange();
  }

  /** Cancel the in-flight command (if any) via the EOT exchange. */
  async cancel(): Promise<void> {
    if (!this.active) return;
    await this.cancelActive();
  }

  dispose(): void {
    this.disposed = true;
    this.failAll(new CrtLinkError("portClosed", "engine disposed"));
    for (const unsub of this.unsubscribers) unsub();
    this.logListeners.clear();
    this.unsolicitedListeners.clear();
  }

  /* ---------------------------------------------------------------- */

  private log(
    dir: "tx" | "rx",
    bytes: Uint8Array,
    decoded: string,
    level: EngineLogEvent["level"] = "info",
  ) {
    const e: EngineLogEvent = { dir, t: now(), bytes, decoded, level };
    for (const cb of this.logListeners) cb(e);
  }

  private async tx(bytes: Uint8Array, decoded: string, level: EngineLogEvent["level"] = "info") {
    this.log("tx", bytes, decoded, level);
    try {
      await this.transport.write(bytes);
    } catch (err) {
      this.failAll(
        new CrtLinkError("portClosed", err instanceof Error ? err.message : String(err)),
      );
    }
  }

  private pump(): void {
    if (this.active || this.disposed || this.closedReason !== undefined) return;
    const job = this.queue.shift();
    if (!job) return;
    const active: ActiveSend = {
      ...job,
      state: "awaitAck",
      commandResends: 0,
      responseNaks: 0,
      startedAt: now(),
      ackTimer: null,
      execTimer: null,
      quickTimer: null,
      abortCleanup: null,
    };
    this.active = active;

    if (job.signal) {
      if (job.signal.aborted) {
        this.finish(active, undefined, new CrtCancelledError());
        return;
      }
      const onAbort = () => void this.cancelActive();
      job.signal.addEventListener("abort", onAbort, { once: true });
      active.abortCleanup = () => job.signal?.removeEventListener("abort", onAbort);
    }

    active.execTimer = setTimeout(() => void this.onExecTimeout(active), active.timeoutMs);
    void this.txCommand(active, "command");
  }

  private async txCommand(active: ActiveSend, label: "command" | "resend") {
    active.state = "awaitAck";
    this.clearTimer(active, "ackTimer");
    this.clearTimer(active, "quickTimer");
    await this.tx(
      active.frameBytes,
      `CMD ${describeCommand(active.cm, active.pm)}${label === "resend" ? " (resend)" : ""}`,
      label === "resend" ? "warn" : "info",
    );
    if (this.active !== active) return; // failed/cancelled during write
    active.ackTimer = setTimeout(() => this.onAckSilence(active), this.ackTimeoutMs);
  }

  private onAckSilence(active: ActiveSend) {
    if (this.active !== active || active.state !== "awaitAck") return;
    if (active.commandResends >= this.commandResendLimit) {
      this.finish(active, undefined, new CrtLinkError("ackTimeout"));
      return;
    }
    active.commandResends++;
    void this.txCommand(active, "resend");
  }

  private onExecTimeout(active: ActiveSend) {
    if (this.active !== active) return;
    const elapsed = Math.round(now() - active.startedAt);
    // Leave the line sane before surfacing the timeout (spec Case 5).
    void this.eotExchange().finally(() => {
      this.finish(active, undefined, new CrtTimeoutError(active.commandClass, elapsed));
    });
  }

  private onChunk(chunk: Uint8Array) {
    for (const event of this.accumulator.push(chunk)) this.onEvent(event);
  }

  private onEvent(event: FrameEvent) {
    switch (event.type) {
      case "ack":
        this.log("rx", Uint8Array.from([ACK]), "ACK");
        this.onAck();
        return;
      case "nak":
        this.log("rx", Uint8Array.from([NAK]), "NAK", "warn");
        this.onNak();
        return;
      case "eot":
        this.log("rx", Uint8Array.from([EOT]), "EOT", "warn");
        this.onEot();
        return;
      case "garbage":
        this.log("rx", event.bytes, `garbage (${event.bytes.length} bytes skipped)`, "warn");
        return;
      case "badFrame":
        this.log("rx", event.raw, `badFrame(${event.reason})`, "error");
        this.onBadFrame();
        return;
      case "frame":
        this.log(
          "rx",
          event.frame.raw,
          describeFrame(event.frame),
          event.frame.kind === "negative" ? "warn" : "info",
        );
        this.onFrame(event.frame);
        return;
    }
  }

  private onAck() {
    const active = this.active;
    if (!active || active.state !== "awaitAck") return; // spurious — ignore
    active.state = "awaitResponse";
    this.clearTimer(active, "ackTimer");
    if (active.commandClass === "quick") {
      // Spec Case 4 — quick commands may resend if the response goes missing.
      active.quickTimer = setTimeout(() => {
        if (this.active === active && active.state === "awaitResponse") {
          if (active.commandResends >= this.commandResendLimit) return; // exec timeout will handle it
          active.commandResends++;
          void this.txCommand(active, "resend");
        }
      }, this.quickResendAfterAckMs);
    }
  }

  private onNak() {
    const active = this.active;
    if (!active || active.state !== "awaitAck") return;
    if (active.commandResends >= this.commandResendLimit) {
      this.finish(active, undefined, new CrtLinkError("nakRetriesExhausted"));
      return;
    }
    active.commandResends++;
    void this.txCommand(active, "resend");
  }

  private onEot() {
    // Device answered our line clear…
    if (this.lineClearWait) {
      const wait = this.lineClearWait;
      this.lineClearWait = null;
      if (wait.timer) clearTimeout(wait.timer);
      this.accumulator.reset();
      wait.resolve();
      return;
    }
    // …or discontinued the in-flight command on its own.
    const active = this.active;
    if (active) this.finish(active, undefined, new CrtCancelledError());
  }

  private onBadFrame() {
    const active = this.active;
    if (!active || active.state !== "awaitResponse") return;
    if (active.responseNaks >= this.responseNakLimit) {
      this.finish(active, undefined, new CrtLinkError("badResponseRetriesExhausted"));
      return;
    }
    active.responseNaks++;
    void this.tx(Uint8Array.from([NAK]), "NAK (ask resend)", "warn");
  }

  private onFrame(frame: ParsedFrame) {
    const active = this.active;

    // A response crossing our EOT (spec Case 7): ACK it; if a command is
    // still in flight it actually finished — resolve it with this frame.
    if (this.lineClearWait) {
      const wait = this.lineClearWait;
      this.lineClearWait = null;
      if (wait.timer) clearTimeout(wait.timer);
      void this.tx(Uint8Array.from([ACK]), "ACK");
      this.accumulator.reset();
      wait.resolve();
      if (active && frame.addr === this.addr) {
        if (frame.kind === "positive" || active.acceptNegative) this.finish(active, frame);
        else this.finish(active, undefined, new CrtError(frame));
      }
      return;
    }

    if (!active || active.state !== "awaitResponse") {
      // Unsolicited but valid — ACK to complete the exchange, then surface it.
      void this.tx(Uint8Array.from([ACK]), "ACK");
      for (const cb of this.unsolicitedListeners) cb(frame);
      return;
    }

    if (frame.addr !== this.addr) {
      this.log(
        "rx",
        frame.raw,
        `ADDR mismatch (got ${h(frame.addr)}, expected ${h(this.addr)}) — check DIP switches`,
        "error",
      );
      this.onBadFrame();
      return;
    }

    this.clearTimer(active, "quickTimer");
    void this.tx(Uint8Array.from([ACK]), "ACK");
    if (frame.kind === "positive" || active.acceptNegative) this.finish(active, frame);
    else this.finish(active, undefined, new CrtError(frame));
  }

  private async cancelActive(): Promise<void> {
    const active = this.active;
    if (!active) return;
    await this.eotExchange();
    if (this.active === active) this.finish(active, undefined, new CrtCancelledError());
  }

  /** Send EOT, await the device's EOT (resend once on silence — spec Case 6). */
  private eotExchange(): Promise<void> {
    if (this.closedReason !== undefined || this.disposed) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const arm = (resent: boolean) => {
        this.lineClearWait = {
          resolve,
          resent,
          timer: setTimeout(() => {
            const wait = this.lineClearWait;
            if (!wait) return;
            this.lineClearWait = null;
            if (!wait.resent) {
              arm(true);
              void this.tx(Uint8Array.from([EOT]), "EOT (retry)", "warn");
            } else {
              // Device stayed silent — treat the line as cleared anyway.
              this.accumulator.reset();
              resolve();
            }
          }, this.eotTimeoutMs),
        };
      };
      // Arm BEFORE transmitting — a fast device echoes EOT synchronously
      // with the write, and an unarmed engine would misread it as the
      // device discontinuing an unrelated command.
      arm(false);
      void this.tx(Uint8Array.from([EOT]), "EOT (clear line)");
    });
  }

  private clearTimer(active: ActiveSend, key: "ackTimer" | "execTimer" | "quickTimer") {
    const t = active[key];
    if (t) {
      clearTimeout(t);
      active[key] = null;
    }
  }

  private finish(active: ActiveSend, frame?: ParsedFrame, err?: Error) {
    if (this.active !== active) return;
    this.active = null;
    this.clearTimer(active, "ackTimer");
    this.clearTimer(active, "execTimer");
    this.clearTimer(active, "quickTimer");
    active.abortCleanup?.();
    if (frame) active.resolve(frame);
    else active.reject(err ?? new CrtCancelledError());
    this.pump();
  }

  private failAll(err: Error) {
    const active = this.active;
    if (active) this.finish(active, undefined, err);
    while (this.queue.length) this.queue.shift()!.reject(err);
    if (this.lineClearWait) {
      const wait = this.lineClearWait;
      this.lineClearWait = null;
      if (wait.timer) clearTimeout(wait.timer);
      wait.resolve();
    }
  }
}
