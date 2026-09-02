"use client";

/**
 * Hardware QR scanner over Web Serial — the listen-only sibling of
 * card-reader/useSerialMsr.ts (same shape: open the port, listen, parse; no
 * command protocol, nothing to poll or write). Scans stream in unprompted as
 * `<payload>\r\n` lines (LineAccumulator frames them; the model registry in
 * models.ts carries per-model baud/framing).
 *
 * Provisioning mirrors the MSR/CRT-591: the admin grants the COM port once,
 * the port's USB ids + baud persist to KioskConfig (qrScannerPortInfo /
 * qrScannerBaud), and provisioned kiosks reconnect silently on boot. Silent
 * reopen is STRICTER than the other serial hooks — matchScannerPort never
 * takes a lone-grant guess unless the consumer opts in — because a kiosk can
 * have three serial devices granted and a stolen (exclusive) port blocks the
 * other device. See docs/qr-scanner/README.md.
 *
 * "What a scan means" is deliberately NOT here — consumers get the raw
 * payload via onScan / the scans feed.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { LineAccumulator } from "./line-accumulator";
import { DEFAULT_SCANNER_MODEL_ID, getScannerModel } from "./models";
import { matchScannerPort } from "./port-matching";

export interface QrScan {
  id: number;
  /** Date.now() at decode. */
  at: number;
  /** Trimmed, non-empty line — exactly one scan. */
  payload: string;
}

export interface QrScannerInfo {
  modelId: string;
  baudRate: number;
  /** From port.getInfo() — the panel's confirm-the-VID-off-the-unit surface. */
  usbVendorId?: number;
  usbProductId?: number;
}

export type QrScannerConnection =
  | { state: "unsupported" }
  | { state: "disconnected"; hadPortGrant: boolean }
  | { state: "connecting" }
  | { state: "listening"; info: QrScannerInfo }
  | { state: "error"; message: string };

export interface UseQrScannerOptions {
  /** Provisioned kiosk → silently (re)connect to the saved grant on mount. */
  enabled?: boolean;
  /** Registry id (models.ts); null/unknown falls back to the default model. */
  modelId?: string | null;
  /** Per-device baud override of the model default. Opening a serial port has
   *  no handshake, so "listening" ≠ "right baud" — the scan feed proves it. */
  baudRate?: number | null;
  /** USB ids of the granted port — the silent-reconnect matching key. */
  portInfo?: { usbVendorId?: number; usbProductId?: number } | null;
  /** Permit the "one granted port" guess when NO ids are saved. Leave false on
   *  kiosks (other serial devices share the grant list); a station with no
   *  other serial hardware may opt in. */
  allowLoneGrantFallback?: boolean;
  /** Fires per scan (held in a ref — inline closures are fine). */
  onScan?: (scan: QrScan) => void;
  /** First successful open — the admin persists the grant's ids/baud from this. */
  onConnected?: (info: QrScannerInfo, portInfo: SerialPortInfo) => void;
}

/** Scan-feed cap — the admin test surface shows the recent history. */
const SCAN_HISTORY_MAX = 100;
/** Backoff between silent reconnect attempts after the port drops. */
const RECONNECT_BACKOFFS = [1_000, 2_000, 4_000, 8_000] as const;
/** How long a close waits for the read loop to give the stream lock back
 *  before giving up on a graceful release (see `closePort`). */
const LOOP_DRAIN_TIMEOUT_MS = 1_500;
/** Slow retry while armed but not listening — outlasts another device's
 *  blind port probe (up to 12s per baud on the CRT-591 hunt). */
const IDLE_RETRY_MS = 20_000;

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function useQrScanner(opts: UseQrScannerOptions = {}) {
  const { enabled = false, portInfo = null, allowLoneGrantFallback = false } = opts;
  const model = getScannerModel(opts.modelId) ?? getScannerModel(DEFAULT_SCANNER_MODEL_ID)!;
  const effectiveBaud = opts.baudRate ?? model.defaultBaudRate;

  const [connection, setConnection] = useState<QrScannerConnection>({
    state: "disconnected",
    hadPortGrant: false,
  });
  const [scans, setScans] = useState<readonly QrScan[]>([]);
  const [lastScan, setLastScan] = useState<QrScan | null>(null);
  /** Total since connect — NOT capped like the feed. */
  const [scanCount, setScanCount] = useState(0);
  /** Raw bytes since connect. >0 with scanCount 0 ⇒ likely wrong baud. */
  const [rxBytes, setRxBytes] = useState(0);

  // Callbacks + line params live in refs so the long-running read loop and the
  // stable callbacks always see the latest without re-opening the port.
  const onScanRef = useRef(opts.onScan);
  useEffect(() => {
    onScanRef.current = opts.onScan;
  }, [opts.onScan]);
  const onConnectedRef = useRef(opts.onConnected);
  useEffect(() => {
    onConnectedRef.current = opts.onConnected;
  }, [opts.onConnected]);
  const enabledRef = useRef(enabled);
  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  const portRef = useRef<SerialPort | null>(null);
  const readerRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);
  const closingRef = useRef(false);
  /** The live read loop. `closePort` MUST await it — see the comment there. */
  const loopRef = useRef<Promise<void> | null>(null);
  // Each successful open gets a session id; a stale read-loop completion (from
  // a port we already closed to re-open at a new baud) must not tear down or
  // "reconnect" over the live session.
  const sessionSeq = useRef(0);
  const scanSeq = useRef(0);
  const attemptReconnectRef = useRef<() => void>(() => {});

  const emit = useCallback((payload: string) => {
    const scan: QrScan = { id: ++scanSeq.current, at: Date.now(), payload };
    setScans((prev) =>
      prev.length >= SCAN_HISTORY_MAX
        ? [...prev.slice(1 - SCAN_HISTORY_MAX), scan]
        : [...prev, scan],
    );
    setLastScan(scan);
    setScanCount((n) => n + 1);
    onScanRef.current?.(scan);
  }, []);

  const clearScans = useCallback(() => {
    setScans([]);
    setLastScan(null);
    setScanCount(0);
    setRxBytes(0);
  }, []);

  /** Listen until cancel/unplug. Resolves when the stream ends. */
  const readLoop = useCallback(
    async (port: SerialPort) => {
      const acc = new LineAccumulator(model.framing);
      try {
        while (port.readable && !closingRef.current) {
          const reader = port.readable.getReader();
          readerRef.current = reader;
          try {
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              if (value?.length) {
                setRxBytes((n) => n + value.length);
                for (const payload of acc.push(value)) emit(payload);
              }
            }
          } finally {
            readerRef.current = null;
            reader.releaseLock();
          }
        }
      } finally {
        acc.reset();
      }
    },
    [model.framing, emit],
  );

  /**
   * Release the port for real.
   *
   * `port.close()` REJECTS with InvalidStateError while `port.readable` is
   * still locked, and `reader.cancel()` does NOT release that lock — it only
   * makes the pending `read()` resolve `{ done: true }`. The lock goes back in
   * the read loop's `finally` (`releaseLock()`), a LATER microtask, so a
   * close that only awaits `cancel()` always resumes with the stream still
   * locked, always rejects, and — because the rejection was swallowed and
   * `portRef` nulled anyway — leaves the COM port OPEN for the life of the
   * page while this hook believes it is closed.
   *
   * That is not theoretical: it is why scanning inside Game Zone did nothing
   * (2026-09-02). The entry-screen listener unmounted, "closed" its port, and
   * every later surface's `port.open()` hit InvalidStateError on a port
   * nobody could reach any more. So: cancel, AWAIT THE LOOP (that is what
   * unlocks the stream), then close.
   *
   * The loop is raced against a short timeout so a wedged reader can never
   * make an unmount hang — a close we could not finish is still reported, and
   * `openPort`'s InvalidStateError recovery takes the port back on the way in.
   */
  const closePort = useCallback(async () => {
    closingRef.current = true;
    try {
      await readerRef.current?.cancel();
    } catch {
      /* already gone */
    }
    const loop = loopRef.current;
    loopRef.current = null;
    if (loop) {
      await Promise.race([
        loop.catch(() => undefined),
        new Promise<void>((r) => setTimeout(r, LOOP_DRAIN_TIMEOUT_MS)),
      ]);
    }
    const port = portRef.current;
    portRef.current = null;
    try {
      await port?.close();
    } catch {
      /* already gone, or still locked — openPort recovers it */
    }
  }, []);

  /** Open + listen. Returns true once listening. */
  const openPort = useCallback(
    async (port: SerialPort, o: { silent?: boolean } = {}): Promise<boolean> => {
      if (portRef.current) return true;
      closingRef.current = false;
      setConnection({ state: "connecting" });
      const line = {
        baudRate: effectiveBaud,
        dataBits: model.lineSettings?.dataBits ?? 8,
        parity: model.lineSettings?.parity ?? "none",
        stopBits: model.lineSettings?.stopBits ?? 1,
      } as const;
      try {
        try {
          await port.open(line);
        } catch (first) {
          // "Already open" is the ONE open failure we can fix ourselves: an
          // earlier listener on this page (the entry screen, another surface)
          // holds this grant open because its own close could not release the
          // stream lock. The grant is ours and no other surface can reach that
          // handle any more, so take it back — close it properly, then open
          // once more. Any other failure is a real one and falls through.
          if (!(first instanceof DOMException) || first.name !== "InvalidStateError") throw first;
          try {
            await port.close();
          } catch {
            /* nothing to reclaim — the rethrow below reports the real state */
          }
          await port.open(line);
        }
      } catch (err) {
        if (o.silent) {
          setConnection({ state: "disconnected", hadPortGrant: true });
        } else {
          const name = err instanceof DOMException ? err.name : "";
          setConnection({
            state: "error",
            message:
              name === "InvalidStateError" || name === "NetworkError"
                ? "Scanner port is in use by another tab or program — close it and retry."
                : err instanceof Error
                  ? err.message
                  : String(err),
          });
        }
        return false;
      }
      portRef.current = port;
      const session = ++sessionSeq.current;
      const raw = port.getInfo();
      const info: QrScannerInfo = {
        modelId: model.id,
        baudRate: effectiveBaud,
        usbVendorId: raw.usbVendorId,
        usbProductId: raw.usbProductId,
      };
      setConnection({ state: "listening", info });
      onConnectedRef.current?.(info, raw);
      const loop = readLoop(port).catch(() => undefined);
      loopRef.current = loop;
      void loop.then(async () => {
        // Stream ended: deliberate close (incl. a baud-change reopen), or the
        // scanner was unplugged. A stale session must not touch the new one.
        if (sessionSeq.current !== session) return;
        const deliberate = closingRef.current;
        await closePort();
        if (deliberate) return;
        if (enabledRef.current) {
          setConnection({ state: "connecting" });
          attemptReconnectRef.current();
        } else {
          setConnection({
            state: "error",
            message: "Scanner disconnected — check the USB lead, then reconnect.",
          });
        }
      });
      return true;
    },
    [effectiveBaud, model, readLoop, closePort],
  );

  /** Reopen a remembered grant with NO picker — strict saved-ids matching
   *  (matchScannerPort); lone-grant only when the consumer opted in. */
  const reopenSilently = useCallback(async (): Promise<"connected" | "no-grant" | "failed"> => {
    if (typeof navigator === "undefined" || !("serial" in navigator)) return "failed";
    if (portRef.current) return "connected";
    const granted = await navigator.serial.getPorts().catch(() => [] as SerialPort[]);
    if (granted.length === 0) return "no-grant";
    const match = matchScannerPort(granted, portInfo, allowLoneGrantFallback);
    if (!match) return "failed";
    return (await openPort(match, { silent: true })) ? "connected" : "failed";
  }, [portInfo, allowLoneGrantFallback, openPort]);

  const attemptReconnect = useCallback(async () => {
    for (const backoff of RECONNECT_BACKOFFS) {
      if (portRef.current || closingRef.current) return;
      const r = await reopenSilently();
      if (r === "connected") return;
      if (r === "no-grant") {
        // Never granted (fresh kiosk) — not a fault, just not set up yet.
        setConnection({ state: "disconnected", hadPortGrant: false });
        return;
      }
      await delay(backoff);
    }
    if (!portRef.current) {
      setConnection({
        state: "error",
        message: "The QR scanner is offline and couldn't reconnect.",
      });
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
    setConnection({ state: "disconnected", hadPortGrant });
  }, [closePort]);

  /**
   * Drop the browser grant for the saved (or currently open) port so a stale
   * grant can't confuse any device's reconnect logic. forget() is
   * feature-detected — older Chromium builds simply skip it.
   */
  const forgetSavedPort = useCallback(async () => {
    const current = portRef.current;
    await closePort();
    if (typeof navigator !== "undefined" && "serial" in navigator) {
      const granted = await navigator.serial.getPorts().catch(() => [] as SerialPort[]);
      const target = current ?? matchScannerPort(granted, portInfo, false);
      const forgettable = target as (SerialPort & { forget?: () => Promise<void> }) | null;
      if (forgettable?.forget) await forgettable.forget().catch(() => undefined);
    }
    const remaining =
      typeof navigator !== "undefined" && "serial" in navigator
        ? (await navigator.serial.getPorts().catch(() => [])).length
        : 0;
    setConnection({ state: "disconnected", hadPortGrant: remaining > 0 });
  }, [closePort, portInfo]);

  // A baud (or model) change while listening re-opens the SAME port at the new
  // rate — no picker, no re-grant. Deliberate close first; the stale session
  // check keeps the old read loop's completion from touching the new session.
  const lineKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const key = `${model.id}:${effectiveBaud}`;
    const prev = lineKeyRef.current;
    lineKeyRef.current = key;
    if (prev === null || prev === key) return;
    const port = portRef.current;
    if (!port) return;
    void (async () => {
      await closePort();
      await openPort(port);
    })();
  }, [model.id, effectiveBaud, closePort, openPort]);

  // Feature-detect + provisioned auto-connect; close on unmount.
  //
  // Retried on EVERY enable, not once per mount. A consumer that arms the
  // reader only on certain screens (Game Zone: off on its menu, on for the
  // card surfaces) flips `enabled` mid-life, and a single terminal attempt
  // meant one unlucky first try — a port a previous surface had not finished
  // releasing — left the scanner dead for the rest of the visit with nothing
  // able to try again. `attemptingRef` guards overlapping runs; it is NOT a
  // once-ever latch. An open port short-circuits, so this never re-grabs a
  // reader that is already listening.
  const attemptingRef = useRef(false);
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serial" in navigator)) {
      setConnection({ state: "unsupported" });
      return;
    }
    if (!enabled || portRef.current || attemptingRef.current) return;
    attemptingRef.current = true;
    void attemptReconnect().finally(() => {
      attemptingRef.current = false;
    });
  }, [enabled, attemptReconnect]);

  // Keep trying, slowly, while armed but not listening. The backoff ladder
  // above spans ~15s and another device on this kiosk can hold a port for
  // longer than that — the CRT-591 hunt blind-probes each granted port for up
  // to 12s per baud. Whoever loses that race must be able to come back rather
  // than stay dark for the rest of the guest's visit.
  useEffect(() => {
    if (!enabled || typeof navigator === "undefined" || !("serial" in navigator)) return;
    const id = setInterval(() => {
      if (portRef.current || attemptingRef.current) return;
      attemptingRef.current = true;
      void attemptReconnect().finally(() => {
        attemptingRef.current = false;
      });
    }, IDLE_RETRY_MS);
    return () => clearInterval(id);
  }, [enabled, attemptReconnect]);
  useEffect(() => {
    return () => {
      void closePort();
    };
  }, [closePort]);

  return {
    connection,
    /** Resolved registry model (saved id may have fallen back to the default). */
    model,
    scans,
    lastScan,
    scanCount,
    rxBytes,
    clearScans,
    connectPort,
    disconnect,
    forgetSavedPort,
  };
}

export type QrScanner = ReturnType<typeof useQrScanner>;
