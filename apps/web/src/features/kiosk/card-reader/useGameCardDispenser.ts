/**
 * Guest-facing Game Zone dispenser — the reusable orchestration layer over the
 * CRT-591 reader for buying new cards and reloading existing ones.
 *
 * Owns ONE reader connection for the whole session (the consuming component
 * must stay mounted for the session — useCardReader closes the port on unmount).
 * Every op goes through useCardReader's serialized `run()` so only one hardware
 * command is ever in flight and errors surface uniformly as `error`.
 *
 * Physical constraint: the reader holds ONE card at a time, so buy and reload
 * are both strictly sequential — dispense/read/load/present one card, wait for
 * pickup, then the next. Callers must never start the next card until the
 * current one is taken or captured.
 */
import { useCallback } from "react";
import { useCardReader } from "./useCardReader";
import type { CrtDeviceInfo } from "./client";
import type { KioskConfig } from "../config";

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

  const { connection, status, busy, lastError, run, connect, disconnect, clearError } = reader;
  const ready = connection.state === "connected";
  const stacker = status?.stacker ?? "unknown";

  /**
   * BUY: dispense a blank from the stacker to the read station and read its
   * (pre-encoded) account number. Guards an empty stacker up front. The card is
   * held inside — load it, then present() (or capture() on load failure).
   * Returns the account number, or undefined if the op failed (see `error`).
   */
  const dispenseAndRead = useCallback(
    () =>
      run("dispensing card", async (c) => {
        const { status: st } = await c.getStatus();
        if (st.stacker === "empty") {
          throw new Error("The card stacker is empty — please see an attendant.");
        }
        const mag = await c.issueAndReadCard();
        if (!mag.cardNumber) throw new Error("Couldn't read the dispensed card. Please try again.");
        return mag.cardNumber;
      }),
    [run],
  );

  /**
   * RELOAD: permit a card in, wait for the guest to insert one, read its
   * account. The card is held inside — call present() to return it (always,
   * regardless of the load outcome). Returns the account number or undefined.
   */
  const acceptAndRead = useCallback(
    (opts?: { timeoutMs?: number }) =>
      run("reading card", async (c) => {
        const mag = await c.acceptAndReadCard(opts);
        if (!mag.cardNumber) throw new Error("Couldn't read the card. Please try again.");
        return mag.cardNumber;
      }),
    [run],
  );

  /** Hand the held card to the guest (MOVE 30h). */
  const present = useCallback(() => run("presenting card", (c) => c.presentCard()), [run]);

  /** Reject the held blank to the error bin — BUY only, when a load failed. */
  const capture = useCallback(() => run("capturing card", (c) => c.captureCard()), [run]);

  /** Stop accepting cards at the gate (after a reload session). */
  const stopAccepting = useCallback(() => run("closing gate", (c) => c.prohibitEntry()), [run]);

  /**
   * Poll until the presented card is removed by the guest (card === "none"), or
   * the window elapses. Returns true if taken, false if left (the unit will
   * auto-retract an uncollected card on its own timer).
   */
  const waitTaken = useCallback(
    (opts?: { timeoutMs?: number }) =>
      run("waiting for pickup", async (c) => {
        const deadline = Date.now() + (opts?.timeoutMs ?? 30_000);
        for (;;) {
          const { status: st } = await c.getStatus();
          if (st.card === "none") return true;
          if (Date.now() >= deadline) return false;
          await new Promise((r) => setTimeout(r, 700));
        }
      }),
    [run],
  );

  return {
    connection,
    ready,
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
    waitTaken,
  };
}

export type GameCardDispenser = ReturnType<typeof useGameCardDispenser>;
