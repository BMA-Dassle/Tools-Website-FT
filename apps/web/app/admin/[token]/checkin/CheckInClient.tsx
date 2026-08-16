"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { IconAlertTriangleFilled } from "@tabler/icons-react";
import { modalBackdropProps } from "@/lib/a11y";
import RaceControlPanels from "./RaceControlPanels";
import { useBriefingControl, type TimingFeedStatus } from "./useBriefingControl";
import { useBuildUpdate } from "~/hooks/useBuildUpdate";
import {
  ADMIN_SANS,
  ADMIN_MONO,
  PORTAL_BLUE,
  PORTAL_BLUE_SOFT,
  PORTAL_DARK,
} from "~/components/features/admin-skin/theme";

// --------------- Types ---------------

/** The board's warning amber, same value the briefing panels use. */
const AMBER = "#f0b341";
const withAlphaAmber = (a: number) => `rgba(240,179,65,${a})`;
/** The board's green — same value as RaceControlPanels and OverridePanel, so an
 *  armed switch here reads as the same "good" as an all-here Called box. */
const GREEN = "#4ade80";
/** The board's red, same value RaceControlPanels uses for DANGER. */
const RED = "#ff4d4f";

/**
 * THE TIMING FEED, on the desk.
 *
 * The kart timing WebSocket is what every race clock in the building is derived
 * from, and until now nothing showed whether it was alive. On 2026-08-15 it went
 * silent mid-session and the only symptom was the clocks quietly being wrong —
 * the heartbeat existed the whole time, no screen carried it.
 *
 * AGE IS MEASURED AGAINST THE SERVER'S CLOCK, NOT THIS TABLET'S. The board's
 * payload carries `now`, so the offset between the two is known and the chip
 * stays honest on a device whose clock is wrong.
 *
 * It also keeps counting between polls, deliberately: if the board's own 5s poll
 * dies, the age keeps climbing and the chip goes red. A status light that freezes
 * green when its feed dies is worse than no status light.
 */
function TimingChip({ timing, serverNowMs }: { timing?: TimingFeedStatus; serverNowMs?: number }) {
  // "Now" is STATE, ticked by the interval — not a Date.now() call in the render
  // body, which is impure and is what react-hooks/purity is for. Ticking every
  // second is also what makes the age advance between the board's 5s polls.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Offset between this tablet's clock and the server's, measured at the last
  // poll. Zero when we have no reading, which just means we trust the device.
  const skewMs = serverNowMs != null ? serverNowMs - nowMs : 0;
  const liveAgeMs =
    timing?.lastEventMs != null ? Math.max(0, nowMs + skewMs - timing.lastEventMs) : null;

  // Recomputed here rather than trusting the polled `state`, for the frozen-poll
  // reason above. Same thresholds as timing-feed.server.ts.
  const state: TimingFeedStatus["state"] =
    timing == null
      ? "unknown"
      : liveAgeMs == null
        ? timing.state === "down"
          ? "down"
          : "unknown"
        : liveAgeMs <= 90_000
          ? "live"
          : liveAgeMs <= 5 * 60_000
            ? "stale"
            : "down";

  const color =
    state === "live"
      ? GREEN
      : state === "stale"
        ? AMBER
        : state === "down"
          ? RED
          : PORTAL_DARK.muted;

  const age = (ms: number) =>
    ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60_000)}m`;
  const value =
    state === "unknown"
      ? "unknown"
      : state === "down" && liveAgeMs == null
        ? "down"
        : age(liveAgeMs ?? 0);

  return (
    <div
      className="flex items-center gap-1.5 px-2 py-1 rounded-lg border"
      style={{ borderColor: `${color}55`, background: `${color}14`, borderRadius: 8 }}
      title={
        state === "live"
          ? "Kart timing feed is delivering"
          : state === "stale"
            ? "No timing message recently — normal between sessions, a problem during one"
            : state === "down"
              ? "Timing feed is not delivering. Race clocks will not advance."
              : "Cannot tell whether the timing feed is alive"
      }
    >
      <span
        className={`w-2 h-2 rounded-full${state === "live" ? " animate-pulse" : ""}`}
        style={{ background: color }}
      />
      <span
        className="text-xs font-bold"
        style={{ color: PORTAL_DARK.muted, letterSpacing: "0.06em" }}
      >
        TIMING
      </span>
      <span className="text-xs font-bold" style={{ color, fontFamily: ADMIN_MONO }}>
        {value}
      </span>
    </div>
  );
}

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
  /**
   * Is the camera sweep armed? Read off the board poll, so this desk shows a
   * change made at the other one. Defaults ON before the first poll lands —
   * the same direction as the server's kill switch, so the sheet never briefly
   * claims OFF for a switch that is actually running.
   */
  const autoHoldingOn = briefing.board?.autoHolding?.enabled !== false;
  /** Race-event camera bookmarks — the second server-wide switch on the sheet. */
  const raceBookmarksOn = briefing.board?.raceBookmarks?.enabled !== false;

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
    scanState !== "idle" || !!briefing.pending || !!briefing.expandedCamera || showSettings;
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

  // Live session status via the admin endpoint (which calls Pandora directly
  // for checkedIn counts). Covers called races AND HP Arena sessions in their
  // check-in window; `track` carries the track name for races ("blue") or the
  // activity name for arena ("Laser Tag").
  //
  // POLLED EVERY 15s, NOT 5s. Each poll costs `2 + N` live Pandora calls with
  // no cache upstream — at five seconds that was 48 calls/minute from a single
  // tab, from a page that is opened at several stations and left open all
  // shift. This is a checked-in COUNT next to a heat number; fifteen seconds
  // has never been the difference between calling a heat and not. Paired with
  // the 10s server-side cache in /api/admin/checkin, so several tabs share one
  // fan-out rather than each buying their own.
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
    // NEVER TWO IN FLIGHT AT ONCE. setInterval fires on the clock regardless of
    // whether the last poll came back, so when Pandora slows past the interval
    // the requests overlap and stack — the board quietly multiplies its own
    // load on the upstream at the exact moment the upstream is struggling
    // (2026-08-13: Pandora answering in 5-10s from iad1 while this polled every
    // 5s). A tick that arrives with one still open is dropped instead.
    let inFlight = false;
    async function poll() {
      if (inFlight) return;
      inFlight = true;
      try {
        const res = await fetch(
          `/api/admin/checkin?token=${encodeURIComponent(token)}&action=session-stats`,
          // The timeout is what GUARANTEES `inFlight` clears — an untimed fetch
          // that never settles would wedge the poller for the rest of the
          // shift. Aborting here doesn't cancel the server's work, and that is
          // fine: it still fills the 10s cache, so the next tick reads it back
          // instantly.
          { cache: "no-store", signal: AbortSignal.timeout(20_000) },
        );
        if (!res.ok || !mounted) return;
        const data = await res.json();
        if (mounted && Array.isArray(data?.sessions)) setActiveSessions(data.sessions);
      } catch {
        /* silent */
      } finally {
        inFlight = false;
      }
    }
    poll();
    const iv = setInterval(poll, 15_000);
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
      {/* Header — THIN IN BOARD MODE. Every millimetre here is taken from the
          bottom of a room column, and this band is read once a shift while the
          columns are read all night (owner 2026-08-14: "just little more to get
          it all on the screen… smaller header?"). So on the board the title
          drops to the size of a label and the build number moves onto its line
          instead of below it; the plain check-in station keeps the full heading,
          where there is nothing underneath competing for the space. */}
      <div
        className={`flex items-center justify-between px-6 border-b ${boardMode ? "py-2" : "py-4"}`}
        style={{ borderColor: PORTAL_DARK.border, flexWrap: "wrap", gap: 12 }}
      >
        <div style={boardMode ? { display: "flex", alignItems: "baseline", gap: 8 } : undefined}>
          <h1 style={{ fontSize: boardMode ? "1.05rem" : "1.5rem", fontWeight: 700 }}>
            {boardMode ? "Check-In & Race Control" : "Check-In"}
          </h1>
          <p className="text-xs" style={{ color: PORTAL_DARK.muted }}>
            v{version}
          </p>
          {/* Board mode only — a plain check-in station does not poll the board,
              so it has no feed reading to show and would be stuck on "unknown". */}
          {boardMode && (
            <TimingChip timing={briefing.board?.timing} serverNowMs={briefing.board?.now} />
          )}
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
                /**
                 * NOT CONNECTED IS A WARNING, SO THE CONTROL IS THE WARNING
                 * (owner 2026-08-13: "move this to yellow button on reader
                 * status").
                 *
                 * This used to be a neutral blue "Connect scanner" with a
                 * full-width amber banner underneath repeating the point. Two
                 * elements, one fact — and the banner cost a whole row on a board
                 * that now carries four boxes per track. The button is amber
                 * instead and says what is at stake, so the thing you press is
                 * the thing that told you.
                 */
                <button
                  type="button"
                  onClick={requestPort}
                  title="No scan will check anybody in until the scanner is connected"
                  className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-bold"
                  style={{ backgroundColor: AMBER, color: "#1a1205", borderRadius: 8 }}
                >
                  <IconAlertTriangleFilled size={13} aria-hidden />
                  {connectionState === "error" ? "Retry scanner" : "Scanner not connected"}
                  <span style={{ fontWeight: 600, opacity: 0.85 }}>
                    {connectionError ? `— ${connectionError}` : "— nobody is being checked in"}
                  </span>
                </button>
              )}
            </>
          )}
          {/* THE BOARD'S TWO REFERENCE PANELS, up here with the rest of the
              controls (owner 2026-08-13: "they can join the other buttons up
              top"). They opened from the briefing-rooms header before, which
              split the page's controls across two rows for no reason — every
              button on this page now lives in one place, in the page's own
              button style rather than the board's. Board mode only: a plain
              check-in station has no briefing board to report on. */}
          {boardMode && (
            <>
              {/* OVERRIDE — the manual placement modal. Amber because it is a
                  correction, not a step: every other control on this bar does
                  what the flow does, and this one says the flow got it wrong. */}
              <button
                type="button"
                onClick={() => briefing.setOpenPanel("override")}
                className="px-3 py-1.5 rounded-lg border text-xs hover:bg-white/5"
                style={{ borderColor: withAlphaAmber(0.55), color: AMBER, borderRadius: 8 }}
              >
                Override
              </button>
              <button
                type="button"
                onClick={() => briefing.setOpenPanel("waits")}
                className="px-3 py-1.5 rounded-lg border text-xs hover:bg-white/5"
                style={{
                  borderColor: PORTAL_DARK.border,
                  color: PORTAL_DARK.muted,
                  borderRadius: 8,
                }}
              >
                Wait times
              </button>
              <button
                type="button"
                onClick={() => briefing.setOpenPanel("log")}
                className="px-3 py-1.5 rounded-lg border text-xs hover:bg-white/5 inline-flex items-center gap-1.5"
                style={{
                  borderColor: PORTAL_DARK.border,
                  color: PORTAL_DARK.muted,
                  borderRadius: 8,
                }}
              >
                Briefing log
                {/* The count is the reason to open it. */}
                {(briefing.board?.briefings.length ?? 0) > 0 && (
                  <span
                    className="px-1.5 rounded-full text-[10px] font-bold"
                    style={{ backgroundColor: PORTAL_DARK.muted2, color: PORTAL_DARK.muted }}
                  >
                    {briefing.board?.briefings.length}
                  </span>
                )}
              </button>
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

          {/*
            AUTO-MOVE TO HOLDING — the camera sweep's kill switch (owner
            2026-08-14). Here rather than on the board itself because it governs
            how the night is decided, not what happens to one heat: staff throw
            it when the automatic path is misbehaving and they want the evening
            back on manual presses.

            It reads its state from the board poll, so it shows the truth even if
            the other desk flipped it — and it is a SERVER setting, unlike the
            baud rate above, which is this PC's own. The copy says so, because a
            switch that looks device-local but is not is how one desk silently
            changes another's night.
          */}
          <div className="mt-4 pt-4 border-t" style={{ borderColor: PORTAL_DARK.border }}>
            <p className="block text-xs mb-2" style={{ color: PORTAL_DARK.muted }}>
              Auto-move to holding
            </p>
            <button
              type="button"
              role="switch"
              aria-checked={autoHoldingOn}
              disabled={!briefing.board}
              onClick={() => briefing.setAutoHolding(!autoHoldingOn)}
              className="px-3 py-1.5 text-xs border hover:bg-white/5"
              style={{
                borderRadius: 8,
                borderColor: autoHoldingOn ? GREEN : PORTAL_DARK.inputBorder,
                backgroundColor: autoHoldingOn ? `${GREEN}22` : "transparent",
                color: autoHoldingOn ? GREEN : PORTAL_DARK.muted,
                opacity: briefing.board ? 1 : 0.5,
              }}
            >
              {autoHoldingOn ? "On" : "Off"}
            </button>
            <p className="text-xs mt-2" style={{ color: PORTAL_DARK.muted }}>
              {autoHoldingOn
                ? "When a room goes quiet on camera after the briefing, its group moves to holding on its own. Staff can still press Send to holding at any time."
                : "Groups only move to holding when staff press Send to holding."}{" "}
              This setting applies to every check-in station, not just this one.
            </p>
          </div>

          {/*
            RACE CAMERA BOOKMARKS — the second server-wide switch (owner
            2026-08-14). Its own control rather than a mode of the one above,
            because the two are unrelated: that one moves groups through the
            night, this one only annotates footage. The likeliest reason to
            reach for this is volume, so the copy names it.
          */}
          <div className="mt-4 pt-4 border-t" style={{ borderColor: PORTAL_DARK.border }}>
            <p className="block text-xs mb-2" style={{ color: PORTAL_DARK.muted }}>
              Race camera bookmarks
            </p>
            <button
              type="button"
              role="switch"
              aria-checked={raceBookmarksOn}
              disabled={!briefing.board}
              onClick={() => briefing.setRaceBookmarks(!raceBookmarksOn)}
              className="px-3 py-1.5 text-xs border hover:bg-white/5"
              style={{
                borderRadius: 8,
                borderColor: raceBookmarksOn ? GREEN : PORTAL_DARK.inputBorder,
                backgroundColor: raceBookmarksOn ? `${GREEN}22` : "transparent",
                color: raceBookmarksOn ? GREEN : PORTAL_DARK.muted,
                opacity: briefing.board ? 1 : 0.5,
              }}
            >
              {raceBookmarksOn ? "On" : "Off"}
            </button>
            <p className="text-xs mt-2" style={{ color: PORTAL_DARK.muted }}>
              {raceBookmarksOn
                ? "Session start, pause, resume and end are marked in Nx on every camera for that track, so footage can be found by session instead of by scrubbing."
                : "Nothing new is written to the track cameras. Bookmarks already written stay."}{" "}
              Applies to every station.
            </p>
          </div>
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

      {/* A CHECK-IN STATION THAT IS NOT LISTENING IS THE WORST SILENT FAILURE —
          board mode hides the big centre panel, so a tab that never got the
          serial port looks completely normal, and Web Serial is exclusive PER TAB
          so a second tab holding the port leaves this one deaf (owner 2026-08-11:
          "while check in is in board mode it's not checking in racers").

          That warning used to be this full-width amber strip. It is now the
          scanner control itself, up in the top bar — an amber button that names
          the consequence (owner 2026-08-13: "move this to yellow button on reader
          status"). One element instead of two saying the same thing, and the row
          it occupied goes back to the boxes. */}

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
