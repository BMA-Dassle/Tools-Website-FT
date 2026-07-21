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
import type { CrtStatus, ErrorBinLevel } from "./protocol/status";
import type { CrtDeviceInfo } from "./client";
import { kioskDeviceKey, type KioskConfig } from "../config";

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
  // On EVERY successful connect (even one found the slow way by scanning), save
  // WHERE it was — port index + baud — to Neon via the non-gated reader-hint
  // endpoint, so the next boot connects INSTANTLY instead of re-scanning. This is
  // the guest flow, which has no admin auth, so it uses the hint endpoint.
  const handleConnected = useCallback(
    (info: CrtDeviceInfo, portInfo: SerialPortInfo, portIndex: number) => {
      if (config?.cardReaderEnabled) {
        void fetch("/api/kiosk/device", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            kioskId: kioskDeviceKey(config),
            ...(portIndex >= 0 ? { cardReaderPortIndex: portIndex } : {}),
            cardReaderBaud: info.baudRate,
            cardReaderPortInfo:
              portInfo.usbVendorId != null
                ? { usbVendorId: portInfo.usbVendorId, usbProductId: portInfo.usbProductId }
                : null,
          }),
        }).catch(() => {
          /* hint save is best-effort — never block the flow */
        });
      }
      onConnected?.(info, portInfo);
    },
    [config, onConnected],
  );

  const reader = useCardReader({
    preferredBaud: config?.cardReaderBaud ?? null,
    portInfo: config?.cardReaderPortInfo ?? null,
    // Saved "where I found it" index — the guest flow reuses the saved port
    // directly instead of re-scanning in front of a guest.
    portIndex: config?.cardReaderPortIndex ?? null,
    // Kiosk is provisioned (cardReaderEnabled) → silently auto-reconnect on
    // mount, no picker in front of a guest.
    trustSingleGrant: !!config?.cardReaderEnabled,
    onConnected: handleConnected,
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
   * Reject-bin state from the status block's st2 byte (0x30 empty → "ok",
   * 0x32 full → "full" on this HB-HDN unit; see BIN_BY_BYTE). "unknown" on a
   * read miss, which callers treat as unsafe-to-bin (fail toward NEVER binning
   * into a full bin). Retries a transient read fault via `attempt`.
   */
  const getBinState = useCallback(async (): Promise<ErrorBinLevel> => {
    const r = await attempt("bin state", (c) => c.getStatus());
    return r.ok ? r.value.status.errorBin : "unknown";
  }, [attempt]);

  /** One-shot current status (for the hold screen to gate its Resume button).
   *  errorBin comes straight from st2 (BIN_BY_BYTE now decodes the unit's full
   *  code 0x32), so the bin-full hold's resumeReady gate sees the true state. */
  const getStatusNow = useCallback(async (): Promise<CrtStatus | null> => {
    const r = await runResult("status", (c) => c.getStatus());
    return r.ok ? r.value.status : null;
  }, [runResult]);

  /**
   * BUY: dispense a blank from the stacker to the read station and read its
   * (pre-encoded) account number. The card is held inside — load it, then
   * present() (or capture() on load failure). An empty stacker surfaces as the
   * device's A0 fault → a `hold` (not a pre-checked throw), so the flow can
   * pause for a refill.
   */
  const dispenseAndRead = useCallback(async (): Promise<OpResult<string>> => {
    const r = await attempt("dispensing card", async (c) => {
      const mag = await c.issueAndReadCard();
      if (!mag.cardNumber) throw new Error("Couldn't read the dispensed card.");
      return mag.cardNumber;
    });
    if (r.ok || r.fault.kind === "hold") return r;
    // Safety net: a dispense that failed while the stacker sensor reads empty is
    // "out of cards" — no matter how the device coded the error. Surface the
    // resumable Out-of-cards hold instead of a dead-end abort. (Layer 1,
    // decodeError's byte-order tolerance, already turns the observed "0A" into
    // an A0 hold, so this only fires for an empty stacker the device reported
    // with some other/unknown code.)
    const s = await getStatusNow();
    if (s?.stacker === "empty") {
      const info: CrtErrorInfo = {
        code: "A0",
        message: "Card stacker is empty",
        category: "attention",
        hint: "Refill the stacker with blank cards.",
      };
      return { ok: false, fault: classifyFault(info), info };
    }
    return r;
  }, [attempt, getStatusNow]);

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

  /**
   * Reject the held blank to the error bin (MOVE 39h) — BUY only, on a bad or
   * unloaded card. HARD RULE (owner 2026-07-19): NEVER move a card into a FULL
   * bin. Read the sensor-derived bin state FIRST; anything but a confirmed "ok"
   * returns the bin-full HOLD (the caller pauses for staff, or recovers forward)
   * WITHOUT ever issuing the move. On staff resume the bin reads "ok" and the
   * capture goes through.
   */
  const capture = useCallback(async (): Promise<OpResult<void>> => {
    const bin = await getBinState();
    if (bin !== "ok") {
      const info: CrtErrorInfo = {
        code: "A1",
        message: "Error card bin is full",
        category: "attention",
        hint: "Empty the error bin, then reset the bin counter.",
      };
      return { ok: false, fault: classifyFault(info), info };
    }
    return attempt("capturing card", (c) => c.captureCard().then(() => undefined));
  }, [attempt, getBinState]);

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
    getBinState,
    waitUntil,
    waitTaken,
  };
}

export type GameCardDispenser = ReturnType<typeof useGameCardDispenser>;
