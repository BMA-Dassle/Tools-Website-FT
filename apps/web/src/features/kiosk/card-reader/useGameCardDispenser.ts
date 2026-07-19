/**
 * Guest-facing Game Zone dispenser — the reusable orchestration layer over the
 * CRT-591 reader for buying new cards and reloading existing ones.
 *
 * Owns ONE reader connection for the whole session (the consuming component
 * must stay mounted for the session — useCardReader closes the port on unmount).
 * Every op goes through useCardReader's serialized runner so only one hardware
 * command is ever in flight.
 *
 * Faults are classified (recovery.ts): transient faults self-retry here
 * (invisible to the guest); everything else comes back as an `OpResult` fault
 * the caller acts on (hold / card-retry / abort). The reader holds ONE card at
 * a time, so buy and reload are strictly sequential — the caller must never
 * start the next card until the current one is taken or captured.
 */
import { useCallback } from "react";
import { useCardReader } from "./useCardReader";
import { classifyFault, type FaultBehavior } from "./recovery";
import type { CrtReaderClient } from "./client";
import type { CrtErrorInfo } from "./protocol/errors";
import type { CrtStatus } from "./protocol/status";
import type { CrtDeviceInfo } from "./client";
import type { KioskConfig } from "../config";

/** An op either succeeds with a value, or fails with a classified fault. */
export type OpResult<T> =
  | { ok: true; value: T }
  | { ok: false; fault: FaultBehavior; info: CrtErrorInfo };

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface UseGameCardDispenserOptions {
  /** Kiosk config — supplies the saved baud/port for silent auto-reconnect. */
  config: KioskConfig | null;
  onConnected?: (info: CrtDeviceInfo, portInfo: SerialPortInfo) => void;
}

export function useGameCardDispenser({ config, onConnected }: UseGameCardDispenserOptions) {
  const reader = useCardReader({
    preferredBaud: config?.cardReaderBaud ?? null,
    portInfo: config?.cardReaderPortInfo ?? null,
    // Kiosk is provisioned (cardReaderEnabled) → silently auto-reconnect on
    // mount, no picker in front of a guest.
    trustSingleGrant: !!config?.cardReaderEnabled,
    onConnected,
  });

  const { connection, status, busy, lastError, runResult, connect, disconnect, clearError } =
    reader;
  const ready = connection.state === "connected";
  const stacker = status?.stacker ?? "unknown";
  // Availability tri-state for gating the guest flow:
  //  ready → connected · reconnecting → transient (wait) · unavailable → give
  //  up, disable the feature (can't dispense → don't sell/offer).
  const reconnecting = connection.state === "connecting";
  const unavailable = reader.unavailable;

  /**
   * Run one hardware op with the transparent recovery policy: a `retry`-class
   * fault (comms hiccup, or needsInit) is retried here (with an INIT first when
   * the fault calls for it) up to its budget; anything else returns as an
   * OpResult fault for the caller to hold / card-retry / abort.
   */
  const attempt = useCallback(
    async <T>(label: string, fn: (c: CrtReaderClient) => Promise<T>): Promise<OpResult<T>> => {
      for (let tries = 0; ; tries++) {
        const r = await runResult(label, fn);
        if (r.ok) return { ok: true, value: r.value };
        const behavior = classifyFault(r.error);
        if (behavior.kind === "retry" && tries < behavior.maxTries) {
          if (behavior.reinit) await runResult("re-initializing", (c) => c.init("leaveCard"));
          await delay(400);
          continue;
        }
        return { ok: false, fault: behavior, info: r.error };
      }
    },
    [runResult],
  );

  /**
   * BUY: dispense a blank from the stacker to the read station and read its
   * (pre-encoded) account number. The card is held inside — load it, then
   * present() (or capture() on load failure). An empty stacker surfaces as the
   * device's A0 fault → a `hold` (not a pre-checked throw), so the flow can
   * pause for a refill.
   */
  const dispenseAndRead = useCallback(
    (): Promise<OpResult<string>> =>
      attempt("dispensing card", async (c) => {
        const mag = await c.issueAndReadCard();
        if (!mag.cardNumber) throw new Error("Couldn't read the dispensed card.");
        return mag.cardNumber;
      }),
    [attempt],
  );

  /**
   * RELOAD: permit a card in, wait for the guest to insert one, read its
   * account. The card is held inside — call present() to return it (always,
   * regardless of the load outcome).
   */
  const acceptAndRead = useCallback(
    (opts?: { timeoutMs?: number }): Promise<OpResult<string>> =>
      attempt("reading card", async (c) => {
        const mag = await c.acceptAndReadCard(opts);
        if (!mag.cardNumber) throw new Error("Couldn't read the card.");
        return mag.cardNumber;
      }),
    [attempt],
  );

  /** Hand the held card to the guest (MOVE 30h). */
  const present = useCallback(
    (): Promise<OpResult<void>> =>
      attempt("presenting card", (c) => c.presentCard().then(() => undefined)),
    [attempt],
  );

  /** Reject the held blank to the error bin — BUY only, when a load failed. */
  const capture = useCallback(
    (): Promise<OpResult<void>> =>
      attempt("capturing card", (c) => c.captureCard().then(() => undefined)),
    [attempt],
  );

  /** Stop accepting cards at the gate (after a reload session). Best-effort. */
  const stopAccepting = useCallback(
    (): Promise<OpResult<void>> =>
      attempt("closing gate", (c) => c.prohibitEntry().then(() => undefined)),
    [attempt],
  );

  /** Re-initialize the transport (device lost its card position). */
  const reinit = useCallback(
    (): Promise<OpResult<void>> =>
      attempt("re-initializing", (c) => c.init("leaveCard").then(() => undefined)),
    [attempt],
  );

  /** One-shot current status (for the hold screen to gate its Resume button). */
  const getStatusNow = useCallback(async (): Promise<CrtStatus | null> => {
    const r = await runResult("status", (c) => c.getStatus());
    return r.ok ? r.value.status : null;
  }, [runResult]);

  /**
   * Poll status until `pred` holds, or the window elapses / the signal aborts.
   * Returns true if the predicate was met.
   */
  const waitUntil = useCallback(
    async (
      pred: (s: CrtStatus) => boolean,
      opts?: { timeoutMs?: number; signal?: AbortSignal },
    ): Promise<boolean> => {
      const deadline = Date.now() + (opts?.timeoutMs ?? 120_000);
      for (;;) {
        if (opts?.signal?.aborted) return false;
        const r = await runResult("checking status", (c) => c.getStatus());
        if (r.ok && pred(r.value.status)) return true;
        if (Date.now() >= deadline) return false;
        await delay(700);
      }
    },
    [runResult],
  );

  /** Poll until the presented card is removed by the guest (or the window elapses). */
  const waitTaken = useCallback(
    (opts?: { timeoutMs?: number }) =>
      waitUntil((s) => s.card === "none", { timeoutMs: opts?.timeoutMs ?? 30_000 }),
    [waitUntil],
  );

  return {
    connection,
    ready,
    reconnecting,
    unavailable,
    status,
    stacker,
    busy,
    error: lastError,
    clearError,
    connect,
    disconnect,
    dispenseAndRead,
    acceptAndRead,
    present,
    capture,
    stopAccepting,
    reinit,
    getStatusNow,
    waitUntil,
    waitTaken,
  };
}

export type GameCardDispenser = ReturnType<typeof useGameCardDispenser>;
