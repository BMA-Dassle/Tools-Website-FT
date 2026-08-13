"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { modalBackdropProps } from "@/lib/a11y";
import RaceControlPanels from "./RaceControlPanels";
import { useBriefingControl } from "./useBriefingControl";
import { useBuildUpdate } from "~/hooks/useBuildUpdate";
import {
  ADMIN_SANS,
  ADMIN_MONO,
  PORTAL_BLUE,
  PORTAL_BLUE_SOFT,
  PORTAL_DARK,
} from "~/components/features/admin-skin/theme";

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
  nextRace?: {
    track: string | null;
    raceType: string | null;
    heatNumber: number | null;
    scheduledStart: string | null;
  } | null;
  nextRaceStatus?: "found" | "none" | "unknown";
  /** Preformatted next race for a LICENCE scan before the heat opens — read
   *  from the racer's own pass row, so the desk and the pass always agree. */
  nextRaceText?: string | null;
  /** Guest is part of an Ultimate VIP combo reservation today. */
  vip?: boolean;
  /** Today is the guest's birthday (BMI person record). */
  birthday?: boolean;
  /** Guest races again within the next 2 heats (any track). */
  backToBack?: {
    track: string | null;
    raceType: string | null;
    heatNumber: number | null;
    scheduledStart: string | null;
  } | null;
}

const VIP_GOLD = "#d4af37";
const BIRTHDAY_PINK = "#EC4899";

// Accent per session kind — race tracks plus HP Arena activities
// (the stats strip and flash screens are attraction-generic now).
const TRACK_COLORS: Record<string, string> = {
  blue: "#004AAD",
  red: "#E53935",
  mega: "#8B5CF6",
  "laser tag": "#8652FF",
  "gel blaster": "#00E2E5",
};
const WARNING_COLOR = "#F59E0B";
const ERROR_COLOR = "#F59E0B";
const FLASH_DURATION = 4000;
const BAUD_RATES = [9600, 19200, 38400, 115200] as const;

// --------------- Component ---------------

interface Props {
  token: string;
  version: string;
  /**
   * `?board=1` — ADD race control to this station, never replace it.
   *
   * The person who checks racers in is the person who sends the heat to a
   * briefing room, standing in the same spot. Swapping the scanner out for the
   * board was the wrong shape (owner 2026-08-11: "this was supposed to be a dual
   * board, where is all the check in stuff") — so the board is an extra section
   * and every existing behaviour here is untouched.
   */
  boardMode?: boolean;
}

export default function CheckInClient({ token, version, boardMode = false }: Props) {
  /**
   * Briefing-room state lives HERE, not in the panels.
   *
   * The scan flash below is an early return, so the panels unmount for its four
   * seconds. Held in the panels, a staff member's Starter/Intermediate override
   * reset to auto on every scan (they could then send the wrong film), the
   * "sent to the red room" note vanished mid-read, and the room panels repainted
   * empty until the next poll. This component's own state survives the early
   * return, so the state and its poller do too.
   */
  const briefing = useBriefingControl(token, boardMode);

  // Declared HERE, above every reader. It used to sit just before the return, and
  // the board-mode header below reads it — a const referenced above its own
  // declaration is a runtime ReferenceError rather than a type error.
  const serialSupported = typeof window !== "undefined" && "serial" in navigator;

  /**
   * SELF-UPDATE. This tab is opened once and left open for a shift, so a deploy
   * reaches it only when somebody thinks to hard-refresh (owner 2026-08-12).
   *
   * A RELOAD HERE IS CHEAP, WHICH IS WHY IT CAN BE AUTOMATIC: the scanner
   * re-attaches with no user gesture — the mount effect reopens a
   * previously-authorized port from navigator.serial.getPorts() — and every piece
   * of board state is server-polled, so nothing is lost but the fraction of a
   * second. What a reload must NOT do is land mid-action, hence the quiet-stretch
   * rule below rather than reloading the instant a deploy lands.
   */
  const buildUpdate = useBuildUpdate(version);

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

  /**
   * TAKE THE NEW BUILD, BUT ONLY IN A GAP.
   *
   * The timer restarts on every change to what the desk is doing, so the reload
   * needs one unbroken quiet minute: no scan in flight or on the flash screen, no
   * briefing action posting, no camera viewer open, no settings sheet. On a busy
   * Friday that gap arrives between heats; on a quiet afternoon it arrives at
   * once. Either way nobody is mid-send when the page goes.
   */
  const deskBusy =
    scanState !== "idle" || !!briefing.pending || !!briefing.expandedRoom || showSettings;
  useEffect(() => {
    if (!buildUpdate.ready || deskBusy) return;
    const t = setTimeout(() => window.location.reload(), 60_000);
    return () => clearTimeout(t);
  }, [buildUpdate.ready, deskBusy]);

  // Test mode — ?test=1 opt-in, read at mount like the baud-rate setting
  const [testMode] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return new URLSearchParams(window.location.search).get("test") === "1";
  });
  const [testInput, setTestInput] = useState("");
  const [debugJson, setDebugJson] = useState<string>("");
  const [showDebug, setShowDebug] = useState(false);

  // Self-test
  const [selfTestResult, setSelfTestResult] = useState<{
    tests: { name: string; pass: boolean; ms: number; detail?: string }[];
    allPassed: boolean;
  } | null>(null);
  const [showSelfTest, setShowSelfTest] = useState(false);

  // Live session status — polled every 5s via admin endpoint (calls Pandora
  // directly for checkedIn counts). Covers called races AND HP Arena
  // sessions in their check-in window; `track` carries the track name for
  // races ("blue") or the activity name for arena ("Laser Tag").
  interface ActiveSession {
    track: string;
    raceType: string;
    heatNumber: number;
    sessionId: number | string;
    scheduledStart: string;
    checkedIn: number;
    total: number;
  }
  const [activeSessions, setActiveSessions] = useState<ActiveSession[]>([]);

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
    const iv = setInterval(poll, 5_000);
    return () => {
      mounted = false;
      clearInterval(iv);
    };
  }, [token]);

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

  // Preview the back-to-back banner stacked with headsock (no API call) —
  // the two banners CAN co-occur on a real green check-in.
  function previewBackToBack() {
    setLastResult({
      success: true,
      guest: { firstName: "PREVIEW", lastName: "BACK-TO-BACK", pictureUrl: null },
      session: { track: "blue", raceType: "Starter", heatNumber: 4, scheduledStart: null },
      currentlyCheckingIn: true,
      headsock: { detected: true, deducted: true, balance: 1 },
      backToBack: {
        track: "red",
        raceType: "Intermediate",
        heatNumber: 7,
        scheduledStart: new Date(Date.now() + 12 * 60_000).toISOString(),
      },
    });
    setLastError("");
    setScanState("result");
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    flashTimerRef.current = setTimeout(() => {
      setScanState("idle");
      setLastResult(null);
    }, FLASH_DURATION);
  }

  // Preview the VIP badge on the green guest card (no API call).
  function previewVip() {
    setLastResult({
      success: true,
      guest: { firstName: "PREVIEW", lastName: "VIP", pictureUrl: null },
      session: { track: "mega", raceType: "Pro", heatNumber: 2, scheduledStart: null },
      currentlyCheckingIn: true,
      headsock: { detected: false, deducted: false, balance: 0 },
      vip: true,
    });
    setLastError("");
    setScanState("result");
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    flashTimerRef.current = setTimeout(() => {
      setScanState("idle");
      setLastResult(null);
    }, FLASH_DURATION);
  }

  // Preview the birthday badge on the green guest card (no API call).
  function previewBirthday() {
    setLastResult({
      success: true,
      guest: { firstName: "PREVIEW", lastName: "BIRTHDAY", pictureUrl: null },
      session: { track: "blue", raceType: "Junior Starter", heatNumber: 3, scheduledStart: null },
      currentlyCheckingIn: true,
      headsock: { detected: false, deducted: false, balance: 0 },
      vip: true,
      birthday: true,
    });
    setLastError("");
    setScanState("result");
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    flashTimerRef.current = setTimeout(() => {
      setScanState("idle");
      setLastResult(null);
    }, FLASH_DURATION);
  }

  // Preview the next-race screens (no API call) — paper-QR scan whose race
  // isn't currently being called.
  function previewNextRace(status: "found" | "none") {
    const race =
      status === "found"
        ? { track: "blue", raceType: "Starter", heatNumber: 5, scheduledStart: null }
        : null;
    setLastResult({
      success: false,
      guest: null,
      session: race ?? { track: null, raceType: null, heatNumber: null, scheduledStart: null },
      currentlyCheckingIn: false,
      headsock: { detected: false, deducted: false, balance: 0 },
      nextRace: race,
      nextRaceStatus: status,
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

        {/* Back-to-back banner — bottom-anchored so it never covers the
            guest photo/name (headsock owns the top). */}
        {lastResult?.backToBack && (
          <div className="absolute bottom-0 left-0 right-0 bg-sky-400 py-6 sm:py-8 px-6 text-center border-t-4 border-sky-600">
            <p
              className="text-black font-black uppercase tracking-wider leading-none"
              style={{ fontSize: "clamp(36px, 8vw, 64px)" }}
            >
              Back-to-Back Race
            </p>
            <p className="text-black/80 text-lg sm:text-xl font-bold mt-2 uppercase">
              Races again:{" "}
              {[
                lastResult.backToBack.track,
                lastResult.backToBack.raceType,
                lastResult.backToBack.heatNumber
                  ? `Heat ${lastResult.backToBack.heatNumber}`
                  : null,
              ]
                .filter(Boolean)
                .join(" ")}
              {lastResult.backToBack.scheduledStart && (
                <>
                  {" "}
                  —{" "}
                  {new Date(lastResult.backToBack.scheduledStart).toLocaleTimeString("en-US", {
                    hour: "numeric",
                    minute: "2-digit",
                    timeZone: "America/New_York",
                  })}
                </>
              )}
            </p>
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
        ) : lastResult?.nextRaceStatus === "found" && lastResult.nextRace ? (
          <>
            <p
              className="text-black/70 font-black uppercase tracking-widest text-center"
              style={{ fontSize: "clamp(20px, 4vw, 32px)" }}
            >
              Next Race
            </p>
            <p
              className="font-black uppercase text-center leading-tight mt-2"
              style={{ fontSize: "clamp(40px, 10vw, 72px)", color: getTrackTextColor() }}
            >
              {[
                lastResult.nextRace.track,
                lastResult.nextRace.raceType,
                lastResult.nextRace.heatNumber ? `Heat ${lastResult.nextRace.heatNumber}` : null,
              ]
                .filter(Boolean)
                .join(" ") || "Race details unavailable"}
            </p>
            {lastResult.nextRace.scheduledStart && (
              <p
                className="text-black/80 font-bold text-center mt-3"
                style={{ fontSize: "clamp(24px, 6vw, 44px)" }}
              >
                {new Date(lastResult.nextRace.scheduledStart).toLocaleTimeString("en-US", {
                  hour: "numeric",
                  minute: "2-digit",
                  timeZone: "America/New_York",
                })}
              </p>
            )}
            {lastRaw && <p className="text-black/40 text-xs mt-4 font-mono">{lastRaw}</p>}
          </>
        ) : lastResult?.nextRaceStatus === "none" ? (
          <>
            {/* A licence scan before the racer's heat opens is the ordinary
                case, not a failure — name the racer and their race rather than
                sending someone who is on tonight's grid to Guest Services. */}
            {lastResult.nextRaceText ? (
              <>
                {lastResult.guest && (
                  <p
                    className="text-black font-black uppercase text-center leading-tight"
                    style={{ fontSize: "clamp(28px, 6vw, 44px)" }}
                  >
                    {`${lastResult.guest.firstName} ${lastResult.guest.lastName}`.trim()}
                  </p>
                )}
                <p
                  className="text-black/70 font-black uppercase tracking-widest text-center mt-3"
                  style={{ fontSize: "clamp(18px, 3.5vw, 28px)" }}
                >
                  Not Checking In Yet
                </p>
                <p
                  className="text-black font-black uppercase text-center leading-tight mt-2"
                  style={{ fontSize: "clamp(32px, 7vw, 56px)" }}
                >
                  {lastResult.nextRaceText}
                </p>
              </>
            ) : (
              <>
                <p
                  className="text-black font-black uppercase text-center"
                  style={{ fontSize: "clamp(36px, 8vw, 56px)" }}
                >
                  No Upcoming Race Found
                </p>
                <p className="text-black/70 text-lg text-center mt-2">See Guest Services</p>
              </>
            )}
            {lastRaw && <p className="text-black/40 text-xs mt-4 font-mono">{lastRaw}</p>}
          </>
        ) : lastResult?.guest ? (
          <>
            {/* Guest picture placeholder — gold ring for VIPs, pink for birthdays */}
            <div
              className="rounded-full border-4 bg-white/10 flex items-center justify-center mb-6 overflow-hidden"
              style={{
                width: 240,
                height: 240,
                borderColor: lastResult.vip
                  ? VIP_GOLD
                  : lastResult.birthday
                    ? BIRTHDAY_PINK
                    : "rgba(255,255,255,0.3)",
              }}
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

            {/* Badge row — VIP (Ultimate VIP combo) + Birthday (BMI birthdate = today) */}
            {(lastResult.vip || lastResult.birthday) && (
              <div className="flex gap-3 mb-3">
                {lastResult.vip && (
                  <div
                    className="px-6 py-1.5 rounded-full text-black font-black uppercase tracking-widest"
                    style={{ backgroundColor: VIP_GOLD, fontSize: "clamp(18px, 3.5vw, 28px)" }}
                  >
                    ★ VIP
                  </div>
                )}
                {lastResult.birthday && (
                  <div
                    className="px-6 py-1.5 rounded-full text-white font-black uppercase tracking-widest"
                    style={{ backgroundColor: BIRTHDAY_PINK, fontSize: "clamp(18px, 3.5vw, 28px)" }}
                  >
                    🎂 Birthday
                  </div>
                )}
              </div>
            )}

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

        {!lastResult?.backToBack && (
          <p className="absolute bottom-6 text-white/30 text-xs">Tap to dismiss</p>
        )}
      </div>
    );
  }

  // --------------- Render: Idle / Ready ---------------

  return (
    <div
      className="min-h-screen flex flex-col"
      style={{
        background: PORTAL_DARK.bodyGradient,
        color: PORTAL_DARK.fg,
        fontFamily: ADMIN_SANS,
      }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-6 py-4 border-b"
        style={{ borderColor: PORTAL_DARK.border, flexWrap: "wrap", gap: 12 }}
      >
        <div>
          <h1 style={{ fontSize: "1.5rem", fontWeight: 700 }}>
            {boardMode ? "Check-In & Race Control" : "Check-In"}
          </h1>
          <p className="text-xs" style={{ color: PORTAL_DARK.muted }}>
            v{version}
          </p>
        </div>

        {/* A NEWER DEPLOY IS LIVE (owner 2026-08-12: "enable this page to grab
            updates when needed so when we push this goes live"). The board picks
            it up on its own once the desk goes quiet — but it says so, and offers
            the button, because a staff member who was just told a fix is live
            should not have to trust an invisible timer. */}
        {buildUpdate.ready && (
          <button
            type="button"
            onClick={buildUpdate.reloadNow}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs font-bold"
            style={{ borderColor: PORTAL_BLUE, color: PORTAL_BLUE, borderRadius: 8 }}
            title={`This tab is on v${version}; v${buildUpdate.serverVersion} is live`}
          >
            <span
              className="w-2 h-2 rounded-full animate-pulse"
              style={{ background: PORTAL_BLUE }}
            />
            New version ready — reload
          </button>
        )}
        <div className="flex items-center gap-3" style={{ flexWrap: "wrap" }}>
          {/* BOARD MODE: the scanner lives up here as a strip, not as a
              full-height hero in the middle of the page — the briefing rooms are
              what the screen is for (owner 2026-08-11: "get that connect scanner
              out of there and up to the top bar, utilize full screen"). */}
          {boardMode && serialSupported && (
            <>
              {connectionState === "ready" ? (
                <span
                  className="flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs"
                  style={{ borderColor: "#14532d", color: "#4ade80", borderRadius: 8 }}
                >
                  <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                  Scanner ready
                  <button
                    type="button"
                    onClick={disconnect}
                    className="underline"
                    style={{ color: PORTAL_DARK.muted }}
                  >
                    disconnect
                  </button>
                </span>
              ) : connectionState === "connecting" ? (
                <span className="text-xs" style={{ color: PORTAL_DARK.muted }}>
                  Connecting scanner…
                </span>
              ) : (
                <button
                  type="button"
                  onClick={requestPort}
                  className="px-3 py-1.5 rounded-lg text-xs font-bold"
                  style={{ backgroundColor: PORTAL_BLUE, color: "#fff", borderRadius: 8 }}
                >
                  {connectionState === "error" ? "Retry scanner" : "Connect scanner"}
                </button>
              )}
            </>
          )}
          <button
            type="button"
            onClick={runSelfTest}
            className="px-3 py-1.5 rounded-lg border text-xs hover:bg-white/5"
            style={{ borderColor: PORTAL_DARK.border, color: PORTAL_DARK.muted, borderRadius: 8 }}
          >
            Run Self-Test
          </button>
          <button
            type="button"
            aria-label="Settings"
            onClick={() => setShowSettings(!showSettings)}
            className="p-2 rounded-lg border hover:bg-white/5"
            style={{ borderColor: PORTAL_DARK.border, color: PORTAL_DARK.muted, borderRadius: 8 }}
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

      {/* Active sessions — check-in counts.
          HIDDEN IN BOARD MODE (owner 2026-08-12: "in board mode move the number
          checked in down to the check-in areas"). The count belongs beside the
          heat it is counting — the room column's Called box already names that
          session — and the space it was holding at the top of the board is where
          today's wait times now live. The plain check-in station keeps the strip:
          it has no room columns to move the number into. */}
      {!boardMode && activeSessions.length > 0 && (
        <div
          className="flex gap-3 px-6 py-3 border-b overflow-x-auto"
          style={{ borderColor: PORTAL_DARK.border }}
        >
          {activeSessions.map((s) => {
            const color = TRACK_COLORS[s.track.toLowerCase()] ?? PORTAL_BLUE;
            return (
              <div
                key={s.sessionId}
                className="flex items-center gap-3 px-4 py-2.5 shrink-0"
                style={{
                  backgroundColor: `${color}15`,
                  border: `1px solid ${color}40`,
                  borderRadius: 8,
                }}
              >
                <div>
                  <p className="text-xs font-bold uppercase" style={{ color }}>
                    {s.track} {s.raceType} {s.heatNumber ? `#${s.heatNumber}` : ""}
                  </p>
                  {s.scheduledStart && (
                    <p className="text-[10px]" style={{ color: PORTAL_DARK.muted }}>
                      {new Date(s.scheduledStart).toLocaleTimeString("en-US", {
                        hour: "numeric",
                        minute: "2-digit",
                        timeZone: "America/New_York",
                      })}
                    </p>
                  )}
                </div>
                <div className="text-right">
                  <p className="font-black text-xl leading-none" style={{ color: PORTAL_DARK.fg }}>
                    {s.checkedIn}
                    <span className="text-sm font-normal" style={{ color: PORTAL_DARK.muted }}>
                      /{s.total}
                    </span>
                  </p>
                  <p className="text-[10px] uppercase" style={{ color: PORTAL_DARK.muted }}>
                    checked in
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Settings dropdown */}
      {showSettings && (
        <div
          className="px-6 py-4 border-b"
          style={{ borderColor: PORTAL_DARK.border, backgroundColor: PORTAL_DARK.card }}
        >
          <p className="block text-xs mb-2" style={{ color: PORTAL_DARK.muted }}>
            Baud Rate
          </p>
          <div className="flex gap-2" style={{ flexWrap: "wrap" }}>
            {BAUD_RATES.map((rate) => (
              <button
                key={rate}
                type="button"
                onClick={() => {
                  setBaudRate(rate);
                  localStorage.setItem("checkin-scanner-baud", String(rate));
                }}
                className="px-3 py-1.5 text-xs border hover:bg-white/5"
                style={
                  baudRate === rate
                    ? {
                        borderColor: PORTAL_BLUE,
                        backgroundColor: `${PORTAL_BLUE}33`,
                        color: PORTAL_BLUE_SOFT,
                        borderRadius: 8,
                      }
                    : {
                        borderColor: PORTAL_DARK.inputBorder,
                        color: PORTAL_DARK.muted,
                        borderRadius: 8,
                      }
                }
              >
                {rate}
              </button>
            ))}
          </div>
          <p className="text-xs mt-2" style={{ color: PORTAL_DARK.muted }}>
            Disconnect and reconnect after changing baud rate.
          </p>
        </div>
      )}

      {/* Main content */}
      {/* The scanner's own area. In board mode it is gone — its status moved to the
          header — so the briefing rooms fill the page. */}
      <div
        className="flex-1 flex flex-col items-center justify-center px-6"
        style={boardMode ? { display: "none" } : undefined}
      >
        {!serialSupported ? (
          <div className="text-center">
            <p className="text-red-400 text-lg font-bold">Web Serial API Not Available</p>
            <p className="text-sm mt-2" style={{ color: PORTAL_DARK.muted }}>
              Use Microsoft Edge or Google Chrome on desktop.
            </p>
          </div>
        ) : connectionState === "idle" ? (
          <div className="text-center">
            <button
              type="button"
              onClick={requestPort}
              className="px-8 py-4 font-bold text-lg transition-colors"
              style={{ backgroundColor: PORTAL_BLUE, color: "#ffffff", borderRadius: 8 }}
            >
              Connect Scanner
            </button>
            <p className="text-sm mt-4" style={{ color: PORTAL_DARK.muted }}>
              Click to select your serial QR scanner
            </p>
          </div>
        ) : connectionState === "connecting" ? (
          <div className="text-center">
            <div
              className="w-8 h-8 border-2 border-t-transparent rounded-full animate-spin mx-auto"
              style={{ borderColor: PORTAL_BLUE, borderTopColor: "transparent" }}
            />
            <p className="text-sm mt-4" style={{ color: PORTAL_DARK.muted }}>
              Connecting...
            </p>
          </div>
        ) : connectionState === "error" ? (
          <div className="text-center max-w-md">
            <p className="text-red-400 text-lg font-bold">Connection Error</p>
            <p className="text-sm mt-2" style={{ color: PORTAL_DARK.muted }}>
              {connectionError}
            </p>
            <button
              type="button"
              onClick={requestPort}
              className="mt-4 px-6 py-2.5 text-sm font-medium transition-colors hover:bg-white/15"
              style={{ backgroundColor: PORTAL_DARK.card, color: PORTAL_DARK.fg, borderRadius: 8 }}
            >
              Try Again
            </button>
          </div>
        ) : (
          /* Ready state */
          <div className="text-center">
            <div
              className="flex items-center justify-center gap-2 mb-6"
              style={{ flexWrap: "wrap" }}
            >
              <div className="w-3 h-3 rounded-full bg-emerald-400 animate-pulse" />
              <span className="text-emerald-400 text-sm font-medium">Connected — {portName}</span>
              <button
                type="button"
                onClick={disconnect}
                className="text-xs underline ml-2"
                style={{ color: PORTAL_DARK.muted }}
              >
                Disconnect
              </button>
            </div>
            <p
              className="font-bold uppercase tracking-widest"
              style={{ fontSize: "clamp(24px, 5vw, 40px)", color: PORTAL_DARK.muted }}
            >
              Waiting for scan...
            </p>
            {scanState === "processing" && (
              <div className="mt-6">
                <div
                  className="w-8 h-8 border-2 border-t-transparent rounded-full animate-spin mx-auto"
                  style={{ borderColor: PORTAL_BLUE, borderTopColor: "transparent" }}
                />
              </div>
            )}
          </div>
        )}
      </div>

      {/* A CHECK-IN STATION THAT IS NOT LISTENING IS THE WORST SILENT FAILURE.
          Board mode hides the big centre panel, so without this a tab that never
          got the serial port looks completely normal — which is what happened
          (owner 2026-08-11: "while check in is in board mode it's not checking in
          racers… we checked in on the non board version instead"). Web Serial is
          exclusive PER TAB, so a second tab holding the port leaves this one deaf
          with no outward sign at all. Now it says so, in amber, across the top. */}
      {boardMode && serialSupported && connectionState !== "ready" && (
        <button
          type="button"
          onClick={requestPort}
          className="w-full px-6 py-3 text-left"
          style={{
            background: "rgba(240,179,65,0.14)",
            borderTop: "1px solid rgba(240,179,65,0.5)",
            borderBottom: "1px solid rgba(240,179,65,0.5)",
            color: "#f0b341",
            fontSize: 14,
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          ⚠ Scanner not connected — no scan will check anybody in. Click to connect.
          {connectionError ? ` (${connectionError})` : ""}
        </button>
      )}

      {/* Race control — briefing rooms. Below the scanner because checking a
          racer in comes first; the send follows once the heat is in. */}
      {boardMode && <RaceControlPanels control={briefing} checkinCounts={activeSessions} />}

      {/* Test mode panel */}
      {testMode && (
        <div
          className="border-t px-6 py-4"
          style={{ borderColor: PORTAL_DARK.border, backgroundColor: PORTAL_DARK.card }}
        >
          <div className="flex items-center justify-between mb-3">
            <p className="text-amber-400 text-xs font-bold uppercase tracking-wider">Test Mode</p>
          </div>

          {/* Manual scan input */}
          <div className="flex gap-2 mb-3" style={{ flexWrap: "wrap" }}>
            <input
              type="text"
              value={testInput}
              onChange={(e) => setTestInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleTestScan();
              }}
              placeholder="FT:personId:sessionId"
              className="flex-1 px-3 py-2 text-sm placeholder-white/30 focus:outline-none focus:border-blue-400"
              style={{
                minWidth: 180,
                backgroundColor: PORTAL_DARK.inputBg,
                border: `1px solid ${PORTAL_DARK.inputBorder}`,
                color: PORTAL_DARK.fg,
                borderRadius: 8,
              }}
            />
            <button
              type="button"
              onClick={handleTestScan}
              className="px-4 py-2 font-bold text-sm"
              style={{ backgroundColor: PORTAL_BLUE, color: "#ffffff", borderRadius: 8 }}
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
            <button
              type="button"
              onClick={previewBackToBack}
              className="px-3 py-1.5 rounded text-xs font-bold text-black bg-sky-400"
            >
              Preview Back-to-Back
            </button>
            <button
              type="button"
              onClick={previewVip}
              className="px-3 py-1.5 rounded text-xs font-bold text-black"
              style={{ backgroundColor: VIP_GOLD }}
            >
              Preview VIP
            </button>
            <button
              type="button"
              onClick={previewBirthday}
              className="px-3 py-1.5 rounded text-xs font-bold text-white"
              style={{ backgroundColor: BIRTHDAY_PINK }}
            >
              Preview Birthday
            </button>
            <button
              type="button"
              onClick={() => previewNextRace("found")}
              className="px-3 py-1.5 rounded text-xs font-bold text-black"
              style={{ backgroundColor: WARNING_COLOR }}
            >
              Preview Next Race
            </button>
            <button
              type="button"
              onClick={() => previewNextRace("none")}
              className="px-3 py-1.5 rounded text-xs font-bold text-black"
              style={{ backgroundColor: WARNING_COLOR }}
            >
              Preview No Race
            </button>
          </div>

          {/* Debug panel */}
          {debugJson && (
            <div>
              <button
                type="button"
                onClick={() => setShowDebug(!showDebug)}
                className="text-xs underline"
                style={{ color: PORTAL_DARK.muted }}
              >
                {showDebug ? "Hide" : "Show"} Debug JSON
              </button>
              {showDebug && (
                <pre
                  className="mt-2 p-3 text-xs overflow-auto max-h-48"
                  style={{
                    backgroundColor: PORTAL_DARK.inputBg,
                    color: PORTAL_DARK.muted,
                    borderRadius: 8,
                    fontFamily: ADMIN_MONO,
                  }}
                >
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
          <div
            className="p-6 max-w-md w-full"
            style={{
              backgroundColor: PORTAL_DARK.card,
              border: `1px solid ${PORTAL_DARK.border}`,
              borderRadius: 8,
              fontFamily: ADMIN_SANS,
            }}
          >
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-bold text-lg" style={{ color: PORTAL_DARK.fg }}>
                Self-Test Results
              </h2>
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
                    <span
                      className="text-xs"
                      style={{ color: PORTAL_DARK.fg, fontFamily: ADMIN_MONO }}
                    >
                      {t.name}
                    </span>
                    <span className="text-xs ml-2" style={{ color: PORTAL_DARK.muted }}>
                      {t.ms}ms
                    </span>
                    {t.detail && (
                      <p className="text-xs mt-0.5 truncate" style={{ color: PORTAL_DARK.muted }}>
                        {t.detail}
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setShowSelfTest(false)}
              className="mt-4 w-full py-2 text-sm hover:bg-white/15"
              style={{
                backgroundColor: PORTAL_DARK.inputBg,
                color: PORTAL_DARK.fg,
                borderRadius: 8,
              }}
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
