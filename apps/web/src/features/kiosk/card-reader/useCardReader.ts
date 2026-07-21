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
  CrtReadError,
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

/** Result of a reader op — the fault is returned (not just set on `lastError`). */
export type RunResult<T> = { ok: true; value: T } | { ok: false; error: CrtErrorInfo };

export interface UseCardReaderOptions {
  preferredBaud?: number | null;
  portInfo?: { usbVendorId?: number; usbProductId?: number } | null;
  /**
   * Saved index of the reader's port in getPorts() (native COM has no USB id) —
   * reconnect tries this port FIRST (probe-verified) before scanning.
   */
  portIndex?: number | null;
  /**
   * Reuse a single remembered grant without showing the picker. Only pass
   * true once a connect has SUCCEEDED on this kiosk (e.g. config says the
   * reader is set up) — before that, silently reusing a grant hides the
   * picker from staff who granted the wrong COM port on the first try.
   */
  trustSingleGrant?: boolean;
  /** portIndex = the connected port's position in getPorts(), to save for next time. */
  onConnected?: (info: CrtDeviceInfo, portInfo: SerialPortInfo, portIndex: number) => void;
}

// Session cache of the port that last connected as a CRT-591 (module-scoped so
// it survives component remounts — tab switches / SPA nav — within one page
// load). Reconnect reuses it directly, so returning to a screen doesn't re-hunt.
let rememberedCrtPort: SerialPort | null = null;

// The LIVE client parked across component unmounts. Re-opening a native COM
// port + the CRT handshake takes seconds, and each screen (Game Zone, GZ
// fulfillment, admin) owning its own open/close put "Connecting to the card
// dispenser…" on every screen change (owner 2026-07-21). Unmount PARKS the
// connection here instead of closing; the next consumer adopts it instantly.
// Cleared when the device actually drops (module-level onDisconnected below),
// on a deliberate disconnect(), or by the hidden-window release below.
let sharedClient: CrtReaderClient | null = null;

// ── Hidden-window port release ──────────────────────────────────────────────
// A serial port can be open in ONE process at a time, and park-and-adopt keeps
// it open indefinitely. If staff provision in a normal Edge window and then a
// fullscreen kiosk window (a SEPARATE Edge profile/process) comes up over it,
// the hidden window would hold the COM port forever and the kiosk's scan fails
// everywhere. So: when THIS window goes hidden (Chromium marks fully-occluded
// windows hidden), release the shared connection after a short grace — never
// mid-operation — and let the visible window take the port. Components
// reconnect when their window becomes visible again (see the per-instance
// visibility effect in the hook).
const sharedReleaseListeners = new Set<(reason: string | null) => void>();
let sharedActiveOps = 0; // ops in flight across ALL hook instances (runResult)
let releaseTimer: ReturnType<typeof setTimeout> | null = null;
let visibilityReleaseInstalled = false;
const RELEASE_HIDDEN_MS = 8_000;

async function releaseSharedClient(reason: string | null): Promise<void> {
  const c = sharedClient;
  if (!c) return;
  sharedClient = null;
  await c.close().catch(() => undefined);
  // close() doesn't fire onDisconnected (it's a clean close) — notify wired
  // components ourselves so they don't sit on a dead client.
  const listeners = [...sharedReleaseListeners];
  sharedReleaseListeners.clear();
  for (const cb of listeners) cb(reason);
}

function installVisibilityRelease(): void {
  if (visibilityReleaseInstalled || typeof document === "undefined") return;
  visibilityReleaseInstalled = true;
  const check = () => {
    releaseTimer = null;
    if (document.visibilityState !== "hidden" || !sharedClient) return;
    if (sharedActiveOps > 0) {
      releaseTimer = setTimeout(check, 3_000); // mid-dispense — never interrupt
      return;
    }
    void releaseSharedClient("window hidden — COM port released for the visible window");
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      if (!releaseTimer) releaseTimer = setTimeout(check, RELEASE_HIDDEN_MS);
    } else if (releaseTimer) {
      clearTimeout(releaseTimer);
      releaseTimer = null;
    }
  });
  // Navigating away / closing the tab: release immediately (the browser would
  // drop the port anyway — this just makes it deterministic).
  window.addEventListener("pagehide", () => {
    void releaseSharedClient("page closed");
  });
}

const EMPTY_LOG: readonly LogEntry[] = [];
const POLL_MS = 1_200;
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Backoff (ms) between silent reconnect attempts; last entry = final try. */
const RECONNECT_BACKOFFS = [800, 1_500, 3_000, 5_000, 8_000] as const;

function toErrorInfo(err: unknown): CrtErrorInfo {
  if (err instanceof CrtError) return err.info;
  if (err instanceof CrtCardSwError) {
    return { code: err.sw, message: err.message, category: "cardError" };
  }
  if (err instanceof CrtReadError) {
    return {
      code: "READ",
      message: "Couldn't read the card cleanly.",
      category: "cardError",
      hint: "Reposition or re-insert the card and try again.",
    };
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

/**
 * A SecurityError from requestPort() means the chooser never opened, and
 * Chromium throws it for exactly TWO reasons: permissions policy, or a
 * missing/spent user gesture (site-permission Block surfaces as NotFoundError
 * instead). Branch on the browser's own error text plus live probes
 * (featurePolicy, userActivation, UA brands — WebView2/kiosk shells announce
 * themselves there) and spell out the fix. The raw text and probe results are
 * appended so a photo of the kiosk screen finishes the diagnosis remotely.
 */
export function serialBlockedMessage(
  err?: unknown,
  opts?: { gestureActive?: boolean | null },
): string {
  const fp = (
    document as Document & { featurePolicy?: { allowsFeature?: (feature: string) => boolean } }
  ).featurePolicy;
  const policyAllowed = fp?.allowsFeature ? fp.allowsFeature("serial") : null;
  const raw = err instanceof Error ? err.message : "";
  const brands =
    (
      navigator as Navigator & { userAgentData?: { brands?: Array<{ brand: string }> } }
    ).userAgentData?.brands
      ?.map((b) => b.brand)
      .filter((b) => !/not.*brand/i.test(b))
      .join(", ") ?? "";
  const diag = [
    raw ? `browser said “${raw}”` : null,
    `policy allows serial: ${policyAllowed == null ? "unknown" : policyAllowed ? "yes" : "NO"}`,
    opts?.gestureActive != null ? `tap gesture active: ${opts.gestureActive ? "yes" : "NO"}` : null,
    brands ? `browser: ${brands}` : null,
    window.isSecureContext ? null : "secure context: NO",
  ]
    .filter(Boolean)
    .join(" · ");

  let advice: string;
  if (policyAllowed === false || /permissions? policy/i.test(raw)) {
    advice =
      "Serial is blocked by the page's Permissions-Policy — production must send serial=(self) " +
      "(next.config.ts, deployed 2026-07-19). If this page is embedded in another app's frame, " +
      "the embedder must allow it.";
  } else if (/user gesture|user activation/i.test(raw) || opts?.gestureActive === false) {
    advice =
      "The tap's user gesture never reached the chooser — something consumed or synthesized it. " +
      "Tap the button once, directly. If it repeats, this window is likely a kiosk shell or " +
      "remote-control tool replaying clicks — open a NORMAL Edge window with the same profile " +
      "and grant there once; the kiosk window then reconnects silently.";
  } else {
    advice =
      "The browser refused the chooser. Check: (1) padlock icon → Permissions for this site → " +
      '"Serial ports", or edge://settings/content/serialPorts; (2) edge://policy — ' +
      "DefaultSerialGuardSetting / SerialBlockedForUrls on managed browsers; (3) Edge kiosk mode " +
      "(--kiosk) can't show the chooser — open a NORMAL Edge window with the same profile, grant " +
      "there once, and the kiosk window reconnects silently.";
  }
  return `${advice} [${diag}]`;
}

function openErrorMessage(err: unknown): string {
  const name = err instanceof DOMException ? err.name : "";
  if (name === "InvalidStateError" || name === "NetworkError") {
    return "Reader port is in use by another window or program — another Edge window (normal or kiosk) may be connected to the reader. Close it and retry.";
  }
  if (name === "SecurityError") {
    return serialBlockedMessage(err);
  }
  return err instanceof Error ? err.message : String(err);
}

/** Transient-activation probe — read BEFORE the first await spends/loses it. */
export function gestureIsActive(): boolean | null {
  if (typeof navigator === "undefined") return null;
  const ua = (navigator as Navigator & { userActivation?: { isActive?: boolean } }).userActivation;
  return typeof ua?.isActive === "boolean" ? ua.isActive : null;
}

export function useCardReader(opts: UseCardReaderOptions = {}) {
  const {
    preferredBaud = null,
    portInfo = null,
    portIndex = null,
    trustSingleGrant = false,
    onConnected,
  } = opts;

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
  // Terminal: the reader dropped and auto-reconnect gave up. Consumers use this
  // to disable functionality that needs the hardware (no dispense → no sale).
  const [unavailable, setUnavailable] = useState(false);

  const clientRef = useRef<CrtReaderClient | null>(null);
  // The busy LOCK is this ref, managed synchronously inside run() — it used to
  // be effect-synced from the `busy` state, which raced: in a tight await chain
  // (present → waitTaken → next dispense, the multi-card buy loop) the next
  // run() saw the PREVIOUS op's stale "busy" and returned undefined instantly —
  // surfacing as "couldn't dispense a card" on every card after the first
  // (owner 2026-07-18). State `busy` remains for UI display only.
  const busyRef = useRef<string | null>(null);

  const onConnectedRef = useRef(onConnected);
  useEffect(() => {
    onConnectedRef.current = onConnected;
  }, [onConnected]);

  // Reconnect wiring uses refs so beginConnect's onDisconnected closure can call
  // the reconnect loop without a dependency cycle (loop → reopen → beginConnect).
  const trustRef = useRef(trustSingleGrant);
  useEffect(() => {
    trustRef.current = trustSingleGrant;
  }, [trustSingleGrant]);
  const attemptReconnectRef = useRef<() => void>(() => {});
  const reconnectActiveRef = useRef(false);
  const stopReconnectRef = useRef(false);

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

  // Listener unsubscribes THIS component instance registered on the (shared)
  // client — detached on unmount WITHOUT closing the connection.
  const unsubsRef = useRef<Array<() => void>>([]);

  /** Attach this component to a live client: state + listeners. Used by a
   *  fresh connect AND by adopting the parked shared client on mount. */
  const wireClient = useCallback((c: CrtReaderClient) => {
    clientRef.current = c;
    setClient(c);
    setUnavailable(false);
    setConnection({ state: "connected", info: c.info });
    const onDrop = (reason: string | null) => {
      clientRef.current = null;
      setClient(null);
      setPolling(false);
      setBusy(null);
      // Hidden-window release: WE gave the port up so the visible window (the
      // fullscreen kiosk, another profile/process) can take it. Don't fight to
      // re-grab it — the visibility effect reconnects when we're visible again.
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        setConnection({ state: "disconnected", hadPortGrant: true });
        return;
      }
      if (trustRef.current) {
        // Provisioned kiosk — recover automatically (backoff loop); only
        // mark unavailable if that gives up.
        setConnection({
          state: "connecting",
          detail: `Reader disconnected${reason ? ` — ${reason}` : ""}. Reconnecting…`,
        });
        attemptReconnectRef.current();
      } else {
        setConnection({
          state: "error",
          message: `Reader disconnected${reason ? ` — ${reason}` : ""}. Check the cable, then reconnect.`,
          canRetry: true,
        });
      }
    };
    sharedReleaseListeners.add(onDrop);
    unsubsRef.current.push(
      c.onStatus((s) => setStatus(s)),
      c.onDisconnected(onDrop),
      () => sharedReleaseListeners.delete(onDrop),
    );
  }, []);

  // Adopt the parked live connection from the previous screen, if any —
  // instant CONNECTED, no port re-open, no "Connecting…" flash. Declared
  // before the auto-reconnect effect below so adoption wins on mount. Also
  // installs the once-per-page hidden-window release hook.
  useEffect(() => {
    installVisibilityRelease();
    if (!clientRef.current && sharedClient) wireClient(sharedClient);
  }, [wireClient]);

  // When THIS window becomes visible again and the port was released (or lost)
  // while hidden, take it back automatically — the port follows whichever
  // window is actually in front.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVis = () => {
      if (document.visibilityState !== "visible") return;
      if (trustRef.current && !clientRef.current && !sharedClient) attemptReconnectRef.current();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  // PARK the connection + stop reconnecting when the owner unmounts. Do NOT
  // close the port — the next screen adopts it via sharedClient; closing here
  // is what caused a full re-open (seconds) on every screen change.
  useEffect(() => {
    return () => {
      stopReconnectRef.current = true;
      unsubsRef.current.forEach((u) => u());
      unsubsRef.current = [];
      clientRef.current = null;
    };
  }, []);

  const disconnect = useCallback(async () => {
    stopReconnectRef.current = true; // deliberate close — don't fight it with a reconnect
    setUnavailable(false);
    const c = clientRef.current;
    clientRef.current = null;
    if (c && sharedClient === c) sharedClient = null; // deliberate close kills the parked copy
    unsubsRef.current.forEach((u) => u());
    unsubsRef.current = [];
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
        // Park the client for adoption by later screens, and clear the parked
        // copy the moment the DEVICE actually drops (module-level listener —
        // never unsubscribed, tied to the client's own lifetime).
        sharedClient = c;
        c.onDisconnected(() => {
          if (sharedClient === c) sharedClient = null;
        });
        wireClient(c);
        // Remember WHERE we connected: the port object (this session) + its
        // index in getPorts() (saved to config → Neon, so a fresh session/boot
        // tries it first instead of re-scanning).
        rememberedCrtPort = chosen;
        const idx = (await navigator.serial.getPorts().catch(() => [] as SerialPort[])).indexOf(
          chosen,
        );
        onConnectedRef.current?.(c.info, chosen.getInfo(), idx);
      } catch (err) {
        // Surface EVERY per-port failure in the TX/RX log — especially opens
        // that fail because another program holds the port (vendor debug tool,
        // another Edge window). Without this, a held port was skipped in total
        // silence and the log showed only TX-into-nothing on the other ports
        // (the 2026-07-21 "kiosk is struggling" trace).
        ring.push({
          dir: "tx",
          t: typeof performance !== "undefined" ? performance.now() : Date.now(),
          bytes: new Uint8Array(0),
          decoded: `PORT FAILED — ${err instanceof Error ? err.message : String(err)}`,
          level: "error",
        });
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
    [preferredBaud, ring, wireClient],
  );

  const connect = useCallback(async () => {
    if (typeof navigator === "undefined" || !("serial" in navigator)) {
      setConnection({ state: "unsupported" });
      return;
    }
    if (clientRef.current) return;
    stopReconnectRef.current = true; // a manual connect supersedes the auto loop
    setUnavailable(false);
    setLastError(null);

    // CRITICAL: requestPort() must be the FIRST await after the click, or the
    // browser spends the gesture's transient activation and silently refuses
    // to show the chooser (it just exits fullscreen and does nothing). So we
    // do NOT await getPorts() first here, and we pass NO filter — a native
    // COM device has no USB ids to filter on, and staff must see all ports.
    const gestureActive = gestureIsActive();
    // A held Fullscreen-API element makes Chromium SUPPRESS the serial-port
    // chooser — the "picker only shows if you open DevTools" bug (opening
    // DevTools drops fullscreen, which is why it then works). Drop out of
    // fullscreen first; fire-and-forget (NOT awaited) so requestPort() still
    // runs inside this click's transient activation.
    if (typeof document !== "undefined" && document.fullscreenElement) {
      void document.exitFullscreen?.().catch(() => {});
    }
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
      const message =
        err instanceof DOMException && err.name === "SecurityError"
          ? serialBlockedMessage(err, { gestureActive })
          : openErrorMessage(err);
      setConnection({ state: "error", message, canRetry: true });
      return;
    }
    await beginConnect(port);
  }, [beginConnect]);

  /**
   * Connect to a port the caller already holds — the admin panel's "Prompt for
   * permissions" flow calls requestPort() itself (so it can report the grant)
   * and hands the chosen port here. Returns true once connected. Mirrors
   * connect()'s manual-action resets.
   */
  const connectPort = useCallback(
    async (port: SerialPort): Promise<boolean> => {
      if (clientRef.current) return true;
      stopReconnectRef.current = true; // a manual connect supersedes the auto loop
      setUnavailable(false);
      setLastError(null);
      await beginConnect(port);
      return clientRef.current != null;
    },
    [beginConnect],
  );

  // Reopen a remembered port with NO picker (open() needs no user gesture).
  // Matches the saved USB ids, or a lone grant; a NATIVE COM reader (no USB id)
  // among several granted ports has no stable identifier at all, so we probe
  // each and keep the first that answers as a CRT-591 (its protocol reply is the
  // identity — non-readers just fail). Returns true once connected.
  const reopenSilently = useCallback(async (): Promise<boolean> => {
    if (typeof navigator === "undefined" || !("serial" in navigator)) return false;
    if (clientRef.current) return true;
    const granted = await navigator.serial.getPorts().catch(() => [] as SerialPort[]);
    if (granted.length === 0) return false;
    // FIRST try where we found it before — the remembered port (this session) or
    // the saved index (across reloads/boots) — so a native COM reader stops
    // re-scanning on every return. beginConnect probe-verifies, so a stale/moved
    // index just falls through to the scan below.
    const preferred =
      rememberedCrtPort && granted.includes(rememberedCrtPort)
        ? rememberedCrtPort
        : portIndex != null && portIndex >= 0 && portIndex < granted.length
          ? granted[portIndex]
          : null;
    if (preferred) {
      await beginConnect(preferred, { silent: true });
      if (clientRef.current) return true;
    }
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
    if (match) {
      await beginConnect(match, { silent: true });
      return clientRef.current != null;
    }
    // No unique match (native COM among several granted ports, e.g. the
    // SerialAllowAllPortsForUrls policy hands back every port). Probe each until
    // the CRT-591 responds — a non-reader port fails and we move on.
    for (const p of granted) {
      if (stopReconnectRef.current || clientRef.current) break;
      await beginConnect(p, { silent: true });
      if (clientRef.current) return true;
    }
    return clientRef.current != null;
  }, [portInfo, portIndex, beginConnect]);

  // Auto-reconnect loop (provisioned kiosks): retry the silent reopen with
  // backoff. Succeeds → connected (unavailable cleared in beginConnect). Gives
  // up → `unavailable` = true so consumers can disable the feature (no dispense
  // → no sale). A manual connect / disconnect sets stopReconnectRef to bail.
  const attemptReconnect = useCallback(async () => {
    if (reconnectActiveRef.current) return;
    reconnectActiveRef.current = true;
    stopReconnectRef.current = false;
    try {
      for (let i = 0; i < RECONNECT_BACKOFFS.length; i++) {
        if (stopReconnectRef.current || clientRef.current) return;
        setConnection({
          state: "connecting",
          detail: `Reconnecting to the card reader… (${i + 1}/${RECONNECT_BACKOFFS.length})`,
        });
        if (await reopenSilently()) return; // connected
        if (stopReconnectRef.current) return;
        await delay(RECONNECT_BACKOFFS[i]);
      }
      if (!clientRef.current && !stopReconnectRef.current) {
        setUnavailable(true);
        // Say WHY precisely: zero granted ports = this browser PROFILE has no
        // serial access at all (the SerialAllowAllPortsForUrls reg-add needs an
        // ELEVATED shell — run un-elevated it fails silently; kiosk mode can't
        // show the picker to grant manually). Distinct from a wired-but-dead
        // reader.
        const grants =
          typeof navigator !== "undefined" && "serial" in navigator
            ? (await navigator.serial.getPorts().catch(() => [] as SerialPort[])).length
            : 0;
        setConnection({
          state: "error",
          canRetry: true,
          message:
            grants === 0
              ? "No COM ports are granted to this browser profile — the serial policy isn't applied here. Run the SerialAllowAllPortsForUrls reg add from an ADMINISTRATOR prompt and relaunch, or pair the port once in a normal window using this same profile."
              : "The card reader is offline and couldn't reconnect. If another Edge window is (or was just) connected to it, close that window. Otherwise check the reader's cable/power. Please see an attendant.",
        });
      }
    } finally {
      reconnectActiveRef.current = false;
    }
  }, [reopenSilently]);

  useEffect(() => {
    attemptReconnectRef.current = () => void attemptReconnect();
  }, [attemptReconnect]);

  // On mount, a provisioned kiosk silently connects (and, if it can't, runs the
  // reconnect loop → marks unavailable so the flow can gate the feature).
  const triedAutoRef = useRef(false);
  useEffect(() => {
    if (!trustSingleGrant || triedAutoRef.current) return;
    if (typeof navigator === "undefined" || !("serial" in navigator)) return;
    triedAutoRef.current = true;
    void attemptReconnect();
  }, [trustSingleGrant, attemptReconnect]);

  /**
   * Busy/error bookkeeping wrapper that RETURNS the fault — the ref is the
   * mutex (set/cleared synchronously so back-to-back awaited ops never see a
   * stale lock). Callers that need to branch on the fault category (the
   * recovery policy) use this; `run()` below is the value|undefined shim.
   */
  const runResult = useCallback(
    async <T>(label: string, fn: (c: CrtReaderClient) => Promise<T>): Promise<RunResult<T>> => {
      const c = clientRef.current;
      if (!c) {
        return {
          ok: false,
          error: { code: "NC", message: "Reader is not connected.", category: "fatal" },
        };
      }
      if (busyRef.current) {
        return {
          ok: false,
          error: { code: "BUSY", message: "Reader is busy.", category: "retryable" },
        };
      }
      busyRef.current = label;
      sharedActiveOps++; // hidden-window release never interrupts an op in flight
      setBusy(label);
      setLastError(null);
      try {
        return { ok: true, value: await fn(c) };
      } catch (err) {
        const error = toErrorInfo(err);
        setLastError(error);
        return { ok: false, error };
      } finally {
        busyRef.current = null;
        sharedActiveOps--;
        setBusy(null);
      }
    },
    [],
  );

  const run = useCallback(
    async <T>(label: string, fn: (c: CrtReaderClient) => Promise<T>): Promise<T | undefined> => {
      const r = await runResult(label, fn);
      return r.ok ? r.value : undefined;
    },
    [runResult],
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
    connectPort,
    disconnect,
    run,
    runResult,
    unavailable,
  };
}
