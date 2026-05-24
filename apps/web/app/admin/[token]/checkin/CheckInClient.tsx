"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { modalBackdropProps } from "@/lib/a11y";

// --------------- Types ---------------

type ConnectionState = "idle" | "connecting" | "ready" | "error";
type ScanState = "idle" | "processing" | "result";

interface CheckinResponse {
  success: boolean;
  checkinError?: string | null;
  guest: { firstName: string; lastName: string; pictureUrl: string | null } | null;
  session: {
    track: string | null;
    raceType: string | null;
    heatNumber: number | null;
    scheduledStart: string | null;
  };
  currentlyCheckingIn: boolean;
  headsock: { detected: boolean; deducted: boolean; balance: number };
}

const TRACK_COLORS: Record<string, string> = {
  blue: "#004AAD",
  red: "#E53935",
  mega: "#8B5CF6",
};
const WARNING_COLOR = "#F59E0B";
const ERROR_COLOR = "#F59E0B";
const FLASH_DURATION = 4000;
const BAUD_RATES = [9600, 19200, 38400, 115200] as const;

// --------------- Component ---------------

interface Props {
  token: string;
  version: string;
}

export default function CheckInClient({ token, version }: Props) {
  // Serial port state
  const [connectionState, setConnectionState] = useState<ConnectionState>("idle");
  const [portName, setPortName] = useState<string>("");
  const [connectionError, setConnectionError] = useState<string>("");
  const portRef = useRef<SerialPort | null>(null);
  const readerRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);
  const bufferRef = useRef("");

  // Scan state
  const [scanState, setScanState] = useState<ScanState>("idle");
  const [lastResult, setLastResult] = useState<CheckinResponse | null>(null);
  const [lastError, setLastError] = useState<string>("");
  const [lastRaw, setLastRaw] = useState<string>("");
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Settings
  const [baudRate, setBaudRate] = useState<number>(() => {
    if (typeof window === "undefined") return 9600;
    const saved = localStorage.getItem("checkin-scanner-baud");
    return saved ? Number(saved) : 9600;
  });
  const [showSettings, setShowSettings] = useState(false);

  // Test mode
  const [testMode, setTestMode] = useState(false);
  const [testInput, setTestInput] = useState("");
  const [debugJson, setDebugJson] = useState<string>("");
  const [showDebug, setShowDebug] = useState(false);

  // Self-test
  const [selfTestResult, setSelfTestResult] = useState<{
    tests: { name: string; pass: boolean; ms: number; detail?: string }[];
    allPassed: boolean;
  } | null>(null);
  const [showSelfTest, setShowSelfTest] = useState(false);

  // Live session status — polled every 10s via admin endpoint (calls Pandora directly for checkedIn counts)
  interface TrackSession {
    track: string;
    raceType: string;
    heatNumber: number;
    sessionId: number;
    scheduledStart: string;
    checkedIn: number;
    total: number;
  }
  const [activeSessions, setActiveSessions] = useState<TrackSession[]>([]);

  useEffect(() => {
    let mounted = true;
    async function poll() {
      try {
        const res = await fetch(
          `/api/admin/checkin?token=${encodeURIComponent(token)}&action=session-stats`,
          { cache: "no-store" },
        );
        if (!res.ok || !mounted) return;
        const data = await res.json();
        if (mounted && Array.isArray(data?.sessions)) setActiveSessions(data.sessions);
      } catch {
        /* silent */
      }
    }
    poll();
    const iv = setInterval(poll, 10_000);
    return () => {
      mounted = false;
      clearInterval(iv);
    };
  }, [token]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("test") === "1") setTestMode(true);
  }, []);

  // --------------- Serial Port ---------------

  const disconnect = useCallback(async () => {
    try {
      if (readerRef.current) {
        await readerRef.current.cancel().catch(() => {});
        readerRef.current = null;
      }
      if (portRef.current) {
        await portRef.current.close().catch(() => {});
        portRef.current = null;
      }
    } catch {
      // ignore cleanup errors
    }
    setConnectionState("idle");
    setPortName("");
  }, []);

  const startReading = useCallback(
    async (port: SerialPort) => {
      if (!port.readable) return;
      const reader = port.readable.getReader();
      readerRef.current = reader;
      const decoder = new TextDecoder();

      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          const text = decoder.decode(value);
          bufferRef.current += text;

          // Check for line terminator
          let newlineIdx: number;
          while ((newlineIdx = bufferRef.current.search(/[\r\n]/)) !== -1) {
            const line = bufferRef.current.slice(0, newlineIdx).trim();
            bufferRef.current = bufferRef.current.slice(newlineIdx + 1);
            if (line) handleScan(line);
          }
        }
      } catch (e) {
        if (e instanceof Error && e.name !== "CancelError") {
          setConnectionError(e.message);
          setConnectionState("error");
        }
      } finally {
        reader.releaseLock();
        readerRef.current = null;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [token],
  );

  const connectToPort = useCallback(
    async (port: SerialPort) => {
      setConnectionState("connecting");
      setConnectionError("");
      try {
        await port.open({ baudRate });
        portRef.current = port;
        const info = port.getInfo();
        setPortName(
          info.usbVendorId
            ? `USB ${info.usbVendorId.toString(16)}:${info.usbProductId?.toString(16) ?? "?"}`
            : "Serial Port",
        );
        setConnectionState("ready");
        startReading(port);
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Connection failed";
        if (msg.includes("already open") || msg.includes("NetworkError")) {
          setConnectionError("Scanner is in use by another tab. Close the other tab first.");
        } else {
          setConnectionError(msg);
        }
        setConnectionState("error");
      }
    },
    [baudRate, startReading],
  );

  // Auto-connect on mount
  useEffect(() => {
    if (!("serial" in navigator)) return;
    (async () => {
      try {
        const ports = await navigator.serial.getPorts();
        if (ports.length > 0) {
          await connectToPort(ports[0]);
        }
      } catch {
        // no previously authorized ports
      }
    })();
    return () => {
      disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function requestPort() {
    if (!("serial" in navigator)) {
      setConnectionError("Web Serial API not supported in this browser. Use Edge or Chrome.");
      setConnectionState("error");
      return;
    }
    try {
      const port = await navigator.serial.requestPort();
      await connectToPort(port);
    } catch (e) {
      if (e instanceof Error && e.name !== "NotFoundError") {
        setConnectionError(e.message);
        setConnectionState("error");
      }
    }
  }

  // --------------- Scan Handling ---------------

  async function handleScan(raw: string) {
    if (scanState === "processing") return;
    setLastRaw(raw);
    setScanState("processing");
    setLastResult(null);
    setLastError("");

    try {
      const res = await fetch(`/api/admin/checkin?token=${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ raw }),
        cache: "no-store",
      });
      const json = await res.json();
      setDebugJson(JSON.stringify({ request: { raw }, response: json }, null, 2));

      if (!res.ok) {
        setLastError(json.detail || json.error || `HTTP ${res.status}`);
        setScanState("result");
      } else {
        setLastResult(json as CheckinResponse);
        setScanState("result");
      }
    } catch (e) {
      setLastError(e instanceof Error ? e.message : "Network error");
      setScanState("result");
    }

    // Auto-dismiss after FLASH_DURATION
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    flashTimerRef.current = setTimeout(() => {
      setScanState("idle");
      setLastResult(null);
      setLastError("");
    }, FLASH_DURATION);
  }

  // Test mode scan
  function handleTestScan() {
    if (!testInput.trim()) return;
    handleScan(testInput.trim());
    setTestInput("");
  }

  // Preview flash (no API call)
  function previewFlash(color: string, label: string) {
    setLastResult({
      success: true,
      guest: { firstName: "PREVIEW", lastName: label.toUpperCase(), pictureUrl: null },
      session: {
        track: label.toLowerCase(),
        raceType: "Preview",
        heatNumber: 0,
        scheduledStart: null,
      },
      currentlyCheckingIn: true,
      headsock: { detected: false, deducted: false, balance: 0 },
    });
    setLastError("");
    setScanState("result");
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    flashTimerRef.current = setTimeout(() => {
      setScanState("idle");
      setLastResult(null);
    }, FLASH_DURATION);
  }

  // Self-test
  async function runSelfTest() {
    try {
      const res = await fetch(`/api/admin/checkin?token=${encodeURIComponent(token)}&selftest=1`);
      const json = await res.json();
      setSelfTestResult(json);
      setShowSelfTest(true);
    } catch (e) {
      setSelfTestResult({
        tests: [
          { name: "fetch", pass: false, ms: 0, detail: e instanceof Error ? e.message : "Unknown" },
        ],
        allPassed: false,
      });
      setShowSelfTest(true);
    }
  }

  // --------------- Flash Color ---------------

  const SUCCESS_COLOR = "#16A34A";

  function getFlashColor(): string {
    if (lastError) return ERROR_COLOR;
    if (!lastResult) return ERROR_COLOR;
    if (!lastResult.currentlyCheckingIn) return WARNING_COLOR;
    return SUCCESS_COLOR;
  }

  function getTrackTextColor(): string {
    const track = lastResult?.session.track?.toLowerCase() ?? "";
    return TRACK_COLORS[track] ?? "#FFFFFF";
  }

  // --------------- Render: Flash Result ---------------

  if (scanState === "result") {
    const bg = getFlashColor();
    const isWarning = bg === WARNING_COLOR;
    const hasHeadsock = lastResult?.headsock?.detected ?? false;

    return (
      <div
        className="fixed inset-0 z-50 flex flex-col items-center justify-center px-6 transition-colors"
        style={{ backgroundColor: bg }}
        {...modalBackdropProps(() => {
          setScanState("idle");
          setLastResult(null);
          setLastError("");
          if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
        })}
      >
        {/* Headsock banner — full-width, impossible to miss */}
        {hasHeadsock && (
          <div className="absolute top-0 left-0 right-0 bg-amber-400 py-6 sm:py-8 px-6 text-center border-b-4 border-amber-600">
            <p
              className="text-black font-black uppercase tracking-wider leading-none"
              style={{ fontSize: "clamp(36px, 8vw, 64px)" }}
            >
              Headsock Due
            </p>
            <p className="text-black/80 text-lg sm:text-xl font-bold mt-2 uppercase">
              Hand guest a headsock
            </p>
          </div>
        )}

        {/* Warning banner — session not checking in, show their booked session so staff can redirect */}
        {isWarning && !lastError && lastResult?.guest && (
          <div className="absolute top-0 left-0 right-0 bg-amber-500 py-4 px-6 text-center">
            <p className="text-black font-bold text-lg uppercase">Not checking in yet</p>
            {lastResult.session.track && (
              <p className="text-black/80 text-base font-semibold mt-1">
                Their session: {lastResult.session.track} {lastResult.session.raceType}{" "}
                {lastResult.session.heatNumber ? `Heat ${lastResult.session.heatNumber}` : ""}
                {lastResult.session.scheduledStart && (
                  <>
                    {" "}
                    —{" "}
                    {new Date(lastResult.session.scheduledStart).toLocaleTimeString("en-US", {
                      hour: "numeric",
                      minute: "2-digit",
                      timeZone: "America/New_York",
                    })}
                  </>
                )}
              </p>
            )}
          </div>
        )}

        {lastError ? (
          <>
            <svg
              className="w-20 h-20 text-white/80 mb-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
            <p
              className="text-white font-black uppercase text-center"
              style={{ fontSize: "clamp(36px, 8vw, 56px)" }}
            >
              Check-In Failed
            </p>
            <p className="text-white/80 text-lg text-center mt-2 max-w-md">{lastError}</p>
            {lastRaw && <p className="text-white/40 text-xs mt-4 font-mono">{lastRaw}</p>}
          </>
        ) : lastResult?.guest ? (
          <>
            {/* Guest picture placeholder */}
            <div
              className="rounded-full border-4 border-white/30 bg-white/10 flex items-center justify-center mb-6 overflow-hidden"
              style={{ width: 240, height: 240 }}
            >
              {lastResult.guest.pictureUrl ? (
                <img
                  src={lastResult.guest.pictureUrl}
                  alt=""
                  className="w-full h-full rounded-full object-cover"
                />
              ) : (
                <svg className="w-16 h-16 text-white/40" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" />
                </svg>
              )}
            </div>

            {/* Guest name */}
            <p
              className="text-white font-black uppercase text-center leading-tight"
              style={{ fontSize: "clamp(48px, 12vw, 80px)" }}
            >
              {lastResult.guest.firstName} {lastResult.guest.lastName}
            </p>

            {/* Session info — track color text */}
            {lastResult.session.track && (
              <p
                className="font-bold uppercase text-center mt-2"
                style={{ fontSize: "clamp(28px, 6vw, 44px)", color: getTrackTextColor() }}
              >
                {lastResult.session.track} {lastResult.session.raceType}{" "}
                {lastResult.session.heatNumber ? `Heat ${lastResult.session.heatNumber}` : ""}
              </p>
            )}

            {/* Check mark */}
            {lastResult.success && (
              <svg
                className="w-16 h-16 text-white/60 mt-6"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={3}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            )}
          </>
        ) : (
          <>
            <p
              className="text-white font-black uppercase text-center"
              style={{ fontSize: "clamp(36px, 8vw, 56px)" }}
            >
              Guest Not Found
            </p>
            <p className="text-white/60 text-sm mt-2 font-mono">{lastRaw}</p>
          </>
        )}

        <p className="absolute bottom-6 text-white/30 text-xs">Tap to dismiss</p>
      </div>
    );
  }

  // --------------- Render: Idle / Ready ---------------

  const serialSupported = typeof window !== "undefined" && "serial" in navigator;

  return (
    <div className="min-h-screen bg-[#0A0A0A] text-white flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-white/10">
        <div>
          <h1 className="text-lg font-bold">Race Check-In</h1>
          <p className="text-white/40 text-xs">v{version}</p>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={runSelfTest}
            className="px-3 py-1.5 rounded-lg border border-white/20 text-white/60 text-xs hover:bg-white/5"
          >
            Run Self-Test
          </button>
          <button
            type="button"
            aria-label="Settings"
            onClick={() => setShowSettings(!showSettings)}
            className="p-2 rounded-lg border border-white/20 text-white/60 hover:bg-white/5"
          >
            <svg
              className="w-4 h-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
              />
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
              />
            </svg>
          </button>
        </div>
      </div>

      {/* Active sessions — check-in counts */}
      {activeSessions.length > 0 && (
        <div className="flex gap-3 px-6 py-3 border-b border-white/10 overflow-x-auto">
          {activeSessions.map((s) => {
            const color = TRACK_COLORS[s.track] ?? "#00E2E5";
            return (
              <div
                key={s.sessionId}
                className="flex items-center gap-3 rounded-xl px-4 py-2.5 shrink-0"
                style={{ backgroundColor: `${color}15`, border: `1px solid ${color}40` }}
              >
                <div>
                  <p className="text-xs font-bold uppercase" style={{ color }}>
                    {s.track} {s.raceType} {s.heatNumber ? `#${s.heatNumber}` : ""}
                  </p>
                  {s.scheduledStart && (
                    <p className="text-white/40 text-[10px]">
                      {new Date(s.scheduledStart).toLocaleTimeString("en-US", {
                        hour: "numeric",
                        minute: "2-digit",
                        timeZone: "America/New_York",
                      })}
                    </p>
                  )}
                </div>
                <div className="text-right">
                  <p className="text-white font-black text-xl leading-none">
                    {s.checkedIn}
                    <span className="text-white/40 text-sm font-normal">/{s.total}</span>
                  </p>
                  <p className="text-white/40 text-[10px] uppercase">checked in</p>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Settings dropdown */}
      {showSettings && (
        <div className="px-6 py-4 border-b border-white/10 bg-white/5">
          <p className="block text-white/60 text-xs mb-2">Baud Rate</p>
          <div className="flex gap-2">
            {BAUD_RATES.map((rate) => (
              <button
                key={rate}
                type="button"
                onClick={() => {
                  setBaudRate(rate);
                  localStorage.setItem("checkin-scanner-baud", String(rate));
                }}
                className={`px-3 py-1.5 rounded-lg text-xs border ${
                  baudRate === rate
                    ? "border-cyan-400 bg-cyan-400/20 text-cyan-300"
                    : "border-white/20 text-white/40 hover:bg-white/5"
                }`}
              >
                {rate}
              </button>
            ))}
          </div>
          <p className="text-white/30 text-xs mt-2">
            Disconnect and reconnect after changing baud rate.
          </p>
        </div>
      )}

      {/* Main content */}
      <div className="flex-1 flex flex-col items-center justify-center px-6">
        {!serialSupported ? (
          <div className="text-center">
            <p className="text-red-400 text-lg font-bold">Web Serial API Not Available</p>
            <p className="text-white/40 text-sm mt-2">
              Use Microsoft Edge or Google Chrome on desktop.
            </p>
          </div>
        ) : connectionState === "idle" ? (
          <div className="text-center">
            <button
              type="button"
              onClick={requestPort}
              className="px-8 py-4 rounded-2xl bg-cyan-500 hover:bg-cyan-400 text-black font-bold text-lg transition-colors"
            >
              Connect Scanner
            </button>
            <p className="text-white/30 text-sm mt-4">Click to select your serial QR scanner</p>
          </div>
        ) : connectionState === "connecting" ? (
          <div className="text-center">
            <div className="w-8 h-8 border-2 border-cyan-400 border-t-transparent rounded-full animate-spin mx-auto" />
            <p className="text-white/50 text-sm mt-4">Connecting...</p>
          </div>
        ) : connectionState === "error" ? (
          <div className="text-center max-w-md">
            <p className="text-red-400 text-lg font-bold">Connection Error</p>
            <p className="text-white/50 text-sm mt-2">{connectionError}</p>
            <button
              type="button"
              onClick={requestPort}
              className="mt-4 px-6 py-2.5 rounded-xl bg-white/10 hover:bg-white/15 text-white/80 text-sm font-medium transition-colors"
            >
              Try Again
            </button>
          </div>
        ) : (
          /* Ready state */
          <div className="text-center">
            <div className="flex items-center justify-center gap-2 mb-6">
              <div className="w-3 h-3 rounded-full bg-emerald-400 animate-pulse" />
              <span className="text-emerald-400 text-sm font-medium">Connected — {portName}</span>
              <button
                type="button"
                onClick={disconnect}
                className="text-white/30 text-xs underline ml-2 hover:text-white/50"
              >
                Disconnect
              </button>
            </div>
            <p
              className="text-white/20 font-bold uppercase tracking-widest"
              style={{ fontSize: "clamp(24px, 5vw, 40px)" }}
            >
              Waiting for scan...
            </p>
            {scanState === "processing" && (
              <div className="mt-6">
                <div className="w-8 h-8 border-2 border-cyan-400 border-t-transparent rounded-full animate-spin mx-auto" />
              </div>
            )}
          </div>
        )}
      </div>

      {/* Test mode panel */}
      {testMode && (
        <div className="border-t border-white/10 bg-white/5 px-6 py-4">
          <div className="flex items-center justify-between mb-3">
            <p className="text-amber-400 text-xs font-bold uppercase tracking-wider">Test Mode</p>
          </div>

          {/* Manual scan input */}
          <div className="flex gap-2 mb-3">
            <input
              type="text"
              value={testInput}
              onChange={(e) => setTestInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleTestScan();
              }}
              placeholder="FT:personId:sessionId"
              className="flex-1 px-3 py-2 rounded-lg bg-black/50 border border-white/20 text-white text-sm placeholder-white/20 focus:outline-none focus:border-cyan-400"
            />
            <button
              type="button"
              onClick={handleTestScan}
              className="px-4 py-2 rounded-lg bg-cyan-500 text-black font-bold text-sm"
            >
              Simulate Scan
            </button>
          </div>

          {/* Preview flash buttons */}
          <div className="flex flex-wrap gap-2 mb-3">
            <button
              type="button"
              onClick={() => previewFlash(TRACK_COLORS.blue, "Blue")}
              className="px-3 py-1.5 rounded text-xs font-bold text-white"
              style={{ backgroundColor: TRACK_COLORS.blue }}
            >
              Preview Blue
            </button>
            <button
              type="button"
              onClick={() => previewFlash(TRACK_COLORS.red, "Red")}
              className="px-3 py-1.5 rounded text-xs font-bold text-white"
              style={{ backgroundColor: TRACK_COLORS.red }}
            >
              Preview Red
            </button>
            <button
              type="button"
              onClick={() => previewFlash(TRACK_COLORS.mega, "Mega")}
              className="px-3 py-1.5 rounded text-xs font-bold text-white"
              style={{ backgroundColor: TRACK_COLORS.mega }}
            >
              Preview Purple
            </button>
            <button
              type="button"
              onClick={() => previewFlash(WARNING_COLOR, "Warning")}
              className="px-3 py-1.5 rounded text-xs font-bold text-black"
              style={{ backgroundColor: WARNING_COLOR }}
            >
              Preview Yellow
            </button>
          </div>

          {/* Debug panel */}
          {debugJson && (
            <div>
              <button
                type="button"
                onClick={() => setShowDebug(!showDebug)}
                className="text-white/40 text-xs underline"
              >
                {showDebug ? "Hide" : "Show"} Debug JSON
              </button>
              {showDebug && (
                <pre className="mt-2 p-3 rounded-lg bg-black/50 text-white/60 text-xs overflow-auto max-h-48">
                  {debugJson}
                </pre>
              )}
            </div>
          )}
        </div>
      )}

      {/* Self-test modal */}
      {showSelfTest && selfTestResult && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center px-6"
          {...modalBackdropProps(() => setShowSelfTest(false))}
        >
          <div className="bg-[#1A1A1A] rounded-2xl p-6 max-w-md w-full">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-white font-bold text-lg">Self-Test Results</h2>
              <span
                className={`px-2 py-1 rounded text-xs font-bold ${
                  selfTestResult.allPassed
                    ? "bg-emerald-500/20 text-emerald-400"
                    : "bg-red-500/20 text-red-400"
                }`}
              >
                {selfTestResult.allPassed ? "ALL PASS" : "FAILURES"}
              </span>
            </div>
            <div className="space-y-2">
              {selfTestResult.tests.map((t) => (
                <div key={t.name} className="flex items-start gap-2 text-sm">
                  <span className={t.pass ? "text-emerald-400" : "text-red-400"}>
                    {t.pass ? "✓" : "✗"}
                  </span>
                  <div className="flex-1 min-w-0">
                    <span className="text-white/80 font-mono text-xs">{t.name}</span>
                    <span className="text-white/30 text-xs ml-2">{t.ms}ms</span>
                    {t.detail && (
                      <p className="text-white/40 text-xs mt-0.5 truncate">{t.detail}</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setShowSelfTest(false)}
              className="mt-4 w-full py-2 rounded-lg bg-white/10 text-white/60 text-sm hover:bg-white/15"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
