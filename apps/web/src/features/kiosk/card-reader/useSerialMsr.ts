"use client";

/**
 * Serial-COM swipe MSR — Game Zone cards (reload kiosks) and, in
 * mode "square-gift", physical Square gift cards for the split-tender flow.
 *
 * NOT the CRT-591: the MSR is a dumb swipe reader on its own COM port that
 * streams one ISO track-2 burst per swipe. There is no command protocol and
 * nothing to poll: we open the port, listen, and parse bursts with the
 * mode's parser — "intercard" (default) wants `;6283=<account>?` bursts
 * (parseIntercardSwipe); "square-gift" wants a gift-card GAN candidate
 * (parseSquareGiftSwipe, bank cards hard-discarded first). Raw bursts never
 * leave this hook, and an unwanted burst is discarded unretained and
 * unlogged — PCI house rule: payment tracks are never parsed or retained.
 *
 * Provisioning mirrors the CRT-591: the admin grants the COM port once
 * (chooser = the grant), the port's USB ids + baud persist to KioskConfig
 * (msrPortInfo/msrBaud), and provisioned kiosks reconnect silently on boot —
 * no picker in front of a guest.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { parseIntercardSwipe, parseSquareGiftSwipe } from "./wedge";

export type SerialMsrConnection =
  | { state: "unsupported" }
  | { state: "disconnected"; hadPortGrant: boolean }
  | { state: "connecting" }
  | { state: "listening" }
  | { state: "error"; message: string };

/** Why a "square-gift" burst was rejected — coarse by design, never the data. */
export type MsrBadSwipeReason = "not-gift-card" | "unreadable";

export interface UseSerialMsrOptions {
  /** Provisioned kiosk → silently (re)connect to the saved grant on mount. */
  enabled?: boolean;
  /** USB vendor/product of the granted adapter — reconnect matching. */
  portInfo?: { usbVendorId?: number; usbProductId?: number } | null;
  /** Line speed; serial swipe MSRs are conventionally 9600 8N1. */
  baud?: number | null;
  /**
   * What this MSR feeds — "intercard" (default; Game Zone reload, existing
   * callers unchanged) or "square-gift" (gift-card GAN capture for split
   * tender).
   */
  mode?: "intercard" | "square-gift";
  /** A valid swipe for the mode: Intercard account number (leading zeros
   *  kept), or a Square gift-card GAN candidate (server lookup validates). */
  onSwipe?: (cardNumber: string) => void;
  /** A burst arrived that the mode doesn't want (bad swipe / wrong card).
   *  "intercard" mode keeps its legacy no-arg call; "square-gift" mode says
   *  "not-gift-card" for a Game Zone swipe, "unreadable" for the rest. */
  onBadSwipe?: (reason?: MsrBadSwipeReason) => void;
  /** First successful open — the admin persists the grant's ids from this. */
  onConnected?: (portInfo: SerialPortInfo, baudRate: number) => void;
}

export const MSR_DEFAULT_BAUD = 9600;

/** A swipe arrives as a few chunks within milliseconds — this much silence ends the burst. */
const BURST_IDLE_MS = 150;
/** Runaway guard: no legitimate swipe is anywhere near this long. */
const BURST_MAX_CHARS = 512;
/** Backoff between silent reconnect attempts after the port drops. */
const RECONNECT_BACKOFFS = [1_000, 2_000, 4_000, 8_000] as const;

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function useSerialMsr(opts: UseSerialMsrOptions = {}) {
  const { enabled = false, portInfo = null, baud = null, mode = "intercard" } = opts;

  const [connection, setConnection] = useState<SerialMsrConnection>({
    state: "disconnected",
    hadPortGrant: false,
  });
  /** Last parsed account/GAN candidate — admin test surface only. */
  const [lastSwipe, setLastSwipe] = useState<string | null>(null);

  // Callbacks live in refs so the long-running read loop always sees the
  // latest without re-opening the port.
  const cbRef = useRef({ onSwipe: opts.onSwipe, onBadSwipe: opts.onBadSwipe });
  useEffect(() => {
    cbRef.current = { onSwipe: opts.onSwipe, onBadSwipe: opts.onBadSwipe };
  }, [opts.onSwipe, opts.onBadSwipe]);
  // Same ref treatment for mode: a mid-session change must steer the NEXT
  // burst without re-opening the port.
  const modeRef = useRef(mode);
  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);
  const onConnectedRef = useRef(opts.onConnected);
  useEffect(() => {
    onConnectedRef.current = opts.onConnected;
  }, [opts.onConnected]);

  const portRef = useRef<SerialPort | null>(null);
  const readerRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);
  const closingRef = useRef(false);
  const enabledRef = useRef(enabled);
  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);
  const attemptReconnectRef = useRef<() => void>(() => {});

  // Raw bursts never leave this function — only a parsed account/GAN does,
  // and a rejected burst is dropped unretained and unlogged.
  const flushBurst = useCallback((buffer: string) => {
    if (modeRef.current === "square-gift") {
      const swipe = parseSquareGiftSwipe(buffer);
      if (swipe?.kind === "candidate") {
        setLastSwipe(swipe.gan);
        cbRef.current.onSwipe?.(swipe.gan);
      } else if (swipe?.kind === "gamezone") {
        cbRef.current.onBadSwipe?.("not-gift-card");
      } else if (buffer.trim()) {
        cbRef.current.onBadSwipe?.("unreadable");
      }
      return;
    }
    const account = parseIntercardSwipe(buffer);
    if (account) {
      setLastSwipe(account);
      cbRef.current.onSwipe?.(account);
    } else if (buffer.trim()) {
      cbRef.current.onBadSwipe?.();
    }
  }, []);

  /** Listen until cancel/unplug. Resolves when the stream ends. */
  const readLoop = useCallback(
    async (port: SerialPort) => {
      const decoder = new TextDecoder();
      let buffer = "";
      let idleTimer: ReturnType<typeof setTimeout> | null = null;
      const flush = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = null;
        const b = buffer;
        buffer = "";
        // A queued idle-flush can fire in the window between unmount/close and
        // the reader-cancel settling — never deliver a burst to a consumer
        // that is going away (review 2026-07-29).
        if (!closingRef.current) flushBurst(b);
      };
      try {
        while (port.readable && !closingRef.current) {
          const reader = port.readable.getReader();
          readerRef.current = reader;
          try {
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              if (value?.length) {
                buffer += decoder.decode(value, { stream: true });
                // A `?` end sentinel closes the burst immediately; otherwise a
                // short silence does (some readers strip the sentinel).
                if (buffer.includes("?") || buffer.length > BURST_MAX_CHARS) flush();
                else {
                  if (idleTimer) clearTimeout(idleTimer);
                  idleTimer = setTimeout(flush, BURST_IDLE_MS);
                }
              }
            }
          } finally {
            readerRef.current = null;
            reader.releaseLock();
          }
        }
      } finally {
        if (idleTimer) clearTimeout(idleTimer);
      }
    },
    [flushBurst],
  );

  // The close in flight, if any — a re-enable awaits it before reopening (a
  // second open on a port still closing would fail and burn the backoff ladder).
  const closePromiseRef = useRef<Promise<void> | null>(null);
  const closePort = useCallback(async () => {
    closingRef.current = true;
    // Detach SYNCHRONOUSLY so nothing else (a late reconnect, a second close)
    // can touch this port through the refs while it is being torn down.
    const port = portRef.current;
    const reader = readerRef.current;
    portRef.current = null;
    readerRef.current = null;
    if (!port && !reader) return;
    const closing = (async () => {
      try {
        await reader?.cancel();
      } catch {
        /* already gone */
      }
      try {
        await port?.close();
      } catch {
        /* already gone */
      }
    })();
    closePromiseRef.current = closing;
    await closing;
    if (closePromiseRef.current === closing) closePromiseRef.current = null;
  }, []);

  /** Open + listen. Returns true once listening. */
  const openPort = useCallback(
    async (port: SerialPort, o: { silent?: boolean } = {}): Promise<boolean> => {
      if (portRef.current) return true;
      closingRef.current = false;
      setConnection({ state: "connecting" });
      try {
        await port.open({ baudRate: baud ?? MSR_DEFAULT_BAUD });
      } catch (err) {
        if (o.silent) {
          setConnection({ state: "disconnected", hadPortGrant: true });
        } else {
          const name = err instanceof DOMException ? err.name : "";
          setConnection({
            state: "error",
            message:
              name === "InvalidStateError" || name === "NetworkError"
                ? "MSR port is in use by another tab or program — close it and retry."
                : err instanceof Error
                  ? err.message
                  : String(err),
          });
        }
        return false;
      }
      // A disable landed while open() was pending — this port is not wanted.
      // Close it now rather than reporting "listening" on a port the stream-
      // ended handler would immediately tear down again.
      if (closingRef.current) {
        try {
          await port.close();
        } catch {
          /* already gone */
        }
        setConnection({ state: "disconnected", hadPortGrant: true });
        return false;
      }
      portRef.current = port;
      setConnection({ state: "listening" });
      onConnectedRef.current?.(port.getInfo(), baud ?? MSR_DEFAULT_BAUD);
      void readLoop(port)
        .catch(() => undefined)
        .then(async () => {
          // Stream ended: deliberate close, or the reader was unplugged.
          const deliberate = closingRef.current;
          await closePort();
          if (deliberate) return;
          if (enabledRef.current) {
            // closePort raised closingRef to stop loops; an unplug is not a
            // deliberate close, so lower it or the reconnect bails at once.
            closingRef.current = false;
            setConnection({ state: "connecting" });
            attemptReconnectRef.current();
          } else {
            setConnection({
              state: "error",
              message: "MSR disconnected — check the cable, then reconnect.",
            });
          }
        });
      return true;
    },
    [baud, readLoop, closePort],
  );

  /** Reopen a remembered grant with NO picker — saved USB ids, or a lone grant
   *  (a NATIVE COM port has no USB ids, so the lone-grant path is its normal
   *  reconnect; never guesses among many). */
  const reopenSilently = useCallback(async (): Promise<"connected" | "no-grant" | "failed"> => {
    if (typeof navigator === "undefined" || !("serial" in navigator)) return "failed";
    if (portRef.current) return "connected";
    const granted = await navigator.serial.getPorts().catch(() => [] as SerialPort[]);
    if (granted.length === 0) return "no-grant";
    let match: SerialPort | null = null;
    if (portInfo?.usbVendorId != null) {
      match =
        granted.find((p) => {
          const info = p.getInfo();
          return (
            info.usbVendorId === portInfo.usbVendorId &&
            (portInfo.usbProductId == null || info.usbProductId === portInfo.usbProductId)
          );
        }) ?? null;
    }
    if (!match && granted.length === 1) match = granted[0];
    if (!match) return "failed";
    return (await openPort(match, { silent: true })) ? "connected" : "failed";
  }, [portInfo, openPort]);

  // One reconnect loop at a time — the `enabled` effect below and the
  // stream-ended handler can both ask for one.
  const reconnectingRef = useRef(false);
  const attemptReconnect = useCallback(async () => {
    if (reconnectingRef.current) return;
    reconnectingRef.current = true;
    try {
      for (const backoff of RECONNECT_BACKOFFS) {
        if (portRef.current || closingRef.current) return;
        const r = await reopenSilently();
        if (r === "connected") return;
        if (r === "no-grant") {
          // Never granted (fresh kiosk) — that's not a fault, just not set up yet.
          setConnection({ state: "disconnected", hadPortGrant: false });
          return;
        }
        await delay(backoff);
      }
      if (!portRef.current && !closingRef.current) {
        setConnection({
          state: "error",
          message: "The card swipe reader is offline and couldn't reconnect.",
        });
      }
    } finally {
      reconnectingRef.current = false;
    }
  }, [reopenSilently]);
  useEffect(() => {
    attemptReconnectRef.current = () => void attemptReconnect();
  }, [attemptReconnect]);

  /** Admin grant flow: the caller ran requestPort() (gesture rules) and hands the port here. */
  const connectPort = useCallback(
    (port: SerialPort): Promise<boolean> => openPort(port),
    [openPort],
  );

  const disconnect = useCallback(async () => {
    await closePort();
    const hadPortGrant =
      typeof navigator !== "undefined" && "serial" in navigator
        ? (await navigator.serial.getPorts().catch(() => [])).length > 0
        : false;
    // A re-enable may have reopened (or be reopening) the port while we awaited
    // — never stamp "disconnected" over a live or in-progress connection.
    if (portRef.current || reconnectingRef.current) return;
    setConnection({ state: "disconnected", hadPortGrant });
  }, [closePort]);

  // Feature-detect, then follow `enabled` LIVE: true → provisioned auto-connect
  // (silent grant reuse); false → let the port GO. The MSR is one COM port that
  // several consumers want at different moments — Game Zone buy/reload/balance,
  // the pay screen's gift-card capture (msrUse "both"), the admin test surface
  // — and only one can hold it open. A consumer that is done listening must
  // release it, not merely ignore bursts. (Until 2026-08-28 the auto-connect
  // was mount-only and a disabled hook kept the port, which starved the
  // gift-card flow on the pay screen after a Game Zone sale.)
  // `disconnect` also flips closingRef, which stops an in-flight reconnect loop
  // and makes a port that finishes opening late close itself (openPort checks
  // it after open() resolves).
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serial" in navigator)) {
      setConnection({ state: "unsupported" });
      return;
    }
    if (enabled) {
      void (async () => {
        // A disable may still be closing the port (Pay → Back within a few
        // hundred ms): let it finish, or the reopen would fail against a port
        // that is half-closed and the backoff ladder would eat seconds.
        await closePromiseRef.current;
        if (!enabledRef.current || portRef.current) return; // flipped back / already open
        // A prior disable left closingRef raised to stop loops; lower it or
        // attemptReconnect bails on its first check.
        closingRef.current = false;
        void attemptReconnect();
      })();
      return;
    }
    // Nothing held and no loop running → nothing to release (mount-while-
    // disabled is the common case: a dispenser kiosk, a reload payload).
    if (portRef.current || reconnectingRef.current) void disconnect();
  }, [enabled, attemptReconnect, disconnect]);
  useEffect(() => {
    return () => {
      void closePort();
    };
  }, [closePort]);

  return { connection, lastSwipe, connectPort, disconnect };
}

export type SerialMsr = ReturnType<typeof useSerialMsr>;
