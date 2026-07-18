/**
 * React surface for the CRT-591 driver — connection state machine, live
 * status, TX/RX log, and a `run()` wrapper that owns busy/error bookkeeping
 * for the admin test panel (its only consumer; no global singleton).
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { CrtReaderClient, type CrtDeviceInfo } from "./client";
import {
  CrtCancelledError,
  CrtCardSwError,
  CrtError,
  CrtLinkError,
  CrtTimeoutError,
  type CrtErrorInfo,
} from "./protocol/errors";
import type { CrtStatus, SensorStatus } from "./protocol/status";
import { LogRing, type LogEntry } from "./log";
import { openSerialTransport } from "./transport/serial-transport";

export type CardReaderConnection =
  | { state: "unsupported" }
  | { state: "disconnected"; hadPortGrant: boolean }
  | { state: "connecting"; detail: string }
  | { state: "connected"; info: CrtDeviceInfo }
  | { state: "error"; message: string; canRetry: boolean };

export interface UseCardReaderOptions {
  preferredBaud?: number | null;
  portInfo?: { usbVendorId?: number; usbProductId?: number } | null;
  /**
   * Reuse a single remembered grant without showing the picker. Only pass
   * true once a connect has SUCCEEDED on this kiosk (e.g. config says the
   * reader is set up) — before that, silently reusing a grant hides the
   * picker from staff who granted the wrong COM port on the first try.
   */
  trustSingleGrant?: boolean;
  onConnected?: (info: CrtDeviceInfo, portInfo: SerialPortInfo) => void;
}

const EMPTY_LOG: readonly LogEntry[] = [];
const POLL_MS = 1_200;

function toErrorInfo(err: unknown): CrtErrorInfo {
  if (err instanceof CrtError) return err.info;
  if (err instanceof CrtCardSwError) {
    return { code: err.sw, message: err.message, category: "cardError" };
  }
  if (err instanceof CrtTimeoutError) {
    return {
      code: "T/O",
      message: err.message,
      category: "retryable",
      hint: "The line was cleared (EOT). Check the device, then retry.",
    };
  }
  if (err instanceof CrtLinkError) {
    return {
      code: "LNK",
      message: err.message,
      category: err.failure === "portClosed" ? "fatal" : "retryable",
    };
  }
  if (err instanceof CrtCancelledError) {
    return { code: "CAN", message: err.message, category: "retryable" };
  }
  return {
    code: "ERR",
    message: err instanceof Error ? err.message : String(err),
    category: "fatal",
  };
}

function openErrorMessage(err: unknown): string {
  const name = err instanceof DOMException ? err.name : "";
  if (name === "InvalidStateError" || name === "NetworkError") {
    return "Reader port is in use by another tab or program — close it and retry.";
  }
  if (name === "SecurityError") {
    return "The browser blocked serial access — check the page's permissions.";
  }
  return err instanceof Error ? err.message : String(err);
}

export function useCardReader(opts: UseCardReaderOptions = {}) {
  const { preferredBaud = null, portInfo = null, trustSingleGrant = false, onConnected } = opts;

  const [ring] = useState(() => new LogRing(300));

  const log = useSyncExternalStore(
    useCallback((cb: () => void) => ring.subscribe(cb), [ring]),
    () => ring.snapshot(),
    () => EMPTY_LOG,
  );

  const [connection, setConnection] = useState<CardReaderConnection>({
    state: "disconnected",
    hadPortGrant: false,
  });
  const [client, setClient] = useState<CrtReaderClient | null>(null);
  const [status, setStatus] = useState<CrtStatus | null>(null);
  const [sensors, setSensors] = useState<SensorStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [lastError, setLastError] = useState<CrtErrorInfo | null>(null);
  const [polling, setPolling] = useState(false);

  const clientRef = useRef<CrtReaderClient | null>(null);
  const busyRef = useRef<string | null>(null);
  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  const onConnectedRef = useRef(onConnected);
  useEffect(() => {
    onConnectedRef.current = onConnected;
  }, [onConnected]);

  // Feature-detect + report whether a previous grant exists (no prompting).
  // Deferred past the synchronous effect body (react-hooks/set-state-in-effect);
  // detection also can't run during SSR/hydration anyway.
  useEffect(() => {
    let alive = true;
    void (async () => {
      await Promise.resolve();
      if (!alive) return;
      if (typeof navigator === "undefined" || !("serial" in navigator)) {
        setConnection({ state: "unsupported" });
        return;
      }
      const ports = await navigator.serial.getPorts().catch(() => [] as SerialPort[]);
      if (!alive) return;
      setConnection((prev) =>
        prev.state === "disconnected"
          ? { state: "disconnected", hadPortGrant: ports.length > 0 }
          : prev,
      );
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Close the port when the panel unmounts.
  useEffect(() => {
    return () => {
      void clientRef.current?.close();
      clientRef.current = null;
    };
  }, []);

  const disconnect = useCallback(async () => {
    const c = clientRef.current;
    clientRef.current = null;
    setClient(null);
    setPolling(false);
    setStatus(null);
    setSensors(null);
    setBusy(null);
    if (c) await c.close().catch(() => undefined);
    const hadPortGrant =
      typeof navigator !== "undefined" && "serial" in navigator
        ? (await navigator.serial.getPorts().catch(() => [])).length > 0
        : false;
    setConnection({ state: "disconnected", hadPortGrant });
  }, []);

  // The open + auto-baud + discovery half — safe to await freely (no user
  // gesture needed once we hold a port).
  const beginConnect = useCallback(
    async (chosen: SerialPort, o: { silent?: boolean } = {}) => {
      if (clientRef.current) return;
      setLastError(null);
      setConnection({ state: "connecting", detail: "Opening port…" });
      try {
        const c = await CrtReaderClient.connect(
          (baudRate) => openSerialTransport(chosen, { baudRate }),
          {
            preferredBaud,
            onLog: (e) => ring.push(e),
            onProgress: (detail) => setConnection({ state: "connecting", detail }),
          },
        );
        clientRef.current = c;
        setClient(c);
        setConnection({ state: "connected", info: c.info });
        c.onStatus((s) => setStatus(s));
        c.onDisconnected((reason) => {
          clientRef.current = null;
          setClient(null);
          setPolling(false);
          setBusy(null);
          setConnection({
            state: "error",
            message: `Reader disconnected${reason ? ` — ${reason}` : ""}. Check the cable, then reconnect.`,
            canRetry: true,
          });
        });
        onConnectedRef.current?.(c.info, chosen.getInfo());
      } catch (err) {
        if (o.silent) {
          // Auto-reconnect on load: a failure must not slam the panel into an
          // error state — fall back to disconnected so staff can pick manually.
          const hadPortGrant =
            (await navigator.serial.getPorts().catch(() => [] as SerialPort[])).length > 0;
          setConnection({ state: "disconnected", hadPortGrant });
          return;
        }
        setConnection({ state: "error", message: openErrorMessage(err), canRetry: true });
      }
    },
    [preferredBaud, ring],
  );

  const connect = useCallback(async () => {
    if (typeof navigator === "undefined" || !("serial" in navigator)) {
      setConnection({ state: "unsupported" });
      return;
    }
    if (clientRef.current) return;
    setLastError(null);

    // CRITICAL: requestPort() must be the FIRST await after the click, or the
    // browser spends the gesture's transient activation and silently refuses
    // to show the chooser (it just exits fullscreen and does nothing). So we
    // do NOT await getPorts() first here, and we pass NO filter — a native
    // COM device has no USB ids to filter on, and staff must see all ports.
    let port: SerialPort;
    try {
      port = await navigator.serial.requestPort();
    } catch (err) {
      if (err instanceof DOMException && err.name === "NotFoundError") {
        // NotFoundError = the picker closed with nothing chosen. That's a plain
        // cancel — OR (the production gotcha) no picker ever appeared because a
        // managed browser blocks serial ports by policy, or there are no ports.
        // Show a hint rather than silently doing nothing.
        setConnection({
          state: "error",
          canRetry: true,
          message:
            "No COM port was selected. If no chooser appeared, Web Serial is likely blocked by " +
            "device-management policy on this browser (allowlist this site's serial access), or this " +
            "isn't a desktop Chrome/Edge window on HTTPS. Otherwise, tap Connect and pick the port.",
        });
        return;
      }
      setConnection({ state: "error", message: openErrorMessage(err), canRetry: true });
      return;
    }
    await beginConnect(port);
  }, [beginConnect]);

  // Silent auto-reconnect for a provisioned kiosk: reopen a remembered port
  // with no picker (open() needs no user gesture). Only when this kiosk has
  // connected before (trustSingleGrant) and exactly one grant exists, or one
  // matches the saved USB ids — never guesses among many.
  const triedAutoRef = useRef(false);
  useEffect(() => {
    if (!trustSingleGrant || triedAutoRef.current) return;
    if (typeof navigator === "undefined" || !("serial" in navigator)) return;
    triedAutoRef.current = true;
    let alive = true;
    void (async () => {
      const granted = await navigator.serial.getPorts().catch(() => [] as SerialPort[]);
      if (!alive || clientRef.current || granted.length === 0) return;
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
      if (match) await beginConnect(match, { silent: true });
    })();
    return () => {
      alive = false;
    };
  }, [trustSingleGrant, portInfo, beginConnect]);

  /** Busy/error bookkeeping wrapper for panel buttons. */
  const run = useCallback(
    async <T>(label: string, fn: (c: CrtReaderClient) => Promise<T>): Promise<T | undefined> => {
      const c = clientRef.current;
      if (!c || busyRef.current) return undefined;
      setBusy(label);
      setLastError(null);
      try {
        return await fn(c);
      } catch (err) {
        setLastError(toErrorInfo(err));
        return undefined;
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  // Status/sensor polling — paused while a command is in flight so the log
  // stays readable and motion responses aren't interleaved with STATUS.
  useEffect(() => {
    if (!polling || !client) return;
    let alive = true;
    const timer = setInterval(() => {
      if (!alive || busyRef.current || !clientRef.current) return;
      clientRef.current
        .getSensors()
        .then((r) => {
          if (!alive) return;
          setSensors(r.value);
        })
        .catch((err) => {
          if (!alive) return;
          setLastError(toErrorInfo(err));
          if (err instanceof CrtLinkError) setPolling(false);
        });
    }, POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [polling, client]);

  const clearLog = useCallback(() => ring.clear(), [ring]);
  const clearError = useCallback(() => setLastError(null), []);

  return {
    connection,
    client,
    status,
    sensors,
    log,
    clearLog,
    busy,
    lastError,
    clearError,
    polling,
    setPolling,
    connect,
    disconnect,
    run,
  };
}
