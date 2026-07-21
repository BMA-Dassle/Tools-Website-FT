"use client";

/**
 * CRT-591 card reader/dispenser test panel — a tab inside the PIN-gated
 * kiosk admin. Staff exercise every hardware operation here (init, status,
 * motion, dispense, entry gate, RF/Mifare read-write, raw commands) with a
 * live TX/RX hex log. This is the read/write/test-and-error-handling surface
 * for the unit; the guest Game Zone flow wires up in a later PR.
 *
 * The unit's COM port drives transport/dispensing (this panel, via Web
 * Serial). Card READING on the (R02)HB-HDN arrives over a separate USB
 * interface — the "USB card read" section captures keyboard-wedge bursts.
 * See docs/crt-591/README.md.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  gestureIsActive,
  hexDump,
  parseWedgeBurst,
  serialBlockedMessage,
  useCardReader,
  type CrtErrorInfo,
  type InitMode,
  type LogEntry,
  type MagTracks,
  type MoveTarget,
  type RfActivation,
  type WedgeCapture,
} from "../card-reader";
import type { CrtReaderClient } from "../card-reader";
import { describePort } from "../card-reader/ports";
import type { KioskConfig } from "../config";

const inputClass =
  "w-full rounded-xl border border-white/15 bg-white/5 px-4 py-3 text-white focus:border-[#00E2E5] focus:outline-none";
const btnPrimary =
  "rounded-xl bg-[#00e2e5] px-5 py-2.5 text-sm font-bold text-[#04252b] disabled:opacity-40";
const btnGhost =
  "rounded-xl border border-white/15 px-5 py-2.5 text-sm font-bold text-white/70 disabled:opacity-40";
const cardClass = "space-y-4 rounded-2xl border border-white/10 bg-white/[0.03] p-6";

function parseHexBytes(text: string): Uint8Array {
  const clean = text.replace(/[\s,:]+/g, "");
  if (clean === "") return new Uint8Array(0);
  if (!/^[0-9a-fA-F]+$/.test(clean) || clean.length % 2 !== 0) {
    throw new RangeError("Enter hex bytes (even number of hex digits), e.g. 00 B0 01");
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function parseHexByte(text: string, label: string): number {
  const clean = text.replace(/\s+/g, "");
  if (!/^[0-9a-fA-F]{1,2}$/.test(clean))
    throw new RangeError(`${label} must be one hex byte, e.g. 31`);
  return parseInt(clean, 16);
}

export function KioskAdminCardReader({
  draft,
  persist,
  setMsg,
}: {
  draft: Partial<KioskConfig>;
  persist: (extra?: Partial<KioskConfig>) => void | Promise<unknown>;
  setMsg: (m: string) => void;
}) {
  const reader = useCardReader({
    preferredBaud: draft.cardReaderBaud ?? null,
    portInfo: draft.cardReaderPortInfo ?? null,
    // Silent grant-reuse only after this kiosk has connected successfully once.
    trustSingleGrant: !!draft.cardReaderEnabled,
    onConnected: (info, portInfo) => {
      void persist({
        cardReaderEnabled: true,
        cardReaderBaud: info.baudRate,
        cardReaderPortInfo:
          portInfo.usbVendorId != null
            ? { usbVendorId: portInfo.usbVendorId, usbProductId: portInfo.usbProductId }
            : null,
        // The unit's serial number IS the kiosk's dispenser id.
        ...(info.serialNumber ? { dispenserId: info.serialNumber } : {}),
      });
      setMsg(
        `Card reader connected — ${info.firmware || "unknown firmware"} @ ${info.baudRate} baud${
          info.serialNumber ? ` (serial ${info.serialNumber})` : ""
        }. Saved to this device + cloud.`,
      );
    },
  });

  const { connection, busy, lastError, run } = reader;
  const connected = connection.state === "connected";

  /* Retry support: remember the last button action. */
  const lastActionRef = useRef<{
    label: string;
    fn: (c: CrtReaderClient) => Promise<unknown>;
  } | null>(null);
  const act = useCallback(
    (label: string, fn: (c: CrtReaderClient) => Promise<unknown>) => {
      lastActionRef.current = { label, fn };
      void run(label, fn);
    },
    [run],
  );

  return (
    <div className="space-y-4">
      <ConnectionCard reader={reader} draft={draft} />
      {lastError && (
        <ErrorBanner
          error={lastError}
          onDismiss={reader.clearError}
          act={act}
          clear={reader.clearError}
        />
      )}
      {connected && (
        <>
          <CardFlowsCard reader={reader} />
          <StatusCard reader={reader} act={act} />
          <MagStripeCard reader={reader} act={act} />
          <MotionCard reader={reader} act={act} />
          <EntryWatchCard reader={reader} act={act} />
          <RfMifareCard act={act} busy={busy} />
          <RawConsoleCard reader={reader} />
        </>
      )}
      <WedgeCaptureCard />
      <LogCard log={reader.log} onClear={reader.clearLog} setMsg={setMsg} />
    </div>
  );
}

/* ------------------------------------------------------------------ */

function ConnectionCard({
  reader,
  draft,
}: {
  reader: ReturnType<typeof useCardReader>;
  draft: Partial<KioskConfig>;
}) {
  const { connection, connect, connectPort, disconnect } = reader;
  const [permMsg, setPermMsg] = useState<string | null>(null);

  // Granted COM ports (getPorts needs no chooser — with the "allow all serial"
  // Edge policy it returns every port). Pick one → open + probe it → onConnected
  // saves it. Web Serial hides the "COM3" name, so ports are labelled by USB id.
  const [grantedPorts, setGrantedPorts] = useState<SerialPort[]>([]);
  const refreshPorts = useCallback(async () => {
    if (typeof navigator === "undefined" || !("serial" in navigator)) return;
    setGrantedPorts(await navigator.serial.getPorts().catch(() => [] as SerialPort[]));
  }, []);
  useEffect(() => {
    void refreshPorts();
  }, [refreshPorts]);
  const tryPort = (i: number) => {
    const port = grantedPorts[i];
    if (!port) return;
    setPermMsg("Connecting to the selected port…");
    void connectPort(port).then((ok) => {
      setPermMsg(ok ? null : "That port didn’t answer as a CRT-591 — pick another.");
    });
  };

  // Auto-scan: try every granted port in turn, stop at the first that answers as
  // a CRT-591 (connectPort probes it; onConnected saves it). Web Serial hides
  // the COM name, so brute-force is how "find the reader" works here.
  const [scanning, setScanning] = useState(false);
  const autoScan = async () => {
    if (typeof navigator === "undefined" || !("serial" in navigator)) return;
    const ports = await navigator.serial.getPorts().catch(() => [] as SerialPort[]);
    setGrantedPorts(ports);
    if (ports.length === 0) {
      setPermMsg(
        "No granted COM ports to scan — set the “allow all serial” policy, or use Prompt for permissions.",
      );
      return;
    }
    setScanning(true);
    try {
      for (let i = 0; i < ports.length; i++) {
        setPermMsg(`Scanning for the CRT-591 — port ${i + 1} of ${ports.length}…`);
        if (await connectPort(ports[i])) {
          setPermMsg(null); // the CONNECTED card is the proof
          return;
        }
      }
      setPermMsg(
        `No CRT-591 answered on any of the ${ports.length} granted port(s). Check the reader’s USB lead and power, then Refresh and scan again.`,
      );
    } finally {
      setScanning(false);
    }
  };

  /**
   * Camera-admin parity (owner 2026-07-19, after "browser blocked serial
   * access" on the podium): a button whose only job is to make the browser
   * ASK. For Web Serial the Allow popup is the port chooser, and the
   * proof-of-grant (the camera's 5-second preview) is connecting — the
   * firmware/serial/baud rows above light up. When the chooser never opens
   * (SecurityError), the message pinpoints the blocking layer: our own
   * Permissions-Policy header vs Edge's site permission / management policy.
   */
  const promptPermissions = async () => {
    if (typeof navigator === "undefined" || !("serial" in navigator)) {
      setPermMsg(
        "Web Serial isn't available here — it needs desktop Chrome/Edge on an HTTPS page.",
      );
      return;
    }
    setPermMsg(null);
    const gestureActive = gestureIsActive();
    let port: SerialPort;
    try {
      // FIRST await after the tap — anything earlier spends the gesture's
      // transient activation and the chooser silently never opens.
      port = await navigator.serial.requestPort();
    } catch (err) {
      const name = err instanceof DOMException ? err.name : "";
      setPermMsg(
        name === "SecurityError"
          ? serialBlockedMessage(err, { gestureActive })
          : name === "NotFoundError"
            ? "The chooser opened but no port was picked — or none exist. Check the reader's USB lead and that a COM port shows in Device Manager → Ports (COM & LPT)."
            : `Permission request failed${err instanceof Error && err.message ? ` — ${err.message}` : ""}`,
      );
      return;
    }
    const granted = await navigator.serial.getPorts().catch(() => [] as SerialPort[]);
    const info = port.getInfo();
    const portLabel =
      info.usbVendorId != null
        ? `USB ${info.usbVendorId.toString(16).padStart(4, "0")}:${(info.usbProductId ?? 0)
            .toString(16)
            .padStart(4, "0")}`
        : "native COM port";
    setPermMsg(
      `Serial permission GRANTED — ${portLabel} paired (${granted.length} port grant${
        granted.length === 1 ? "" : "s"
      } on this device). Connecting to prove it…`,
    );
    const ok = await connectPort(port);
    setPermMsg(
      ok
        ? null // the CONNECTED card above (firmware/serial/baud) is the proof
        : `Serial permission is GRANTED (${portLabel}) — the connect error above is a device/port problem, not permissions.`,
    );
  };

  const savedPort = draft.cardReaderPortInfo;
  const savedLine = draft.cardReaderEnabled
    ? `baud ${draft.cardReaderBaud ?? "auto"} · ${
        savedPort?.usbVendorId != null
          ? `USB ${savedPort.usbVendorId.toString(16).padStart(4, "0")}:${(
              savedPort.usbProductId ?? 0
            )
              .toString(16)
              .padStart(4, "0")}`
          : "native COM (no USB id — reconnects only if it’s the one granted port)"
      }${draft.dispenserId ? ` · serial ${draft.dispenserId}` : ""}`
    : null;
  return (
    <div className={cardClass}>
      <div className="flex items-center justify-between">
        <div className="font-semibold">CRT-591 connection (COM / Web Serial)</div>
        <ConnState connection={connection} />
      </div>

      {savedLine && connection.state !== "connected" && (
        <div className="rounded-xl border border-white/10 bg-white/[0.02] px-4 py-2 text-xs text-white/50">
          Saved for reconnect: {savedLine}
        </div>
      )}

      {connection.state === "unsupported" && (
        <p className="text-sm text-amber-300">
          Web Serial isn’t available in this browser. It needs desktop <b>Chrome or Edge</b> on an{" "}
          <b>HTTPS</b> page (production is HTTPS — if you’re on an{" "}
          <code className="rounded bg-white/10 px-1">http://</code> URL, that’s why). Not Safari,
          Firefox, or mobile. It can also be turned off by device- management policy — see
          docs/crt-591/README.md.
        </p>
      )}

      {connection.state === "connecting" && (
        <p className="text-sm text-white/55">{connection.detail}</p>
      )}

      {connection.state === "error" && <p className="text-sm text-red-300">{connection.message}</p>}

      {connection.state === "connected" && (
        <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
          <InfoRow label="Firmware" value={connection.info.firmware || "—"} />
          <InfoRow label="Version" value={connection.info.version ?? "—"} />
          <InfoRow label="Serial #" value={connection.info.serialNumber ?? "—"} />
          <InfoRow label="Baud" value={String(connection.info.baudRate)} />
          {connection.info.configHex && (
            <div className="col-span-2">
              <InfoRow label="Config" value={connection.info.configHex} mono />
            </div>
          )}
        </div>
      )}

      {connection.state === "connected" && connection.info.modelMismatch && (
        <p className="rounded-xl border border-amber-400/40 bg-amber-400/10 px-4 py-3 text-xs text-amber-200">
          This unit reports “{connection.info.firmware || connection.info.version || "unknown"}” but
          the protocol doc on hand is CRT-591-M001. Dispenser/status/RF commands are family-shared
          and work; anything undocumented (magstripe over COM) needs the vendor doc — probe via the
          raw console. Details: docs/crt-591/README.md.
        </p>
      )}

      {connection.state !== "connected" &&
        (connection.state !== "connecting" || scanning) &&
        grantedPorts.length > 0 && (
          <div className="space-y-1.5">
            <div className="text-xs font-semibold uppercase tracking-widest text-white/40">
              Granted COM ports — pick one to connect &amp; save
            </div>
            <div className="flex gap-2">
              <select
                className={`${inputClass} [color-scheme:dark]`}
                defaultValue=""
                disabled={scanning}
                onChange={(e) => tryPort(Number(e.target.value))}
              >
                <option value="" disabled>
                  Select a port…
                </option>
                {grantedPorts.map((p, i) => (
                  <option key={i} value={i}>
                    {describePort(p, i)}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className={btnGhost}
                disabled={scanning}
                onClick={() => void refreshPorts()}
              >
                Refresh
              </button>
            </div>
            <button
              type="button"
              className={btnPrimary}
              disabled={scanning}
              onClick={() => void autoScan()}
            >
              {scanning ? "Scanning…" : "Auto-scan for the CRT-591"}
            </button>
            <p className="text-xs text-white/40">
              No chooser needed once the “allow all serial” policy is set. <b>Auto-scan</b> tries
              every port and stops at the reader; or pick a port yourself. Either way, on a hit the
              CRT-591 shows its firmware/serial above and saves automatically.
            </p>
          </div>
        )}

      <div className="flex flex-wrap gap-2">
        {connection.state !== "connected" && connection.state !== "connecting" && (
          <>
            <button
              type="button"
              className={btnPrimary}
              // Stop the event reaching KioskShell's document-level pointerdown
              // handler, which requests fullscreen and would consume this gesture's
              // transient activation — starving Web Serial's requestPort() and
              // throwing the "browser blocked serial access" permissions error.
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => void promptPermissions()}
            >
              Prompt for permissions
            </button>
            <button
              type="button"
              className={btnGhost}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => void connect()}
            >
              Choose COM port &amp; connect…
            </button>
          </>
        )}
        {connection.state === "connected" && (
          <button type="button" className={btnGhost} onClick={() => void disconnect()}>
            Disconnect
          </button>
        )}
      </div>
      {permMsg && <p className="text-sm text-white/60">{permMsg}</p>}
      {connection.state !== "connected" && connection.state !== "connecting" && (
        <p className="text-xs text-white/40">
          Both buttons open the browser’s COM-port chooser (choosing a port IS the permission
          grant). “Prompt for permissions” also reports the grant, and when the chooser is blocked
          it names the blocking layer and where to unblock it — like the camera admin’s button.
        </p>
      )}
    </div>
  );
}

function ConnState({ connection }: { connection: ReturnType<typeof useCardReader>["connection"] }) {
  const map: Record<string, { text: string; cls: string }> = {
    unsupported: { text: "UNSUPPORTED", cls: "bg-white/10 text-white/50" },
    disconnected: { text: "DISCONNECTED", cls: "bg-white/10 text-white/50" },
    connecting: { text: "CONNECTING…", cls: "bg-amber-400/20 text-amber-200" },
    connected: { text: "CONNECTED", cls: "bg-[#46d68c]/20 text-[#46d68c]" },
    error: { text: "ERROR", cls: "bg-red-400/20 text-red-300" },
  };
  const m = map[connection.state];
  return <span className={`rounded-full px-3 py-1 text-xs font-bold ${m.cls}`}>{m.text}</span>;
}

function InfoRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex gap-2">
      <span className="shrink-0 text-white/40">{label}:</span>
      <span
        className={mono ? "break-all font-mono text-xs leading-5 text-white/80" : "text-white/80"}
      >
        {value}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function StatusCard({
  reader,
  act,
}: {
  reader: ReturnType<typeof useCardReader>;
  act: (label: string, fn: (c: CrtReaderClient) => Promise<unknown>) => void;
}) {
  const { status, sensors, polling, setPolling, busy } = reader;
  const [binCount, setBinCount] = useState<number | null>(null);

  const chip = (label: string, value: string, tone: "ok" | "warn" | "bad" | "dim") => {
    const cls = {
      ok: "border-[#46d68c]/40 bg-[#46d68c]/10 text-[#46d68c]",
      warn: "border-amber-400/40 bg-amber-400/10 text-amber-200",
      bad: "border-red-400/40 bg-red-400/10 text-red-300",
      dim: "border-white/10 bg-white/[0.02] text-white/55",
    }[tone];
    return (
      <div className={`rounded-xl border px-4 py-3 ${cls}`}>
        <div className="text-[10px] font-semibold uppercase tracking-widest opacity-70">
          {label}
        </div>
        <div className="text-sm font-bold">{value}</div>
      </div>
    );
  };

  const cardTone = status?.card === "none" ? "dim" : "ok";
  const stackerTone =
    status?.stacker === "enough"
      ? "ok"
      : status?.stacker === "few"
        ? "warn"
        : status?.stacker === "empty"
          ? "bad"
          : "dim";
  // Bin state = status.errorBin (st2). BIN_BY_BYTE now decodes this unit's full
  // code (0x32) as "full", so ok = empty, full = full.
  const binState = status?.errorBin ?? "unknown";
  const binTone = binState === "full" ? "bad" : binState === "ok" ? "ok" : "dim";

  const cardText = {
    none: "None inside",
    atGate: "At gate",
    atRfIcPosition: "At RF/IC position",
    unknown: "Unknown",
  }[status?.card ?? "unknown"];

  return (
    <div className={cardClass}>
      <div className="flex items-center justify-between">
        <div className="font-semibold">Live status</div>
        <div className="flex gap-2">
          <button
            type="button"
            className={btnGhost}
            disabled={!!busy}
            onClick={() =>
              act("status", async (c) => {
                const s = await c.getSensors();
                return s;
              })
            }
          >
            Refresh
          </button>
          <button
            type="button"
            className={polling ? btnPrimary : btnGhost}
            onClick={() => setPolling(!polling)}
          >
            {polling ? "Polling ON" : "Poll every 1.2s"}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        {chip("Card", status ? cardText : "—", status ? cardTone : "dim")}
        {chip("Stacker", status?.stacker ?? "—", stackerTone)}
        {chip("Error bin", binState === "full" ? "FULL" : binState === "ok" ? "OK" : "—", binTone)}
      </div>

      {sensors && (
        <div className="flex items-center gap-3 text-xs text-white/55">
          <span className="font-semibold uppercase tracking-widest text-white/40">Sensors</span>
          {sensors.sensors.map((on, i) => (
            <span key={i} className="flex items-center gap-1">
              S{i + 1}
              <span
                className={`inline-block h-2.5 w-2.5 rounded-full ${on ? "bg-[#00e2e5]" : "border border-white/30"}`}
              />
            </span>
          ))}
          {sensors.s8Raw != null && (
            <span className="text-white/30">S8: {hexDump(Uint8Array.from([sensors.s8Raw]))}</span>
          )}
        </div>
      )}

      <div className="flex items-center gap-3 text-sm">
        <span className="text-white/40">Error-bin counter:</span>
        <span className="font-bold">{binCount ?? "—"}</span>
        <button
          type="button"
          className={btnGhost}
          disabled={!!busy}
          onClick={() =>
            act("bin counter", async (c) => {
              const r = await c.readBinCounter();
              setBinCount(r.value);
            })
          }
        >
          Read
        </button>
        <button
          type="button"
          className={btnGhost}
          disabled={!!busy}
          onClick={() =>
            act("reset bin counter", async (c) => {
              await c.resetBinCounter(0);
              const r = await c.readBinCounter();
              setBinCount(r.value);
            })
          }
        >
          Reset to 0
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

/**
 * The two real Game Zone use cases, end to end:
 *  - BUY: feed a blank from the stacker → read its account → (wait for the
 *    operator's go) → dispense it to the customer.
 *  - RELOAD: permit a card in → wait for insertion → read its account →
 *    (wait for the operator's go) → return the card.
 * Each is two-phase so production can pause between the read and the eject to
 * take payment / apply the reload; here that pause is a confirm button.
 */
function CardFlowsCard({ reader }: { reader: ReturnType<typeof useCardReader> }) {
  const { client, busy } = reader;

  type Phase =
    | { step: "idle" }
    | { step: "reading" }
    | { step: "held"; tracks: MagTracks }
    | { step: "done"; cardNumber: string | null }
    | { step: "error"; message: string };

  const [buy, setBuy] = useState<Phase>({ step: "idle" });
  const [reload, setReload] = useState<Phase>({ step: "idle" });
  const abortRef = useRef<AbortController | null>(null);

  const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

  const startBuy = async () => {
    if (!client || busy) return;
    setBuy({ step: "reading" });
    try {
      const tracks = await client.issueAndReadCard();
      setBuy({ step: "held", tracks });
    } catch (e) {
      setBuy({ step: "error", message: errText(e) });
    }
  };

  const startReload = async () => {
    if (!client || busy) return;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setReload({ step: "reading" });
    try {
      const tracks = await client.acceptAndReadCard({ timeoutMs: 30_000, signal: ctrl.signal });
      setReload({ step: "held", tracks });
    } catch (e) {
      setReload({ step: "error", message: errText(e) });
    } finally {
      abortRef.current = null;
    }
  };

  const finish = async (which: "buy" | "reload") => {
    if (!client) return;
    const set = which === "buy" ? setBuy : setReload;
    const phase = which === "buy" ? buy : reload;
    const cardNumber = phase.step === "held" ? phase.tracks.cardNumber : null;
    try {
      await client.presentCard();
      // After a reload dispenses, stop the gate from accepting further cards
      // (the vendor sends ENTRY 30h here). Buy never opened entry, so skip it.
      if (which === "reload") await client.prohibitEntry();
      set({ step: "done", cardNumber });
    } catch (e) {
      set({ step: "error", message: errText(e) });
    }
  };

  const flowBusy = buy.step === "reading" || reload.step === "reading";

  const renderResult = (phase: Phase, which: "buy" | "reload") => {
    if (phase.step === "reading") {
      return (
        <p className="text-sm text-amber-200">
          {which === "reload" ? "Waiting for a card to be inserted…" : "Feeding + reading card…"}
        </p>
      );
    }
    if (phase.step === "held") {
      return (
        <div className="space-y-2">
          <div className="rounded-xl border border-[#00e2e5]/40 bg-[#00e2e5]/10 px-4 py-3">
            <div className="text-[10px] font-semibold uppercase tracking-widest text-[#00e2e5]/80">
              Card read — account number
            </div>
            <div className="font-mono text-lg font-bold text-white">
              {phase.tracks.cardNumber ?? "not found"}
            </div>
          </div>
          <button
            type="button"
            className={btnPrimary}
            disabled={!!busy}
            onClick={() => void finish(which)}
          >
            {which === "buy" ? "Confirm → dispense to customer" : "Confirm → return card"}
          </button>
        </div>
      );
    }
    if (phase.step === "done") {
      return (
        <p className="text-sm text-[#46d68c]">
          Done — card {which === "buy" ? "dispensed" : "returned"}
          {phase.cardNumber ? ` (account ${phase.cardNumber})` : ""}.
        </p>
      );
    }
    if (phase.step === "error") {
      return <p className="text-sm text-red-300">{phase.message}</p>;
    }
    return null;
  };

  return (
    <div className={`${cardClass} border-[#00e2e5]/30`}>
      <div className="font-semibold">Card flows (end to end)</div>
      <div className="grid gap-4 md:grid-cols-2">
        {/* BUY */}
        <div className="space-y-2 rounded-2xl border border-white/10 bg-white/[0.02] p-4">
          <div className="text-sm font-bold">Buy a card (new)</div>
          <p className="text-xs text-white/40">
            Bring a blank from the stacker to the read station, read it, then present it to the
            customer on confirm. If the presented card isn’t taken, the unit auto-retracts it to the
            error bin after a timeout — that’s normal dispenser behavior, not a fault.
          </p>
          <button
            type="button"
            className={btnPrimary}
            disabled={!!busy || flowBusy}
            onClick={() => void startBuy()}
          >
            Start buy flow
          </button>
          {renderResult(buy, "buy")}
        </div>

        {/* RELOAD */}
        <div className="space-y-2 rounded-2xl border border-white/10 bg-white/[0.02] p-4">
          <div className="text-sm font-bold">Reload a card (existing)</div>
          <p className="text-xs text-white/40">
            Permit a card in, wait for insertion, read it, then return it on confirm.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              className={btnPrimary}
              disabled={!!busy || flowBusy}
              onClick={() => void startReload()}
            >
              Start reload flow
            </button>
            {reload.step === "reading" && (
              <button type="button" className={btnGhost} onClick={() => abortRef.current?.abort()}>
                Cancel wait
              </button>
            )}
          </div>
          {renderResult(reload, "reload")}
        </div>
      </div>
    </div>
  );
}

function MagStripeCard({
  reader,
  act,
}: {
  reader: ReturnType<typeof useCardReader>;
  act: (label: string, fn: (c: CrtReaderClient) => Promise<unknown>) => void;
}) {
  const { busy, client } = reader;
  const [result, setResult] = useState<MagTracks | null>(null);

  const readMag = () =>
    act("read magnetic tracks", async (c) => {
      const tracks = await c.magRead();
      setResult(tracks);
    });

  return (
    <div className={cardClass}>
      <div className="flex items-center justify-between">
        <div className="font-semibold">Magnetic stripe (Game Zone cards)</div>
        {busy && <span className="text-xs text-amber-200">Running: {busy}…</span>}
      </div>
      <p className="text-xs text-white/40">
        Insert/motor a card past the head, then read its tracks. Flow: permit card in → the card
        transports (reading the stripe) → read tracks. Game cards only — never a payment card.
      </p>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={btnGhost}
          disabled={!!busy}
          onClick={() => act("permit card in", (c) => c.permitEntry())}
        >
          Permit card in
        </button>
        <button
          type="button"
          className={btnGhost}
          disabled={!!busy}
          onClick={() => act("stop allowing cards in", (c) => c.prohibitEntry())}
        >
          Stop allowing cards in
        </button>
        <button
          type="button"
          className={btnGhost}
          disabled={!!busy}
          onClick={() => act("move to mag position", (c) => c.moveToMagPosition())}
        >
          Move to mag position
        </button>
        <button type="button" className={btnPrimary} disabled={!!busy || !client} onClick={readMag}>
          Read magnetic tracks
        </button>
      </div>

      {result && (
        <div className="space-y-2">
          <div className="rounded-xl border border-[#00e2e5]/40 bg-[#00e2e5]/10 px-4 py-3">
            <div className="text-[10px] font-semibold uppercase tracking-widest text-[#00e2e5]/80">
              Best-guess card number
            </div>
            <div className="font-mono text-lg font-bold text-white">
              {result.cardNumber ?? "not found"}
            </div>
            {result.candidates.length > 1 && (
              <div className="mt-1 text-xs text-white/50">
                Other candidates:{" "}
                {result.candidates.filter((c) => c !== result.cardNumber).join(", ")}
              </div>
            )}
          </div>
          <div className="rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3 text-sm">
            {result.tracks.length === 0 ? (
              <div className="text-white/40">
                No track text decoded — check the raw payload below.
              </div>
            ) : (
              result.tracks.map((t, i) => (
                <InfoRow key={i} label={`Track ${i + 1}`} value={t} mono />
              ))
            )}
            <div className="mt-2 border-t border-white/10 pt-2">
              <InfoRow label="Decoded" value={result.ascii} mono />
            </div>
            <div className="mt-1">
              <InfoRow label="Raw hex" value={hexDump(result.raw)} mono />
            </div>
          </div>
          <p className="text-xs text-white/40">
            Card number = track 2’s 16-digit field. Other candidates are shown for reference.
          </p>
        </div>
      )}
    </div>
  );
}

const INIT_MODES: Array<{ value: InitMode; label: string }> = [
  { value: "leaveCard", label: "Init — leave card in place (default, non-destructive)" },
  { value: "holdCard", label: "Init — move card to gate" },
  { value: "capture", label: "Init — capture card to error bin" },
  { value: "leaveCardCounted", label: "Init — leave card + count retract" },
  { value: "holdCardCounted", label: "Init — to gate + count retract" },
  { value: "captureCounted", label: "Init — capture + count retract" },
];

function MotionCard({
  reader,
  act,
}: {
  reader: ReturnType<typeof useCardReader>;
  act: (label: string, fn: (c: CrtReaderClient) => Promise<unknown>) => void;
}) {
  const { busy } = reader;
  const [initMode, setInitMode] = useState<InitMode>("leaveCard");

  const move = (label: string, to: MoveTarget) => act(label, (c) => c.moveCard(to));

  return (
    <div className={cardClass}>
      <div className="flex items-center justify-between">
        <div className="font-semibold">Init &amp; motion</div>
        {busy && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-amber-200">Running: {busy}…</span>
            <button
              type="button"
              className={btnGhost}
              onClick={() => act("cancel", (c) => c.cancel())}
            >
              Cancel (EOT)
            </button>
          </div>
        )}
      </div>

      <div className="flex gap-2">
        <select
          className={inputClass}
          value={initMode}
          onChange={(e) => setInitMode(e.target.value as InitMode)}
        >
          {INIT_MODES.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          className={btnPrimary}
          disabled={!!busy}
          onClick={() => act(`init(${initMode})`, (c) => c.init(initMode))}
        >
          Init
        </button>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <button
          type="button"
          className={btnGhost}
          disabled={!!busy}
          onClick={() => move("move → holding", "holding")}
        >
          Move to holding
        </button>
        <button
          type="button"
          className={btnGhost}
          disabled={!!busy}
          onClick={() => move("move → IC position", "icPosition")}
        >
          Move to IC pos
        </button>
        <button
          type="button"
          className={btnGhost}
          disabled={!!busy}
          onClick={() => move("move → RF position", "rfPosition")}
        >
          Move to RF pos
        </button>
        <button
          type="button"
          className={btnPrimary}
          disabled={!!busy}
          onClick={() => act("dispense card", (c) => c.dispenseCard())}
        >
          Dispense card
        </button>
        <button
          type="button"
          className={btnGhost}
          disabled={!!busy}
          onClick={() => move("eject (out of gate)", "outOfGate")}
        >
          Eject (to gate)
        </button>
        <button
          type="button"
          className={btnGhost}
          disabled={!!busy}
          onClick={() =>
            act("capture card", async (c) => {
              // HARD rule: never move a card into a FULL bin — check st2 first,
              // refuse unless the bin reads empty.
              const bin = (await c.getStatus()).status.errorBin;
              if (bin !== "ok") {
                throw new Error(`Reject bin reads "${bin}" — empty it before capturing.`);
              }
              return c.captureCard();
            })
          }
        >
          Capture to bin
        </button>
      </div>
      <p className="text-xs text-white/40">
        Dispense = feed a blank from the stacker to the read position, then present it at the gate.
        Capture pulls the inserted card into the error bin.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function EntryWatchCard({
  reader,
  act,
}: {
  reader: ReturnType<typeof useCardReader>;
  act: (label: string, fn: (c: CrtReaderClient) => Promise<unknown>) => void;
}) {
  const { client, setPolling, busy } = reader;
  const [armed, setArmed] = useState(false);
  const [events, setEvents] = useState<string[]>([]);

  // Subscribe to the client's status stream while armed — transitions come
  // from the device (via polling responses), an external system.
  useEffect(() => {
    if (!armed || !client) return;
    let prev: string | null = null;
    return client.onStatus((s) => {
      const cur = s.card;
      const was = prev;
      prev = cur;
      if (!was || was === cur) return;
      const stamp = new Date().toLocaleTimeString();
      if (cur === "atGate")
        setEvents((e) => [`${stamp} — card detected at the gate`, ...e].slice(0, 6));
      if (cur === "atRfIcPosition")
        setEvents((e) => [`${stamp} — card carried to the RF/IC position`, ...e].slice(0, 6));
      if (cur === "none")
        setEvents((e) => [`${stamp} — card left the transport`, ...e].slice(0, 6));
    });
  }, [armed, client]);

  const toggle = () => {
    const next = !armed;
    setArmed(next);
    setEvents([]);
    if (next) setPolling(true); // watch needs live status
    act(next ? "enable entry gate" : "disable entry gate", (c) => c.setEntry(next));
  };

  return (
    <div className={cardClass}>
      <div className="flex items-center justify-between">
        <div className="font-semibold">Entry gate / insert watch</div>
        <button
          type="button"
          className={armed ? btnPrimary : btnGhost}
          disabled={!!busy}
          onClick={toggle}
        >
          {armed ? "Entry ENABLED — disable" : "Enable card entry"}
        </button>
      </div>
      <p className="text-xs text-white/40">
        With entry enabled, insert a card at the gate — the device pulls it to the RF/IC position.
        Transitions show below (polling is forced on while enabled).
      </p>
      {events.length > 0 && (
        <ul className="space-y-1 text-sm text-white/70">
          {events.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function RfMifareCard({
  act,
  busy,
}: {
  act: (label: string, fn: (c: CrtReaderClient) => Promise<unknown>) => void;
  busy: string | null;
}) {
  const [activation, setActivation] = useState<RfActivation | null>(null);
  const [key, setKey] = useState<"A" | "B">("A");
  const [keyHex, setKeyHex] = useState("FFFFFFFFFFFF");
  const [sector, setSector] = useState("1");
  const [block, setBlock] = useState("0");
  const [blocks, setBlocks] = useState("1");
  const [readHex, setReadHex] = useState<string | null>(null);
  const [writeHex, setWriteHex] = useState("");
  const [confirmWrite, setConfirmWrite] = useState(false);

  const num = (s: string, label: string) => {
    const n = parseInt(s, 10);
    if (!Number.isInteger(n) || n < 0)
      throw new RangeError(`${label} must be a non-negative number`);
    return n;
  };

  return (
    <div className={cardClass}>
      <div className="font-semibold">RF / Mifare (card at RF position)</div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={btnPrimary}
          disabled={!!busy}
          onClick={() =>
            act("RF activate", async (c) => {
              const r = await c.rfActivate("AB");
              setActivation(r.value);
            })
          }
        >
          Activate RF → read UID
        </button>
        <button
          type="button"
          className={btnGhost}
          disabled={!!busy}
          onClick={() => act("RF deactivate", (c) => c.rfDeactivate())}
        >
          Deactivate
        </button>
        <button
          type="button"
          className={btnGhost}
          disabled={!!busy}
          onClick={() =>
            act("RF status", async (c) => {
              const r = await c.rfStatus();
              setActivation((prev) =>
                prev
                  ? prev
                  : {
                      type: "unknown",
                      card:
                        r.value.card === "s50" ||
                        r.value.card === "s70" ||
                        r.value.card === "ultralight"
                          ? r.value.card
                          : null,
                      uidHex: null,
                      atqaHex: null,
                      sakHex: null,
                      atsHex: null,
                      atqbHex: null,
                    },
              );
            })
          }
        >
          RF status
        </button>
      </div>

      {activation && (
        <div className="grid grid-cols-2 gap-x-6 gap-y-1 rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3 text-sm">
          <InfoRow label="Protocol" value={activation.type} />
          <InfoRow label="Card" value={activation.card ?? "—"} />
          <InfoRow label="UID" value={activation.uidHex ?? "—"} mono />
          <InfoRow label="ATQA" value={activation.atqaHex ?? "—"} mono />
          {activation.sakHex && <InfoRow label="SAK" value={activation.sakHex} mono />}
          {activation.atsHex && <InfoRow label="ATS" value={activation.atsHex} mono />}
          {activation.atqbHex && <InfoRow label="ATQB" value={activation.atqbHex} mono />}
        </div>
      )}

      <div className="grid grid-cols-4 gap-2">
        <label className="block text-xs text-white/40">
          Key
          <select
            className={inputClass}
            value={key}
            onChange={(e) => setKey(e.target.value as "A" | "B")}
          >
            <option value="A">Key A</option>
            <option value="B">Key B</option>
          </select>
        </label>
        <label className="col-span-3 block text-xs text-white/40">
          Key hex (12 chars)
          <input
            type="text"
            data-osk="off"
            spellCheck={false}
            autoCapitalize="off"
            className={`${inputClass} font-mono`}
            value={keyHex}
            onChange={(e) => setKeyHex(e.target.value)}
          />
        </label>
        <label className="block text-xs text-white/40">
          Sector
          <input
            type="text"
            data-osk="off"
            className={inputClass}
            value={sector}
            onChange={(e) => setSector(e.target.value)}
          />
        </label>
        <label className="block text-xs text-white/40">
          Block
          <input
            type="text"
            data-osk="off"
            className={inputClass}
            value={block}
            onChange={(e) => setBlock(e.target.value)}
          />
        </label>
        <label className="block text-xs text-white/40">
          Count
          <input
            type="text"
            data-osk="off"
            className={inputClass}
            value={blocks}
            onChange={(e) => setBlocks(e.target.value)}
          />
        </label>
        <div className="flex items-end gap-2">
          <button
            type="button"
            className={btnGhost}
            disabled={!!busy}
            onClick={() =>
              act("verify key", (c) =>
                c.mifareVerifyKey({ key, sector: num(sector, "Sector"), keyHex }),
              )
            }
          >
            Verify key
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={btnPrimary}
          disabled={!!busy}
          onClick={() =>
            act("mifare read", async (c) => {
              const r = await c.mifareRead({
                sector: num(sector, "Sector"),
                block: num(block, "Block"),
                blocks: num(blocks, "Count"),
              });
              setReadHex(hexDump(r.value));
            })
          }
        >
          Read block(s)
        </button>
        {readHex !== null && (
          <span className="break-all rounded-lg bg-white/5 px-3 py-2 font-mono text-xs text-white/80">
            {readHex || "(empty)"}
          </span>
        )}
      </div>

      <div className="space-y-2">
        <label className="block text-xs text-white/40">
          Write data hex (multiples of 16 bytes; sector trailers are refused)
          <input
            type="text"
            data-osk="off"
            spellCheck={false}
            autoCapitalize="off"
            placeholder="e.g. 00 11 22 … (32 hex chars per block)"
            className={`${inputClass} font-mono`}
            value={writeHex}
            onChange={(e) => {
              setWriteHex(e.target.value);
              setConfirmWrite(false);
            }}
          />
        </label>
        <button
          type="button"
          className={confirmWrite ? btnPrimary : btnGhost}
          disabled={!!busy || !writeHex.trim()}
          onClick={() => {
            if (!confirmWrite) {
              setConfirmWrite(true);
              setTimeout(() => setConfirmWrite(false), 4000);
              return;
            }
            setConfirmWrite(false);
            act("mifare write", (c) =>
              c.mifareWrite({
                sector: num(sector, "Sector"),
                block: num(block, "Block"),
                data: parseHexBytes(writeHex),
              }),
            );
          }}
        >
          {confirmWrite ? "Tap again to CONFIRM write" : "Write block(s)…"}
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function RawConsoleCard({ reader }: { reader: ReturnType<typeof useCardReader> }) {
  const { run, busy } = reader;
  const [cm, setCm] = useState("31");
  const [pm, setPm] = useState("30");
  const [data, setData] = useState("");
  const [cls, setCls] = useState<"quick" | "cardIo" | "move" | "init">("quick");
  const [result, setResult] = useState<string | null>(null);

  const send = () =>
    void run("raw command", async (c) => {
      const frame = await c.raw(
        parseHexByte(cm, "CM"),
        parseHexByte(pm, "PM"),
        parseHexBytes(data),
        cls,
      );
      if (frame.kind === "positive") {
        setResult(
          `P st=${String.fromCharCode(frame.st.st0, frame.st.st1, frame.st.st2)}${
            frame.data.length ? ` data: ${hexDump(frame.data)}` : " (no data)"
          }`,
        );
      } else {
        setResult(`N e=${frame.code}${frame.data.length ? ` data: ${hexDump(frame.data)}` : ""}`);
      }
    });

  return (
    <div className={cardClass}>
      <div className="font-semibold">Raw command console</div>
      <p className="text-xs text-white/40">
        Sends C&nbsp;CM&nbsp;PM&nbsp;[DATA] verbatim — the probe surface for commands outside the
        M001 doc (e.g. the HB-HDN’s magstripe set once the vendor doc arrives).
      </p>
      <div className="grid grid-cols-6 gap-2">
        <label className="block text-xs text-white/40">
          CM (hex)
          <input
            type="text"
            data-osk="off"
            className={`${inputClass} font-mono`}
            value={cm}
            onChange={(e) => setCm(e.target.value)}
          />
        </label>
        <label className="block text-xs text-white/40">
          PM (hex)
          <input
            type="text"
            data-osk="off"
            className={`${inputClass} font-mono`}
            value={pm}
            onChange={(e) => setPm(e.target.value)}
          />
        </label>
        <label className="col-span-2 block text-xs text-white/40">
          DATA (hex bytes)
          <input
            type="text"
            data-osk="off"
            spellCheck={false}
            className={`${inputClass} font-mono`}
            value={data}
            onChange={(e) => setData(e.target.value)}
          />
        </label>
        <label className="block text-xs text-white/40">
          Timeout class
          <select
            className={inputClass}
            value={cls}
            onChange={(e) => setCls(e.target.value as typeof cls)}
          >
            <option value="quick">quick (2s)</option>
            <option value="cardIo">cardIo (8s)</option>
            <option value="move">move (15s)</option>
            <option value="init">init (30s)</option>
          </select>
        </label>
        <div className="flex items-end">
          <button type="button" className={btnPrimary} disabled={!!busy} onClick={send}>
            Send
          </button>
        </div>
      </div>
      {result && (
        <div className="break-all rounded-lg bg-white/5 px-3 py-2 font-mono text-xs text-white/80">
          {result}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

/** USB keyboard-wedge capture — the HB-HDN's card READ path (separate from COM). */
function WedgeCaptureCard() {
  const [armed, setArmed] = useState(false);
  const [capture, setCapture] = useState<WedgeCapture | null>(null);
  const bufRef = useRef("");
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!armed) return;
    const finish = () => {
      const raw = bufRef.current;
      bufRef.current = "";
      setArmed(false);
      if (raw.trim()) setCapture(parseWedgeBurst(raw));
    };
    const onKey = (e: KeyboardEvent) => {
      // Swallow the burst so it doesn't type into whatever has focus.
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Enter") {
        finish();
        return;
      }
      if (e.key.length === 1) bufRef.current += e.key;
      if (idleTimer.current) clearTimeout(idleTimer.current);
      // Wedges type fast — a 400ms gap after ≥4 chars means the burst ended.
      idleTimer.current = setTimeout(() => {
        if (bufRef.current.length >= 4) finish();
      }, 400);
    };
    const disarm = setTimeout(() => finish(), 15_000);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      clearTimeout(disarm);
      if (idleTimer.current) clearTimeout(idleTimer.current);
    };
  }, [armed]);

  return (
    <div className={cardClass}>
      <div className="flex items-center justify-between">
        <div className="font-semibold">USB card read (keyboard wedge)</div>
        <button
          type="button"
          className={armed ? btnPrimary : btnGhost}
          onClick={() => {
            bufRef.current = "";
            setCapture(null);
            setArmed(!armed);
          }}
        >
          {armed ? "Listening… swipe/insert now" : "Arm capture (15s)"}
        </button>
      </div>
      <p className="text-xs text-white/40">
        The HB-HDN reads cards over its USB interface, separate from the COM port. If it enumerates
        as a keyboard (wedge mode), arm this and run a card — the burst is captured and parsed here
        instead of typing into the page. Game cards only — never a payment card.
      </p>
      {capture && (
        <div className="grid grid-cols-1 gap-1 rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3 text-sm">
          <InfoRow label="Card #" value={capture.cardNumber ?? "not found"} mono />
          <InfoRow label="Track 1" value={capture.tracks.track1 ?? "—"} mono />
          <InfoRow label="Track 2" value={capture.tracks.track2 ?? "—"} mono />
          <InfoRow label="Track 3" value={capture.tracks.track3 ?? "—"} mono />
          <InfoRow label="Raw" value={capture.raw || "—"} mono />
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function ErrorBanner({
  error,
  onDismiss,
  act,
  clear,
}: {
  error: CrtErrorInfo;
  onDismiss: () => void;
  act: (label: string, fn: (c: CrtReaderClient) => Promise<unknown>) => void;
  clear: () => void;
}) {
  const tone =
    error.category === "attention" || error.category === "fatal"
      ? "border-red-400/40 bg-red-400/10"
      : "border-amber-400/40 bg-amber-400/10";
  return (
    <div className={`space-y-2 rounded-2xl border px-5 py-4 ${tone}`}>
      <div className="flex items-center justify-between">
        <div className="text-sm font-bold text-white">
          Device error <span className="font-mono">{error.code}</span> — {error.message}
        </div>
        <span className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-white/60">
          {error.category}
        </span>
      </div>
      {error.hint && <p className="text-xs text-white/70">{error.hint}</p>}
      <div className="flex gap-2">
        {(error.category === "needsInit" || error.category === "attention") && (
          <button
            type="button"
            className={btnPrimary}
            onClick={() => {
              clear();
              act("init(leaveCard)", (c) => c.init("leaveCard"));
            }}
          >
            Re-init
          </button>
        )}
        <button type="button" className={btnGhost} onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function LogCard({
  log,
  onClear,
  setMsg,
}: {
  log: readonly LogEntry[];
  onClear: () => void;
  setMsg: (m: string) => void;
}) {
  const copy = async () => {
    const text = [...log]
      .map((e) => `${e.dir.toUpperCase()} ${e.decoded}  [${hexDump(e.bytes)}]`)
      .join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setMsg("Log copied to clipboard.");
    } catch {
      setMsg("Couldn't copy — clipboard unavailable.");
    }
  };

  const newestFirst = [...log].reverse();
  return (
    <div className={cardClass}>
      <div className="flex items-center justify-between">
        <div className="font-semibold">TX / RX log</div>
        <div className="flex gap-2">
          <button type="button" className={btnGhost} onClick={copy} disabled={log.length === 0}>
            Copy
          </button>
          <button type="button" className={btnGhost} onClick={onClear} disabled={log.length === 0}>
            Clear
          </button>
        </div>
      </div>
      {log.length === 0 ? (
        <p className="text-xs text-white/40">Frames appear here as commands run — newest first.</p>
      ) : (
        <div className="max-h-80 space-y-1 overflow-y-auto">
          {newestFirst.map((e, i) => {
            const prev = newestFirst[i + 1];
            const delta = prev ? Math.round(e.t - prev.t) : 0;
            const tone =
              e.level === "error"
                ? "text-red-300"
                : e.level === "warn"
                  ? "text-amber-200"
                  : "text-white/70";
            return (
              <div key={e.id} className="rounded-lg bg-white/[0.03] px-3 py-1.5 text-xs">
                <div className={`flex items-center gap-2 ${tone}`}>
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
                      e.dir === "tx"
                        ? "bg-[#00e2e5]/20 text-[#00e2e5]"
                        : "bg-white/10 text-white/60"
                    }`}
                  >
                    {e.dir.toUpperCase()}
                  </span>
                  <span className="font-semibold">{e.decoded}</span>
                  {delta > 0 && <span className="ml-auto text-white/30">+{delta}ms</span>}
                </div>
                <div className="mt-0.5 break-all font-mono text-[10px] leading-4 text-white/40">
                  {hexDump(e.bytes)}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
