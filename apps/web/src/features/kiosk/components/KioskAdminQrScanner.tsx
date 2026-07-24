"use client";

/**
 * Hardware QR scanner setup/test panel — a tab inside the PIN-gated kiosk
 * admin, mirroring the CRT-591 tab's provisioning flow and the MSR card's
 * grant UX. The scanner (registry model — Honeywell 3320g or Posiflex 2D
 * imager, USB serial) is read-only: scans stream in as CR/LF-terminated
 * lines, so the test surface is a live scan feed — there are no commands to
 * send and no TX log.
 *
 * The unit's real baud isn't confirmed (guide says 115200 8-N-1) and a
 * read-only device can't be probed — wrong baud shows up as bytes that never
 * decode into lines. The feed flags that and staff step through the baud
 * select until scans decode; the working rate persists to qrScannerBaud.
 *
 * Grant flow mirrors the CRT-591/MSR: requestPort() is the FIRST await after
 * the tap (transient activation), pointerdown is stopped so KioskShell's
 * fullscreen handler can't spend the gesture, and a blocked chooser names
 * the blocking layer via serialBlockedMessage. With the "allow all serial"
 * policy, granted ports also appear in a pick-a-port dropdown (no chooser).
 */
import { useCallback, useEffect, useState } from "react";
import { gestureIsActive, serialBlockedMessage } from "../card-reader";
import { describePort } from "../card-reader/ports";
import type { KioskConfig } from "../config";
import {
  DEFAULT_SCANNER_MODEL_ID,
  getScannerModel,
  listScannerModels,
  useQrScanner,
  type QrScan,
} from "../qr-scanner";

const btnPrimary =
  "rounded-xl bg-[#00e2e5] px-5 py-2.5 text-sm font-bold text-[#04252b] disabled:opacity-40";
const btnGhost =
  "rounded-xl border border-white/15 px-5 py-2.5 text-sm font-bold text-white/70 disabled:opacity-40";
const cardClass = "space-y-4 rounded-2xl border border-white/10 bg-white/[0.03] p-6";
const selectClass =
  "w-full rounded-xl border border-white/15 bg-white/5 px-4 py-3 text-white [color-scheme:dark] focus:border-[#00E2E5] focus:outline-none";

const hex4 = (n: number | undefined) => (n ?? 0).toString(16).padStart(4, "0");

export function KioskAdminQrScanner({
  draft,
  persist,
  setMsg,
}: {
  draft: Partial<KioskConfig>;
  persist: (extra?: Partial<KioskConfig>) => void | Promise<unknown>;
  setMsg: (m: string) => void;
}) {
  const scanner = useQrScanner({
    // Silent grant-reuse (a fresh kiosk with no grant settles to DISCONNECTED).
    enabled: !!draft.qrScannerEnabled,
    modelId: draft.qrScannerModel,
    baudRate: draft.qrScannerBaud ?? null,
    portInfo: draft.qrScannerPortInfo ?? null,
    // Strict matching only: the CRT-591 and MSR share this origin's grants,
    // and a lone-grant guess could open (and exclusively hold) their port.
    allowLoneGrantFallback: false,
    onConnected: (info, raw) => {
      void persist({
        qrScannerEnabled: true,
        qrScannerModel: info.modelId,
        qrScannerBaud: info.baudRate,
        qrScannerPortInfo:
          raw.usbVendorId != null
            ? { usbVendorId: raw.usbVendorId, usbProductId: raw.usbProductId }
            : null,
      });
    },
  });

  const { connection, model } = scanner;
  const listening = connection.state === "listening";
  const savedModelUnknown = !!draft.qrScannerModel && !getScannerModel(draft.qrScannerModel);

  return (
    <div className="space-y-4">
      <ModelCard draft={draft} persist={persist} savedModelUnknown={savedModelUnknown} />
      <ConnectionCard scanner={scanner} draft={draft} />
      <ScanFeedCard scanner={scanner} setMsg={setMsg} />
      {(listening || draft.qrScannerEnabled) && (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={btnGhost}
            onClick={() => {
              void scanner.disconnect();
              void persist({ qrScannerEnabled: false });
              setMsg("QR scanner disabled on this kiosk — the grant is kept for re-enabling.");
            }}
          >
            Disable scanner on this kiosk
          </button>
          <button
            type="button"
            className={btnGhost}
            onClick={() => {
              void scanner.forgetSavedPort().then(() => {
                void persist({ qrScannerEnabled: false, qrScannerPortInfo: null });
                setMsg("Saved port forgotten — grant it again to reconnect.");
              });
            }}
          >
            Forget saved port
          </button>
        </div>
      )}
      <p className="text-xs text-white/40">
        This is the serial (COM) QR scanner — model {model.label}. The keyboard-wedge “QR / barcode
        scanner” toggle on the Device tab is a different device and is unaffected.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function ModelCard({
  draft,
  persist,
  savedModelUnknown,
}: {
  draft: Partial<KioskConfig>;
  persist: (extra?: Partial<KioskConfig>) => void | Promise<unknown>;
  savedModelUnknown: boolean;
}) {
  const model = getScannerModel(draft.qrScannerModel) ?? getScannerModel(DEFAULT_SCANNER_MODEL_ID)!;
  const baud = draft.qrScannerBaud ?? model.defaultBaudRate;
  return (
    <div className={cardClass}>
      <div className="font-semibold">Scanner model &amp; line settings</div>
      {savedModelUnknown && (
        <p className="rounded-xl border border-amber-400/40 bg-amber-400/10 px-4 py-3 text-xs text-amber-200">
          Saved model “{draft.qrScannerModel}” isn’t in this build — using {model.label}. (A newer
          build likely saved it; connecting again re-saves the current model.)
        </p>
      )}
      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="mb-1 block text-xs font-semibold uppercase tracking-widest text-white/40">
            Model
          </span>
          <select
            className={selectClass}
            value={model.id}
            onChange={(e) =>
              // A model switch resets to that model's default baud.
              void persist({ qrScannerModel: e.target.value, qrScannerBaud: null })
            }
          >
            {listScannerModels().map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-semibold uppercase tracking-widest text-white/40">
            Baud rate
          </span>
          <select
            className={selectClass}
            value={baud}
            onChange={(e) => void persist({ qrScannerBaud: Number(e.target.value) })}
          >
            {model.baudCandidates.map((rate) => (
              <option key={rate} value={rate}>
                {rate}
                {rate === model.defaultBaudRate ? " (model default)" : ""}
              </option>
            ))}
          </select>
        </label>
      </div>
      {model.notes && <p className="text-xs text-white/40">{model.notes}</p>}
      <p className="text-xs text-white/40">
        Changing the rate while connected re-opens the port at the new speed — scan a test code
        after each change. If the feed shows the wrong-baud warning (or nothing), step to the next
        rate and scan again; the working rate saves automatically.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function ConnectionCard({
  scanner,
  draft,
}: {
  scanner: ReturnType<typeof useQrScanner>;
  draft: Partial<KioskConfig>;
}) {
  const { connection, model, connectPort, disconnect } = scanner;
  const [permMsg, setPermMsg] = useState<string | null>(null);

  // Granted COM ports (no chooser once the "allow all serial" policy is set).
  // Pick one → open it at the selected baud → onConnected saves it; a scan in
  // the feed below is the proof it's the scanner (and the right rate).
  const [grantedPorts, setGrantedPorts] = useState<SerialPort[]>([]);
  const refreshPorts = useCallback(async () => {
    if (typeof navigator === "undefined" || !("serial" in navigator)) return;
    setGrantedPorts(await navigator.serial.getPorts().catch(() => [] as SerialPort[]));
  }, []);
  useEffect(() => {
    void refreshPorts();
  }, [refreshPorts]);

  /** The provisioning near-miss: picking the CRT-591's or MSR's port. */
  const otherDeviceWarning = (info: SerialPortInfo): string | null => {
    if (info.usbVendorId == null) return null;
    if (info.usbVendorId === draft.cardReaderPortInfo?.usbVendorId) {
      return "that looks like the CRT-591 card reader's port — pick the scanner's COM port instead.";
    }
    if (info.usbVendorId === draft.msrPortInfo?.usbVendorId) {
      return "that looks like the MSR swipe reader's port — pick the scanner's COM port instead.";
    }
    return null;
  };

  const tryPort = (i: number) => {
    const port = grantedPorts[i];
    if (!port) return;
    const warn = otherDeviceWarning(port.getInfo());
    setPermMsg(warn ? `Heads up — ${warn}` : "Opening the selected port…");
    void connectPort(port).then((ok) => {
      if (ok && !warn) setPermMsg(null);
      else if (!ok) setPermMsg("That port didn’t open — pick another, then scan a code to verify.");
    });
  };

  const grantAndListen = async () => {
    if (typeof navigator === "undefined" || !("serial" in navigator)) {
      setPermMsg("Web Serial isn't available here — it needs desktop Chrome/Edge on HTTPS.");
      return;
    }
    setPermMsg(null);
    const gestureActive = gestureIsActive();
    let port: SerialPort;
    try {
      // FIRST await after the tap — see the header comment.
      port = await navigator.serial.requestPort();
    } catch (err) {
      const name = err instanceof DOMException ? err.name : "";
      setPermMsg(
        name === "SecurityError"
          ? serialBlockedMessage(err, { gestureActive })
          : name === "NotFoundError"
            ? "No port was picked — or none exist. Check the scanner's USB lead and that a COM port shows in Device Manager → Ports (COM & LPT). If the scanner types into text fields instead, it's in keyboard mode — scan the USB-serial programming barcode."
            : `Permission request failed${err instanceof Error && err.message ? ` — ${err.message}` : ""}`,
      );
      return;
    }
    const warn = otherDeviceWarning(port.getInfo());
    if (warn) setPermMsg(`Heads up — ${warn}`);
    const ok = await connectPort(port);
    if (ok && !warn) setPermMsg(null);
    void refreshPorts();
  };

  const stateChip =
    connection.state === "listening"
      ? { text: "LISTENING", cls: "bg-[#46d68c]/20 text-[#46d68c]" }
      : connection.state === "connecting"
        ? { text: "CONNECTING…", cls: "bg-amber-400/20 text-amber-200" }
        : connection.state === "error"
          ? { text: "ERROR", cls: "bg-red-400/20 text-red-300" }
          : connection.state === "unsupported"
            ? { text: "UNSUPPORTED", cls: "bg-white/10 text-white/50" }
            : { text: "DISCONNECTED", cls: "bg-white/10 text-white/50" };

  const saved = draft.qrScannerPortInfo;
  const savedLine = draft.qrScannerEnabled
    ? `baud ${draft.qrScannerBaud ?? model.defaultBaudRate} · ${
        saved?.usbVendorId != null
          ? `USB ${hex4(saved.usbVendorId)}:${hex4(saved.usbProductId)}`
          : "native COM (no USB id — silent reconnect can't match it; re-pick after reloads)"
      }`
    : null;

  // Expected-vs-actual USB ids — the confirm-the-VID-off-the-real-unit surface.
  const idDiagnostic = (() => {
    if (connection.state !== "listening") return null;
    const info = connection.info;
    if (info.usbVendorId == null) {
      return {
        tone: "amber" as const,
        text: "This port reports no USB ids (native COM) — silent reconnect can't match it, so the port needs re-picking after a reload. Expected a USB-CDC device.",
      };
    }
    const matches = model.expectedUsbIds.some(
      (e) =>
        e.usbVendorId === info.usbVendorId &&
        (e.usbProductId == null || e.usbProductId === info.usbProductId),
    );
    if (!matches) {
      return {
        tone: "amber" as const,
        text: `USB ids differ from the registry's expected ${model.expectedUsbIds
          .map((e) => hex4(e.usbVendorId))
          .join(
            "/",
          )} — if scans decode below, this unit's real ids are the ones shown; record them in qr-scanner/models.ts (expectedUsbIds) and docs/qr-scanner/README.md.`,
      };
    }
    if (!model.usbIdsConfirmed) {
      return {
        tone: "info" as const,
        text: `USB ids match the registry's expected VID for the ${model.label} — once scans decode, flip usbIdsConfirmed in qr-scanner/models.ts and note it in docs/qr-scanner/README.md.`,
      };
    }
    return null;
  })();

  return (
    <div className={cardClass}>
      <div className="flex items-center justify-between">
        <div className="font-semibold">Scanner connection (COM / Web Serial)</div>
        <span className={`rounded-full px-3 py-1 text-xs font-bold ${stateChip.cls}`}>
          {stateChip.text}
        </span>
      </div>

      {savedLine && connection.state !== "listening" && (
        <div className="rounded-xl border border-white/10 bg-white/[0.02] px-4 py-2 text-xs text-white/50">
          Saved for reconnect: {savedLine}
        </div>
      )}

      {connection.state === "unsupported" && (
        <p className="text-sm text-amber-300">
          Web Serial isn’t available in this browser. It needs desktop <b>Chrome or Edge</b> on an{" "}
          <b>HTTPS</b> page (production is HTTPS — if you’re on an{" "}
          <code className="rounded bg-white/10 px-1">http://</code> URL, that’s why). Not Safari,
          Firefox, or mobile. It can also be turned off by device-management policy — see
          docs/qr-scanner/README.md.
        </p>
      )}

      {connection.state === "error" && <p className="text-sm text-red-300">{connection.message}</p>}

      {connection.state === "listening" && (
        <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
          <InfoRow label="Model" value={model.label} />
          <InfoRow label="Baud" value={String(connection.info.baudRate)} />
          <InfoRow
            label="Port"
            value={
              connection.info.usbVendorId != null
                ? `USB ${hex4(connection.info.usbVendorId)}:${hex4(connection.info.usbProductId)}`
                : "native COM (no USB ids)"
            }
            mono
          />
        </div>
      )}

      {idDiagnostic && (
        <p
          className={`rounded-xl border px-4 py-3 text-xs ${
            idDiagnostic.tone === "amber"
              ? "border-amber-400/40 bg-amber-400/10 text-amber-200"
              : "border-white/10 bg-white/[0.02] text-white/55"
          }`}
        >
          {idDiagnostic.text}
        </p>
      )}

      {connection.state !== "listening" && connection.state !== "connecting" && (
        <>
          {grantedPorts.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-xs font-semibold uppercase tracking-widest text-white/40">
                Granted COM ports — pick the scanner to connect &amp; save
              </div>
              <div className="flex gap-2">
                <select
                  className={selectClass}
                  defaultValue=""
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
                  className={`shrink-0 ${btnGhost}`}
                  onClick={() => void refreshPorts()}
                >
                  Refresh
                </button>
              </div>
              <p className="text-xs text-white/40">
                No chooser needed with the “allow all serial” policy. The {model.label} is expected
                as USB {model.expectedUsbIds.map((e) => hex4(e.usbVendorId)).join("/")}
                {model.usbIdsConfirmed ? "" : " (not yet confirmed on hardware)"}; ports already
                saved by the card reader or MSR are the OTHER devices — don’t pick those.
              </p>
            </div>
          )}
          <button
            type="button"
            className={btnPrimary}
            disabled={connection.state === "unsupported"}
            // Keep KioskShell's document-level fullscreen handler from spending
            // this tap's transient activation before requestPort() runs.
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => void grantAndListen()}
          >
            Grant COM port &amp; listen…
          </button>
          <p className="text-xs text-white/40">
            Pick the scanner’s COM port in the chooser — choosing it IS the permission grant, and it
            saves to this kiosk’s setup automatically. The kiosk reconnects silently on every boot
            after this one-time grant.
          </p>
        </>
      )}

      {connection.state === "listening" && (
        <button type="button" className={btnGhost} onClick={() => void disconnect()}>
          Disconnect
        </button>
      )}

      {permMsg && <p className="text-sm text-white/60">{permMsg}</p>}
    </div>
  );
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

function ScanFeedCard({
  scanner,
  setMsg,
}: {
  scanner: ReturnType<typeof useQrScanner>;
  setMsg: (m: string) => void;
}) {
  const { scans, scanCount, rxBytes, clearScans, connection } = scanner;
  const listening = connection.state === "listening";
  const wrongBaudLikely = listening && rxBytes > 0 && scanCount === 0;

  const copyAll = async () => {
    const text = [...scans].map((s) => `${new Date(s.at).toISOString()}  ${s.payload}`).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setMsg("Scan feed copied to clipboard.");
    } catch {
      setMsg("Couldn't copy — clipboard unavailable.");
    }
  };
  const copyOne = async (scan: QrScan) => {
    try {
      await navigator.clipboard.writeText(scan.payload);
      setMsg("Scan payload copied.");
    } catch {
      setMsg("Couldn't copy — clipboard unavailable.");
    }
  };

  const newestFirst = [...scans].reverse();
  return (
    <div className={cardClass}>
      <div className="flex items-center justify-between">
        <div className="font-semibold">
          Scan feed{" "}
          <span className="text-xs font-normal text-white/40">
            {scanCount} scan{scanCount === 1 ? "" : "s"} · {rxBytes} bytes rx
          </span>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            className={btnGhost}
            onClick={() => void copyAll()}
            disabled={scans.length === 0}
          >
            Copy
          </button>
          <button
            type="button"
            className={btnGhost}
            onClick={clearScans}
            disabled={scanCount === 0}
          >
            Clear
          </button>
        </div>
      </div>

      {wrongBaudLikely && (
        <p className="rounded-xl border border-amber-400/40 bg-amber-400/10 px-4 py-3 text-xs text-amber-200">
          Data is arriving ({rxBytes} bytes) but nothing decodes into scan lines — the baud rate is
          probably wrong. Pick the next rate above and scan again. (It can also mean the scanner has
          no CR/LF suffix programmed — suffix 990D0A.)
        </p>
      )}

      {scans.length === 0 ? (
        <p className="text-xs text-white/40">
          {listening
            ? "Point the scanner at a code and pull the trigger — scans stream in here, newest first. Nothing at all? Check it's in USB serial (CDC) mode, not keyboard mode, and that this is its COM port."
            : "Connect the scanner above, then scan a test code — payloads appear here, newest first."}
        </p>
      ) : (
        <div className="max-h-80 space-y-1 overflow-y-auto">
          {newestFirst.map((s, i) => {
            const prev = newestFirst[i + 1];
            const delta = prev ? s.at - prev.at : 0;
            return (
              <div key={s.id} className="rounded-lg bg-white/[0.03] px-3 py-1.5 text-xs">
                <div className="flex items-center gap-2 text-white/70">
                  <span className="rounded bg-[#00e2e5]/20 px-1.5 py-0.5 text-[10px] font-bold text-[#00e2e5]">
                    #{s.id}
                  </span>
                  <span>{new Date(s.at).toLocaleTimeString()}</span>
                  {delta > 0 && <span className="text-white/30">+{delta}ms</span>}
                  <button
                    type="button"
                    className="ml-auto rounded border border-white/15 px-2 py-0.5 text-[10px] font-bold text-white/60"
                    onClick={() => void copyOne(s)}
                  >
                    Copy
                  </button>
                </div>
                <div className="mt-0.5 break-all font-mono text-[11px] leading-4 text-white/80">
                  {s.payload}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
