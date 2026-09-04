"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { IconAlertTriangleFilled } from "@tabler/icons-react";
import { modalBackdropProps } from "@/lib/a11y";
import RaceControlPanels, { waitTimesBehind } from "./RaceControlPanels";
import { useDeskAlarm } from "./useDeskAlarm";
import { useBriefingControl, type TimingFeedStatus } from "./useBriefingControl";
import { useScanSound } from "./useScanSound";
// TYPE-ONLY: scan-history.ts imports the redis client, so a value import here
// would drag a server module into the client bundle. `import type` is erased.
import type { ScanHistoryEntry, ScanHistoryStats } from "~/features/checkin/scan-history";
import type { AlarmKind } from "~/features/signage/briefing/desk-alarm";
import {
  parseCameraPreviewMode,
  type CameraPreviewMode,
} from "~/features/signage/nx/camera-preview";
// Pure constants — no server import behind them, so a value import is safe.
import { GREETING_TIMING_DEFAULTS } from "~/features/signage/briefing/return-greeting";
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
 * One labelled row of segmented choices in the settings sheet — used by the
 * greeting's three numbers (owner 2026-08-23).
 *
 * The whole point of buttons over a number field is that an invalid value is
 * unreachable, so the options a caller passes ARE the allowed set. Each press
 * saves immediately, like every other switch on this sheet: a Save button
 * would be one more thing to forget at 9pm.
 */
function GreetingChoiceRow({
  label,
  value,
  options,
  disabled,
  onPick,
}: {
  label: string;
  value: number;
  options: Array<{ value: number; label: string }>;
  disabled: boolean;
  onPick: (value: number) => void;
}) {
  return (
    <div>
      <p className="block text-xs mb-1.5" style={{ color: PORTAL_DARK.muted }}>
        {label}
      </p>
      <div className="flex gap-1.5 flex-wrap">
        {options.map((o) => {
          const on = o.value === value;
          return (
            <button
              key={o.value}
              type="button"
              aria-pressed={on}
              disabled={disabled}
              onClick={() => !on && onPick(o.value)}
              className="px-2.5 py-1 text-xs border hover:bg-white/5"
              style={{
                borderRadius: 8,
                borderColor: on ? GREEN : PORTAL_DARK.inputBorder,
                backgroundColor: on ? `${GREEN}22` : "transparent",
                color: on ? GREEN : PORTAL_DARK.muted,
                opacity: disabled ? 0.5 : 1,
              }}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

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
    /** Staff member running this heat, first name only. Null until claimed. */
    host?: string | null;
  };
  currentlyCheckingIn: boolean;
  /**
   * This racer was already scanned into this heat, so nothing was written and
   * no headsock was deducted. Still a green card — they ARE checked in — but
   * the desk must be told not to hand them a second headsock.
   */
  alreadyCheckedIn?: boolean;
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
  /**
   * WHERE THE TIME WENT. Present on every scan; the gear's manual lookup is the
   * only thing that displays it. This is how a slow desk gets diagnosed from a
   * station instead of from a laptop with the production secrets on it.
   */
  diag?: {
    dryRun?: boolean;
    ms?: Record<string, number>;
  };
}

/**
 * One line a staff member can read, or repeat down the phone. Deliberately
 * plain text rather than a component — it goes in the gear next to the input,
 * and the full payload is one click away in the Debug JSON panel.
 */
function summariseDryRun(json: unknown, ok: boolean, wallMs: number): string {
  const r = (json ?? {}) as CheckinResponse & { detail?: string; error?: string };
  if (!ok) return `HTTP error — ${r.detail || r.error || "unknown"} · ${wallMs}ms`;

  const who = r.guest ? `${r.guest.firstName} ${r.guest.lastName}`.trim() : "nobody matched";
  const heat = r.session?.track
    ? `${r.session.track}${r.session.raceType ? ` ${r.session.raceType}` : ""}${
        r.session.host ? ` · ${r.session.host}` : ""
      }${r.session.heatNumber ? ` heat ${r.session.heatNumber}` : ""}`
    : "no heat";

  const verdict = r.currentlyCheckingIn
    ? "WOULD CHECK IN"
    : r.nextRaceText
      ? `not yet — ${r.nextRaceText}`
      : "not checking in";

  const bits = [verdict, who, heat];
  if (r.headsock?.detected) bits.push(`headsock (balance ${r.headsock.balance})`);
  if (r.birthday) bits.push("birthday");
  if (r.vip) bits.push("VIP");

  const ms = r.diag?.ms;
  if (ms) {
    const parts = Object.entries(ms)
      .filter(([, v]) => typeof v === "number" && v >= 1)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${v}ms`);
    if (parts.length) bits.push(parts.join(", "));
  }
  bits.push(`${wallMs}ms round trip`);
  return bits.join(" · ");
}

/**
 * Scan durations span three orders of magnitude — a warm cache hit is single
 * digits, a sick upstream is nine seconds — so the unit changes with the size
 * rather than printing "9200ms" and making a reader count digits.
 */
function fmtScanMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)}s`;
}

/**
 * WHAT THE DESK CALLS IT, versus what the log stores.
 *
 * The stored kinds distinguish a 3-part e-ticket QR from a 4-part one, because
 * only the 4-part carries a participantId and only it exercises the
 * re-resolve-the-racer's-heat path — a real difference, to whoever is reading
 * the timings. It is NOT a difference to a staff member: both are e-tickets,
 * and the raw label `eticket-move` reads as "this racer moved heats", which is
 * not what it means at all. So the shape lives in the tooltip and the column
 * says the one thing that is true of both.
 */
function scanKindLabel(kind: string): { label: string; title: string } {
  switch (kind) {
    case "eticket":
      return { label: "e-ticket", title: "3-part QR (person + heat)" };
    case "eticket-move":
      return {
        label: "e-ticket",
        title:
          "4-part QR — also carries a participant id, so it still finds the racer if their heat changed",
      };
    case "licence":
      return { label: "licence", title: "Wallet racing licence or member app QR" };
    case "paper":
      return { label: "paper QR", title: "Bare participant id" };
    case "arena":
      return { label: "arena", title: "HP Arena ticket" };
    case "unparsed":
      return { label: "unknown", title: "Nothing we recognise — see the reason" };
    default:
      return { label: kind, title: kind };
  }
}

/** Same colour language as the flash card: green in, amber not yet, red broke. */
function scanOutcomeColor(outcome: string): string {
  switch (outcome) {
    case "checked-in":
      return GREEN;
    case "already-in":
      return PORTAL_BLUE_SOFT;
    case "not-checking-in":
      return AMBER;
    case "failed":
    case "unreadable":
      return RED;
    default:
      return "#94a3b8";
  }
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
  /**
   * `?loc=` — scope the SESSION-COUNTS STRIP to one building. View-only:
   * scanning is never gated by this (licence codes and FT QRs carry no
   * location at all, and any ticket must scan at whichever desk the guest
   * walks up to — the scan resolves against the ticket's own venue).
   * Absent/unknown values fall back to the unfiltered all-venues view,
   * so a bad bookmark degrades to exactly today's behaviour.
   */
  locFilter?: string;
}

/** `?loc=` slugs → the Square location id the strip filters on. Aliases
 *  are deliberate — desks will type these from memory into a bookmark. */
const LOC_FILTERS: Record<string, { locationId: string; label: string }> = {
  ft: { locationId: "LAB52GY480CJF", label: "FastTrax" },
  fasttrax: { locationId: "LAB52GY480CJF", label: "FastTrax" },
  hpfm: { locationId: "TXBSQN0FEKQ11", label: "HeadPinz FM" },
  headpinz: { locationId: "TXBSQN0FEKQ11", label: "HeadPinz FM" },
  naples: { locationId: "PPTR5G2N0QXF7", label: "HeadPinz Naples" },
  hpn: { locationId: "PPTR5G2N0QXF7", label: "HeadPinz Naples" },
};

export default function CheckInClient({ token, version, boardMode = false, locFilter }: Props) {
  /**
   * Briefing-room state lives HERE, not in the panels.
   *
   * The scan flash below is an early return, so the panels unmount for its four
   * seconds. Held in the panels, the "sent to the red room" note vanished
   * mid-read, the open camera viewer slammed shut in the face of whoever was
   * watching a room fill, and the room panels repainted empty until the next
   * poll. This component's own state survives the early return, so the state and
   * its poller do too.
   *
   * (A fourth reason retired 2026-08-16: a staff Starter/Intermediate film
   * override used to reset to auto on every scan, which could send the wrong
   * film. There is no override any more — see the VIDEO row in
   * RaceControlPanels.)
   */
  const briefing = useBriefingControl(token, boardMode);
  const sound = useScanSound();
  /**
   * Is the camera sweep armed? Read off the board poll, so this desk shows a
   * change made at the other one. Defaults ON before the first poll lands —
   * the same direction as the server's kill switch, so the sheet never briefly
   * claims OFF for a switch that is actually running.
   */
  const autoHoldingOn = briefing.board?.autoHolding?.enabled !== false;
  const greetingByMotionOn = briefing.board?.greetingByMotion?.enabled !== false;
  /** May staff push a send through with no time for the film? Default ALLOW —
   *  `undefined` from an older deploy reads the same way the server does. */
  const sendOverrideOn = briefing.board?.sendOverride?.allowed !== false;
  // Server-normalised when present; the house defaults when talking to an
  // older deploy — the same posture as the switch above it.
  const greetingTiming = briefing.board?.greetingTiming ?? GREETING_TIMING_DEFAULTS;
  const fallbackSeconds = Math.round(greetingTiming.fallbackMs / 1000);
  /** Race-event camera bookmarks — the second server-wide switch on the sheet. */
  const raceBookmarksOn = briefing.board?.raceBookmarks?.enabled !== false;
  /** Live video or stills on the room tiles — the third, and a choice rather
   *  than a switch. Anything unrecognised (or a station on an older deploy)
   *  reads as the default, the same way the server's getter does. */
  const cameraPreviewMode = parseCameraPreviewMode(briefing.board?.cameraPreview?.mode);

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
  /**
   * ONE SCAN IN FLIGHT, and it has to be a REF.
   *
   * The guard below used to read `scanState`, which is state — and the serial
   * read loop calls the `handleScan` captured when `startReading` was memoised
   * (on `token`, with exhaustive-deps disabled). That closure kept the FIRST
   * render's `scanState` forever, so the guard compared against "idle" for the
   * rest of the shift and never once fired.
   *
   * It went unnoticed while check-ins answered in a few hundred milliseconds.
   * On 2026-08-18, with Pandora hanging, a scan took ~9s — long enough for staff
   * to scan again, which posted a SECOND check-in concurrently; the two
   * responses then flashed in whatever order they returned, so the desk could
   * see the wrong guest's card. A ref is read at call time, so it cannot go
   * stale in a closure.
   */
  const scanBusyRef = useRef(false);

  // Settings
  const [baudRate, setBaudRate] = useState<number>(() => {
    if (typeof window === "undefined") return 9600;
    const saved = localStorage.getItem("checkin-scanner-baud");
    return saved ? Number(saved) : 9600;
  });
  const [showSettings, setShowSettings] = useState(false);

  /** The board's deadline alarm — one speaker for both columns, switched from
   *  the gear below and reported into by every RoomColumn. */
  const alarm = useDeskAlarm(token);

  /**
   * The window the SERVER is currently applying, for the gear to show as
   * selected. Read off the board rather than kept in local state, so the sheet
   * reflects what every other surface is using — including a change another
   * station made. Tracks can differ in theory (each screen carries its own);
   * the shortest is the one the desk is held to, so that is the one shown.
   */
  const checkinWindowNow = (() => {
    const all = Object.values(briefing.board?.checkinWindowMins ?? {}).filter(
      (n): n is number => typeof n === "number" && n > 0,
    );
    return all.length ? Math.min(...all) : null;
  })();

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

  // Test mode — ?test=1 opt-in, read at mount like the baud-rate setting
  const [testMode] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return new URLSearchParams(window.location.search).get("test") === "1";
  });
  const [testInput, setTestInput] = useState("");
  const [debugJson, setDebugJson] = useState<string>("");
  const [showDebug, setShowDebug] = useState(false);

  /**
   * MANUAL ENTRY, IN THE GEAR. The same box accepts every shape a scan can
   * arrive in — a wallet licence URL, an FT:/HP: QR, or a bare participant ID —
   * because the endpoint already branches on all three. So one field exercises
   * every flow without a badge, at any station, without the ?test=1 URL nobody
   * can be expected to remember.
   */
  const [manualInput, setManualInput] = useState("");
  const [manualBusy, setManualBusy] = useState(false);
  const [manualLine, setManualLine] = useState<string>("");

  // Self-test
  const [selfTestResult, setSelfTestResult] = useState<{
    tests: { name: string; pass: boolean; ms: number; detail?: string }[];
    allPassed: boolean;
  } | null>(null);
  const [showSelfTest, setShowSelfTest] = useState(false);

  /**
   * SCAN HISTORY. Loaded on open rather than polled — it is a diagnostic
   * someone reaches for when the desk feels slow, not a live board, and a
   * background poll would add traffic to the exact path being investigated.
   */
  const [showScanHistory, setShowScanHistory] = useState(false);
  /**
   * Gear look-ups are hidden by default. They are diagnostics someone ran on
   * purpose, and a handful of them buries the real scans this panel exists to
   * show — twenty in a minute is an easy afternoon's testing. The count is
   * still stated and one press brings them back, because silently dropping
   * rows would make the panel lie about what happened.
   */
  const [showLookups, setShowLookups] = useState(false);
  const [scanHistory, setScanHistory] = useState<ScanHistoryEntry[] | null>(null);
  const [scanStats, setScanStats] = useState<ScanHistoryStats | null>(null);
  const [scanHistoryLoading, setScanHistoryLoading] = useState(false);

  const loadScanHistory = useCallback(async () => {
    setScanHistoryLoading(true);
    try {
      const res = await fetch(
        `/api/admin/checkin?token=${encodeURIComponent(token)}&action=scan-history&limit=120`,
        { cache: "no-store" },
      );
      if (!res.ok) return;
      const json = await res.json();
      setScanHistory(Array.isArray(json?.entries) ? json.entries : []);
      setScanStats(json?.stats ?? null);
    } catch {
      /* leave whatever was already shown */
    } finally {
      setScanHistoryLoading(false);
    }
  }, [token]);

  /** Real scans by default; look-ups only when asked for. */
  const visibleScans = (scanHistory ?? []).filter((e) => showLookups || !e.dryRun);
  const hiddenLookupCount = showLookups ? 0 : (scanHistory ?? []).filter((e) => e.dryRun).length;

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
    /** NULL = the roster could not be read, NOT an empty heat. Rendered "—".
     *  See features/racing/roster-count.ts. */
    checkedIn: number | null;
    total: number | null;
    /** The count is the last one read rather than a fresh one — shown dimmed. */
    stale?: boolean;
    /** Square location id — rows now span FT/HP-FM AND Naples, whose
     *  separate BMI server can mint numerically identical sessionIds,
     *  so sessionId alone is not a unique row identity. */
    locationId?: string;
  }
  const [activeSessions, setActiveSessions] = useState<ActiveSession[]>([]);

  /**
   * Rows the session strip shows at THIS station. The strip aggregates
   * every venue (FT racing + called arena sessions at HP FM and Naples),
   * which is noise for a single desk — `?loc=` scopes the display. The
   * poll/API stays shared and unfiltered (several stations share one
   * server-side cache), and rows missing a locationId fail OPEN so a
   * mid-deploy cache row is over-shown rather than hidden from its desk.
   */
  const locScope = LOC_FILTERS[(locFilter ?? "").toLowerCase()] ?? null;
  const stripSessions = locScope
    ? activeSessions.filter((s) => !s.locationId || s.locationId === locScope.locationId)
    : activeSessions;

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

  useEffect(() => {
    // staleUptime: a tab past its max uptime recycles in the same quiet gap a
    // new build would — the reload is also this station's memory amnesty.
    if ((!buildUpdate.ready && !buildUpdate.staleUptime) || deskBusy) return;
    const t = setTimeout(() => {
      /**
       * HAND THE PORT BACK BEFORE GOING (2026-08-24, a live incident: the desk
       * beeped on every scan and registered none of them, and only a manual
       * disconnect/reconnect cleared it).
       *
       * A page teardown does not reliably run React cleanup, so the serial port
       * could still be held open by the outgoing context when the new one asks
       * for it — and `port.open()` then throws "already open", which lands the
       * station in `error` until a human presses the button. The scanner keeps
       * beeping the whole time, because the hardware read is fine; it is the
       * page that has gone deaf.
       *
       * That race was always possible and effectively never seen, because this
       * reload only fires on a new build. Eight deploys in one night is what
       * made it a nightly event. Closing first removes the race rather than
       * hoping to win it; the reload happens either way.
       */
      void disconnect().finally(() => window.location.reload());
    }, 60_000);
    return () => clearTimeout(t);
  }, [buildUpdate.ready, buildUpdate.staleUptime, deskBusy, disconnect]);

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

  /**
   * AUTO-CONNECT ON MOUNT — and RETRY, because the one moment this runs is the
   * one moment it is most likely to lose.
   *
   * It fires immediately after a reload, which is exactly when the outgoing
   * page may still be holding the port for another fraction of a second. A
   * single attempt therefore failed with "already open" and left the desk in
   * `error` for the rest of the shift with nobody realising the scanner was
   * deaf (2026-08-24 incident). Three tries over ~2s costs nothing and covers
   * the handover; a port genuinely held by ANOTHER TAB still ends in the error
   * that names it, because that one a human does have to fix.
   */
  useEffect(() => {
    if (!("serial" in navigator)) return;
    let cancelled = false;
    (async () => {
      for (let attempt = 0; attempt < 3 && !cancelled; attempt++) {
        try {
          const ports = await navigator.serial.getPorts();
          // No previously authorised port: nothing to reopen, and no amount of
          // retrying will conjure one — it needs the staff gesture.
          if (ports.length === 0) return;
          await connectToPort(ports[0]);
          if (portRef.current) return;
        } catch {
          // Fall through to the wait below and try again.
        }
        await new Promise((r) => setTimeout(r, 700));
      }
    })();
    return () => {
      cancelled = true;
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
    // See scanBusyRef — this MUST NOT be read off `scanState`.
    if (scanBusyRef.current) return;
    scanBusyRef.current = true;
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
        sound.play("negative");
      } else {
        setLastResult(json as CheckinResponse);
        setScanState("result");
        /**
         * TONE FOLLOWS COLOUR. This is the same three-way split `getFlashColor`
         * renders: only a currently-checking-in scan is a check-in, so a yellow
         * "not checking in yet" gets the negative tone even though the request
         * succeeded. The desk must never hear success for a racer who was not
         * written in.
         */
        sound.play((json as CheckinResponse).currentlyCheckingIn ? "success" : "negative");
      }
    } catch (e) {
      setLastError(e instanceof Error ? e.message : "Network error");
      setScanState("result");
      sound.play("negative");
    } finally {
      // Released the moment this scan has ANSWERED, not when its flash clears:
      // the desk must be able to scan the next racer straight away. `finally`
      // so a thrown render or an aborted fetch can never wedge the scanner for
      // the rest of the shift.
      scanBusyRef.current = false;
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

  /**
   * DRY RUN — resolve the racer and report, writing NOTHING.
   *
   * Deliberately does not go through `handleScan`: it must not flash the
   * screen, must not play a verdict tone, and must not touch `scanBusyRef`,
   * because a staff member poking at the gear mid-shift cannot be allowed to
   * block the reader for a real racer standing at the desk.
   *
   * The server half is what guarantees "writes nothing" — see `dryRun` in the
   * route. This end only asks for it.
   */
  async function runManualLookup() {
    const raw = manualInput.trim();
    if (!raw || manualBusy) return;
    setManualBusy(true);
    setManualLine("");
    const startedAt = Date.now();
    try {
      const res = await fetch(`/api/admin/checkin?token=${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ raw, dryRun: true }),
        cache: "no-store",
      });
      const json = await res.json();
      setDebugJson(JSON.stringify({ request: { raw, dryRun: true }, response: json }, null, 2));
      setManualLine(summariseDryRun(json, res.ok, Date.now() - startedAt));
    } catch (e) {
      setManualLine(`Failed — ${e instanceof Error ? e.message : "network error"}`);
    } finally {
      setManualBusy(false);
    }
  }

  /** Run the real thing, side effects and all — same path as a badge. */
  function runManualCheckIn() {
    const raw = manualInput.trim();
    if (!raw) return;
    handleScan(raw);
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

        {/*
          ALREADY IN — a re-scan of the same racer into the same heat.
          Still green, because the racer really is checked in and telling staff
          otherwise would send them chasing a problem that does not exist. What
          this has to prevent is the SECOND headsock: the deduction did not run,
          so the amber "Headsock Due" banner above is correctly absent, and this
          says why in case anyone was expecting it.
        */}
        {lastResult?.alreadyCheckedIn && !lastError && (
          <div
            className="absolute top-0 left-0 right-0 py-4 px-6 text-center"
            style={{ backgroundColor: "#0f172a", borderBottom: `4px solid ${PORTAL_BLUE}` }}
          >
            <p
              className="font-black uppercase tracking-wider leading-none"
              style={{ fontSize: "clamp(26px, 5vw, 44px)", color: "#ffffff" }}
            >
              Already checked in
            </p>
            <p
              className="text-base sm:text-lg font-bold mt-2 uppercase"
              style={{ color: "#cbd5e1" }}
            >
              Nothing to do — do not hand another headsock
            </p>
          </div>
        )}

        {/* Warning banner — session not checking in, show their booked session so staff can redirect */}
        {isWarning && !lastError && lastResult?.guest && (
          <div className="absolute top-0 left-0 right-0 bg-amber-500 py-4 px-6 text-center">
            <p className="text-black font-bold text-lg uppercase">Not checking in yet</p>
            {lastResult.session.track && (
              <p className="text-black/80 text-base font-semibold mt-1">
                Their session: {lastResult.session.track} {lastResult.session.raceType}
                {lastResult.session.host ? ` · ${lastResult.session.host}` : ""}{" "}
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
                {lastResult.session.track} {lastResult.session.raceType}
                {lastResult.session.host ? ` · ${lastResult.session.host}` : ""}{" "}
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
      {/*
        LOOKING UP — the whole screen, immediately, for as long as it takes.

        A scan used to show a 32px spinner tucked under "Waiting for scan...",
        and in board mode that panel is not rendered at all, so the busiest
        station in the building had NO indication a scan was in flight. Staff
        re-scanned racers who were already being looked up.

        It is an OVERLAY, not an early return, on purpose: returning different
        JSX here would unmount the briefing panels and the camera tiles on every
        single scan, and they would remount and refetch when it cleared. The
        board underneath keeps running; this just covers it.

        No delay threshold (owner: show it on every scan). It clears the instant
        the result lands, so on a fast scan it reads as a blink and on a slow one
        it is the thing that stops a second scan being fired at the same racer.
      */}
      {scanState === "processing" && (
        <div
          className="fixed inset-0 z-[60] flex flex-col items-center justify-center gap-8 px-6"
          style={{ backgroundColor: "#1b1f26f2", backdropFilter: "blur(2px)" }}
          role="status"
          aria-live="polite"
        >
          <div
            className="rounded-full animate-spin"
            style={{
              width: 84,
              height: 84,
              border: `6px solid ${PORTAL_DARK.border}`,
              borderTopColor: PORTAL_BLUE,
            }}
          />
          <p
            className="font-bold uppercase tracking-widest text-center"
            style={{ fontSize: "clamp(28px, 5vw, 48px)", color: PORTAL_DARK.fg }}
          >
            Finding racer
          </p>
          <p className="text-center" style={{ fontSize: 18, color: PORTAL_DARK.muted }}>
            Hold the badge — do not scan again
          </p>
        </div>
      )}

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
                className="px-3 py-1.5 rounded-lg border text-xs hover:bg-white/5 inline-flex items-center gap-1.5"
                style={{
                  borderColor: PORTAL_DARK.border,
                  color: PORTAL_DARK.muted,
                  borderRadius: 8,
                }}
                title={
                  waitTimesBehind(briefing.waitTimes)
                    ? "The last hour is running meaningfully behind today — open for the numbers"
                    : undefined
                }
              >
                {/* THE VERDICT ON THE BUTTON — the matrix already computes
                    "meaningfully slower than today"; since the metrics moved
                    behind this button the answer only existed once opened.
                    Amber, never red, per the board's own colour rule. */}
                {waitTimesBehind(briefing.waitTimes) && (
                  <span
                    className="w-2 h-2 rounded-full"
                    style={{ background: AMBER }}
                    aria-label="Running behind today"
                  />
                )}
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
            onClick={() => {
              setShowScanHistory(true);
              void loadScanHistory();
            }}
            className="px-3 py-1.5 rounded-lg border text-xs hover:bg-white/5"
            style={{ borderColor: PORTAL_DARK.border, color: PORTAL_DARK.muted, borderRadius: 8 }}
          >
            Scan history
          </button>
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
      {!boardMode && stripSessions.length > 0 && (
        <div
          className="flex gap-3 px-6 py-3 border-b overflow-x-auto"
          style={{ borderColor: PORTAL_DARK.border }}
        >
          {locScope && (
            <div className="flex items-center shrink-0 pr-1">
              <p
                className="text-[10px] font-bold uppercase tracking-wider"
                style={{ color: PORTAL_DARK.muted }}
                title="This station's ?loc= bookmark scopes the counts strip — scanning is unaffected. Drop the ?loc= to see every venue."
              >
                {locScope.label}
                <br />
                only
              </p>
            </div>
          )}
          {stripSessions.map((s) => {
            const color = TRACK_COLORS[s.track.toLowerCase()] ?? PORTAL_BLUE;
            return (
              <div
                key={`${s.locationId ?? ""}:${s.sessionId}`}
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
                  {/* A COUNT WE DO NOT HAVE READS "—", NEVER "0/0". Zero is a
                      claim that nobody is booked on the heat; the dash says the
                      roster read did not come back, which is a different thing
                      and the one staff need to tell apart. A count carried over
                      from the last good read is dimmed rather than hidden. */}
                  <p
                    className="font-black text-xl leading-none"
                    style={{ color: s.stale ? PORTAL_DARK.muted : PORTAL_DARK.fg }}
                    title={
                      s.stale ? "Last known count — the latest read did not come back" : undefined
                    }
                  >
                    {s.total === null ? (
                      "—"
                    ) : (
                      <>
                        {s.checkedIn}
                        <span className="text-sm font-normal" style={{ color: PORTAL_DARK.muted }}>
                          /{s.total}
                        </span>
                      </>
                    )}
                  </p>
                  <p className="text-[10px] uppercase" style={{ color: PORTAL_DARK.muted }}>
                    {s.total === null ? "no roster read" : s.stale ? "last known" : "checked in"}
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
            SCAN SOUND — this PC's own setting, like the baud rate above and
            unlike the two server switches below. Flipping it on plays the
            success tone immediately, because a silent toggle gives a staff
            member no way to tell whether the speakers are muted, the volume is
            down, or the setting simply did not take.
          */}
          <div className="mt-4 pt-4 border-t" style={{ borderColor: PORTAL_DARK.border }}>
            <p className="block text-xs mb-2" style={{ color: PORTAL_DARK.muted }}>
              Scan sound
            </p>
            <div className="flex gap-2 items-center" style={{ flexWrap: "wrap" }}>
              <button
                type="button"
                role="switch"
                aria-checked={sound.enabled}
                onClick={() => sound.setEnabled(!sound.enabled)}
                className="px-3 py-1.5 text-xs border hover:bg-white/5"
                style={{
                  borderRadius: 8,
                  borderColor: sound.enabled ? GREEN : PORTAL_DARK.inputBorder,
                  backgroundColor: sound.enabled ? `${GREEN}22` : "transparent",
                  color: sound.enabled ? GREEN : PORTAL_DARK.muted,
                }}
              >
                {sound.enabled ? "On" : "Off"}
              </button>
              <button
                type="button"
                onClick={() => sound.preview("success")}
                className="px-3 py-1.5 text-xs border hover:bg-white/5"
                style={{
                  borderRadius: 8,
                  borderColor: PORTAL_DARK.inputBorder,
                  color: PORTAL_DARK.muted,
                }}
              >
                Hear checked in
              </button>
              <button
                type="button"
                onClick={() => sound.preview("negative")}
                className="px-3 py-1.5 text-xs border hover:bg-white/5"
                style={{
                  borderRadius: 8,
                  borderColor: PORTAL_DARK.inputBorder,
                  color: PORTAL_DARK.muted,
                }}
              >
                Hear not checked in
              </button>
            </div>
            <p className="text-xs mt-2" style={{ color: PORTAL_DARK.muted }}>
              A tone on every scan: one for checked in, another for anything else — including a
              racer whose heat has not been called. This station only.
            </p>
          </div>

          {/*
            DEADLINE ALARM — this PC's speaker, like the scan sound above. Two
            moments cost a race if they pass with heads down (owner 2026-08-23),
            so both get a sound: a call about to go late, and a briefing window
            about to shut on a group who have been waiting. Three plays, ten
            seconds apart, then silence — a sound that nags forever is a sound
            that gets muted, and then neither alarm works again.
          */}
          <div className="mt-4 pt-4 border-t" style={{ borderColor: PORTAL_DARK.border }}>
            <p className="block text-xs mb-2" style={{ color: PORTAL_DARK.muted }}>
              Deadline alarm
            </p>
            <div className="flex gap-2 items-center" style={{ flexWrap: "wrap" }}>
              <button
                type="button"
                role="switch"
                aria-checked={alarm.enabled}
                onClick={() => alarm.setEnabled(!alarm.enabled)}
                className="px-3 py-1.5 text-xs border hover:bg-white/5"
                style={{
                  borderRadius: 8,
                  borderColor: alarm.enabled ? GREEN : PORTAL_DARK.inputBorder,
                  backgroundColor: alarm.enabled ? `${GREEN}22` : "transparent",
                  color: alarm.enabled ? GREEN : PORTAL_DARK.muted,
                }}
              >
                {alarm.enabled ? "On" : "Off"}
              </button>
              <button
                type="button"
                onClick={alarm.preview}
                className="px-3 py-1.5 text-xs border hover:bg-white/5"
                style={{
                  borderRadius: 8,
                  borderColor: PORTAL_DARK.inputBorder,
                  color: PORTAL_DARK.muted,
                }}
              >
                Hear it
              </button>
            </div>
            <p className="text-xs mt-2" style={{ color: PORTAL_DARK.muted }}>
              Sounds three times over the last 30 seconds when a session is about to be called late,
              or when a called group&apos;s briefing window is closing. This station only.
            </p>

            {/*
              THE SAME TWO ALERTS, ON A PHONE. The sound above needs somebody
              within earshot of this PC; a manager walking the pits is not, and
              these are the two deadlines worth interrupting a walk for. Any
              board left open does the triggering, so a registered phone buzzes
              whether or not it is the device looking at the board.
            */}
            <div className="mt-3 pt-3 border-t" style={{ borderColor: PORTAL_DARK.border }}>
              <p className="block text-xs mb-2" style={{ color: PORTAL_DARK.muted }}>
                Alert this device
              </p>
              {briefing.board?.push?.configured ? (
                <>
                  <div className="flex gap-2 items-center" style={{ flexWrap: "wrap" }}>
                    <button
                      type="button"
                      disabled={alarm.pushBusy}
                      onClick={() => {
                        const key = briefing.board?.push?.publicKey;
                        if (!key) return;
                        if (alarm.pushRegistered) void alarm.unregisterPush();
                        else void alarm.registerPush(key);
                      }}
                      className="px-3 py-1.5 text-xs border hover:bg-white/5"
                      style={{
                        borderRadius: 8,
                        borderColor: alarm.pushRegistered ? GREEN : PORTAL_DARK.inputBorder,
                        backgroundColor: alarm.pushRegistered ? `${GREEN}22` : "transparent",
                        color: alarm.pushRegistered ? GREEN : PORTAL_DARK.muted,
                        opacity: alarm.pushBusy ? 0.5 : 1,
                      }}
                    >
                      {alarm.pushBusy
                        ? "Working…"
                        : alarm.pushRegistered
                          ? "This device is alerted"
                          : "Alert this device"}
                    </button>
                    <span className="text-xs" style={{ color: PORTAL_DARK.muted }}>
                      {briefing.board.push.devices === 1
                        ? "1 device registered"
                        : `${briefing.board.push.devices ?? 0} devices registered`}
                    </span>
                  </div>
                  <p className="text-xs mt-2" style={{ color: PORTAL_DARK.muted }}>
                    Sends a notification to this phone or PC even when the board is not on screen.
                    Open this page on a phone and press it there to add that phone.
                  </p>

                  {/*
                    TEST BUTTONS (owner 2026-08-24: "give some buttons to test
                    push alerts"). They run the REAL fan-out — same subscriptions,
                    same push services, same service worker — so a phone that
                    buzzes here will buzz for a real deadline. Only the
                    once-per-slot claim is skipped, because that dedupe would
                    swallow the second press of a test button, and the words say
                    TEST so nobody reads a lock screen and starts running.

                    One per cue rather than a single "send something": each has
                    its own copy, and the point of testing is to see the words
                    that will actually arrive.
                  */}
                  <div className="mt-3 pt-3 border-t" style={{ borderColor: PORTAL_DARK.border }}>
                    <p className="block text-xs mb-2" style={{ color: PORTAL_DARK.muted }}>
                      Test an alert on every registered device
                    </p>
                    <div className="flex gap-2" style={{ flexWrap: "wrap" }}>
                      {(
                        [
                          { kind: "call" as const, label: "Call going late" },
                          { kind: "send" as const, label: "Briefing window closing" },
                          { kind: "pull" as const, label: "Pull to briefing now" },
                        ] satisfies Array<{ kind: AlarmKind; label: string }>
                      ).map((t) => (
                        <button
                          key={t.kind}
                          type="button"
                          disabled={!briefing.board || (briefing.board.push?.devices ?? 0) === 0}
                          onClick={() => briefing.testPush(t.kind)}
                          className="px-3 py-1.5 text-xs border hover:bg-white/5"
                          style={{
                            borderRadius: 8,
                            borderColor: PORTAL_DARK.inputBorder,
                            color: PORTAL_DARK.fg,
                            opacity:
                              briefing.board && (briefing.board.push?.devices ?? 0) > 0 ? 1 : 0.4,
                          }}
                        >
                          {t.label}
                        </button>
                      ))}
                    </div>
                    <p className="text-xs mt-2" style={{ color: PORTAL_DARK.muted }}>
                      {(briefing.board?.push?.devices ?? 0) === 0
                        ? "No devices registered yet — press “Alert this device” above first."
                        : "Goes to every registered device, not just this one. The notification says TEST."}
                    </p>
                  </div>
                </>
              ) : (
                /* Honest about the blocker rather than offering a button that
                   cannot work: with no VAPID keys there is no identity to push
                   under. */
                <p className="text-xs" style={{ color: AMBER }}>
                  Not set up — VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are not set on this
                  deployment. The sound above still works.
                </p>
              )}
            </div>
          </div>

          {/*
            THE CHECK-IN WINDOW — how long a called racer has to reach the desk
            (owner 2026-08-23: "make this a setting in the gear of the check in
            board"). A SERVER setting, unlike the two above: the track TVs count
            the same guest down against this number, and a desk on 7 while the
            wall says 8 puts the guest's clock and the staff's out of step.
            "Track screens" hands it back to the signage configs.
          */}
          <div className="mt-4 pt-4 border-t" style={{ borderColor: PORTAL_DARK.border }}>
            <p className="block text-xs mb-2" style={{ color: PORTAL_DARK.muted }}>
              Check-in window
            </p>
            <div className="flex gap-2 items-center" style={{ flexWrap: "wrap" }}>
              {[5, 6, 7, 8, 10].map((mins) => {
                const on = checkinWindowNow === mins;
                return (
                  <button
                    key={mins}
                    type="button"
                    onClick={() => briefing.setCheckinWindow(mins)}
                    className="px-3 py-1.5 text-xs border hover:bg-white/5"
                    style={{
                      borderRadius: 8,
                      borderColor: on ? PORTAL_BLUE : PORTAL_DARK.inputBorder,
                      backgroundColor: on ? `${PORTAL_BLUE}33` : "transparent",
                      color: on ? PORTAL_BLUE_SOFT : PORTAL_DARK.muted,
                    }}
                  >
                    {mins} min
                  </button>
                );
              })}
              <button
                type="button"
                onClick={() => briefing.setCheckinWindow(null)}
                className="px-3 py-1.5 text-xs border hover:bg-white/5"
                style={{
                  borderRadius: 8,
                  borderColor: PORTAL_DARK.inputBorder,
                  color: PORTAL_DARK.muted,
                }}
              >
                Track screens
              </button>
            </div>
            <p className="text-xs mt-2" style={{ color: PORTAL_DARK.muted }}>
              {checkinWindowNow
                ? `Racers have ${checkinWindowNow} minutes from the call to reach the desk. Every board and TV follows this within one poll.`
                : "Waiting for the board to report the current window."}
            </p>
          </div>

          {/*
            MANUAL ENTRY — every scan shape, no badge, no ?test=1 URL.
            "Look up" writes NOTHING: no check-in, no headsock deduction, no
            lobby-TV event. That distinction is enforced on the server, not here,
            and it is the whole reason this is safe to hand to a desk mid-shift.
          */}
          <div className="mt-4 pt-4 border-t" style={{ borderColor: PORTAL_DARK.border }}>
            <p className="block text-xs mb-2" style={{ color: PORTAL_DARK.muted }}>
              Manual entry
            </p>
            <div className="flex gap-2 mb-2" style={{ flexWrap: "wrap" }}>
              <input
                type="text"
                value={manualInput}
                onChange={(e) => setManualInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") runManualLookup();
                }}
                placeholder="Licence code or link, FT:… QR, or participant ID"
                aria-label="Licence, QR or participant ID to look up"
                className="flex-1 px-3 py-2 text-sm placeholder-white/30 focus:outline-none focus:border-blue-400"
                style={{
                  minWidth: 240,
                  backgroundColor: PORTAL_DARK.inputBg,
                  border: `1px solid ${PORTAL_DARK.inputBorder}`,
                  color: PORTAL_DARK.fg,
                  borderRadius: 8,
                  fontFamily: ADMIN_MONO,
                }}
              />
              <button
                type="button"
                onClick={runManualLookup}
                disabled={manualBusy || !manualInput.trim()}
                className="px-4 py-2 font-bold text-sm"
                style={{
                  backgroundColor: PORTAL_BLUE,
                  color: "#ffffff",
                  borderRadius: 8,
                  opacity: manualBusy || !manualInput.trim() ? 0.5 : 1,
                }}
              >
                {manualBusy ? "Looking up…" : "Look up"}
              </button>
              <button
                type="button"
                onClick={runManualCheckIn}
                disabled={!manualInput.trim()}
                className="px-4 py-2 font-bold text-sm border"
                style={{
                  borderColor: AMBER,
                  color: AMBER,
                  backgroundColor: "transparent",
                  borderRadius: 8,
                  opacity: manualInput.trim() ? 1 : 0.5,
                }}
              >
                Check in for real
              </button>
            </div>
            {manualLine && (
              <p
                className="text-xs mt-1"
                style={{
                  color: PORTAL_DARK.fg,
                  fontFamily: ADMIN_MONO,
                  wordBreak: "break-word",
                }}
              >
                {manualLine}
              </p>
            )}
            <p className="text-xs mt-2" style={{ color: PORTAL_DARK.muted }}>
              Look up reports what would happen and writes nothing. Check in for real is identical
              to scanning the badge.
            </p>
          </div>

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
            WELCOME-BACK GREETING BY MOTION — the same camera, a different job
            (owner 2026-08-23: "I'd like this option in the settings of check
            in board where we have the other motion option"). ON, the room TV
            starts the greeting when the camera first sees the returning group
            walk in; OFF, it is a plain 45-second timer after the post call.
            Its own switch rather than a mode of auto-holding for the same
            reason bookmarks are: they share a camera and nothing else — that
            one moves groups, this one only times a sound.
          */}
          {/*
            SENDING WITH NO TIME LEFT — allowed with a warning, or blocked
            outright (owner 2026-08-24: "instead of complete lock on send to
            briefing, allow it but prompt a big warning message… actually make
            this a toggle in settings (gear). Default to allow the override").

            ON is the default and the kinder setting: staff keep the press and
            the board asks a full question first. OFF is the 8/23 hard lock, for
            a venue that would rather the rule decided. Either way the desk and
            the room tablets read this one value, so they cannot disagree.
          */}
          <div className="mt-4 pt-4 border-t" style={{ borderColor: PORTAL_DARK.border }}>
            <p className="block text-xs mb-2" style={{ color: PORTAL_DARK.muted }}>
              Allow sending with no time for the film
            </p>
            <button
              type="button"
              role="switch"
              aria-checked={sendOverrideOn}
              disabled={!briefing.board}
              onClick={() => briefing.setSendOverride(!sendOverrideOn)}
              className="px-3 py-1.5 text-xs border hover:bg-white/5"
              style={{
                borderRadius: 8,
                borderColor: sendOverrideOn ? GREEN : PORTAL_DARK.inputBorder,
                backgroundColor: sendOverrideOn ? `${GREEN}22` : "transparent",
                color: sendOverrideOn ? GREEN : PORTAL_DARK.muted,
                opacity: briefing.board ? 1 : 0.5,
              }}
            >
              {sendOverrideOn ? "Allowed" : "Blocked"}
            </button>
            <p className="text-xs mt-2" style={{ color: PORTAL_DARK.muted }}>
              {sendOverrideOn
                ? "Once the film can no longer finish before the race in front ends, Send still works but asks first, naming the race, its clock and the film that will not fit. The room tablets ask the same question."
                : "Once the film can no longer finish before the race in front ends, Send goes dead until the returning group's post-race call has played. The room tablets refuse the pull too."}{" "}
              Applies to every check-in station and both room tablets, not just this one.
            </p>
          </div>

          <div className="mt-4 pt-4 border-t" style={{ borderColor: PORTAL_DARK.border }}>
            <p className="block text-xs mb-2" style={{ color: PORTAL_DARK.muted }}>
              Welcome-back greeting by motion
            </p>
            <button
              type="button"
              role="switch"
              aria-checked={greetingByMotionOn}
              disabled={!briefing.board}
              onClick={() => briefing.setGreetingByMotion(!greetingByMotionOn)}
              className="px-3 py-1.5 text-xs border hover:bg-white/5"
              style={{
                borderRadius: 8,
                borderColor: greetingByMotionOn ? GREEN : PORTAL_DARK.inputBorder,
                backgroundColor: greetingByMotionOn ? `${GREEN}22` : "transparent",
                color: greetingByMotionOn ? GREEN : PORTAL_DARK.muted,
                opacity: briefing.board ? 1 : 0.5,
              }}
            >
              {greetingByMotionOn ? "On" : "Off"}
            </button>
            {/* The copy quotes the CONFIGURED delay, not a literal — the number
                below is settable, and a sentence that kept saying "45" would be
                wrong the moment somebody changed it. */}
            <p className="text-xs mt-2" style={{ color: PORTAL_DARK.muted }}>
              {greetingByMotionOn
                ? `The room TV plays the welcome-back message once its camera sees the group actually walk in — typically 15–30 seconds after the first person enters. If the camera can't answer, it falls back to the ${fallbackSeconds}-second timer.`
                : `The room TV plays the welcome-back message ${fallbackSeconds} seconds after the post-race call, whether anyone is in the room or not.`}{" "}
              Pro sessions never get the message either way. This setting applies to every check-in
              station, not just this one.
            </p>

            {/*
              THE GREETING'S THREE NUMBERS (owner 2026-08-23: "add these
              settings to the check in board gear settings"). Nested under the
              switch rather than given their own sections, because they only
              describe that one thing — and the delay stays meaningful with the
              switch off, which is exactly what it becomes.

              SEGMENTED CHOICES, not typed numbers, for the same reason the baud
              rate above is buttons: there is no validation to get wrong and no
              way to leave a half-typed value on a room full of guests. The list
              here matches the one the server accepts (the choice arrays in
              briefing/return-greeting.ts), so the two cannot drift.
            */}
            <div className="mt-3 grid gap-3">
              <GreetingChoiceRow
                label="Greeting delay when the camera can't answer"
                value={greetingTiming.fallbackMs}
                options={[
                  { value: 30_000, label: "30s" },
                  { value: 45_000, label: "45s" },
                  { value: 60_000, label: "60s" },
                  { value: 90_000, label: "90s" },
                ]}
                disabled={!briefing.board}
                onPick={(fallbackMs) => briefing.setGreetingTiming({ fallbackMs })}
              />
              <GreetingChoiceRow
                label="Times the greeting repeats"
                value={greetingTiming.maxPlays}
                options={[
                  { value: 1, label: "Once" },
                  { value: 2, label: "2×" },
                  { value: 3, label: "3×" },
                  { value: 4, label: "4×" },
                ]}
                disabled={!briefing.board}
                onPick={(maxPlays) => briefing.setGreetingTiming({ maxPlays })}
              />
              <GreetingChoiceRow
                label="Still-in-the-room reminder after"
                value={greetingTiming.lingerAfterMs}
                options={[
                  { value: 60_000, label: "1 min" },
                  { value: 120_000, label: "2 min" },
                  { value: 180_000, label: "3 min" },
                  { value: 300_000, label: "5 min" },
                ]}
                disabled={!briefing.board}
                onPick={(lingerAfterMs) => briefing.setGreetingTiming({ lingerAfterMs })}
              />
              <p className="text-xs" style={{ color: PORTAL_DARK.muted }}>
                The reminder needs its own clip uploaded on the Lobby TVs page, and only plays while
                the greeting is following the camera. However these are set, the greeting always
                stops 2 minutes after the post-race call.
              </p>
            </div>
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

          {/*
            ROOM PREVIEWS — the third server-wide setting, and the only one that
            is a CHOICE rather than a switch (owner 2026-08-16: "can we select in
            board settings and save for all?").

            Two buttons, not a toggle, because neither position is "off": the
            tiles show the room either way. What changes is who does the work —
            live plays video the Nx server transcodes per tile per station,
            stills pull a JPEG a second through our own proxy and cost the
            camera server nothing. The copy names that trade rather than the
            resolutions, because the reason to reach for this at 9pm is that the
            cameras have gone slow.
          */}
          <div className="mt-4 pt-4 border-t" style={{ borderColor: PORTAL_DARK.border }}>
            <p className="block text-xs mb-2" style={{ color: PORTAL_DARK.muted }}>
              Room camera previews
            </p>
            <div className="flex gap-2">
              {(
                [
                  { mode: "live" as const, label: "Live video" },
                  { mode: "stills" as const, label: "Stills" },
                ] satisfies ReadonlyArray<{ mode: CameraPreviewMode; label: string }>
              ).map(({ mode, label }) => {
                const on = cameraPreviewMode === mode;
                return (
                  <button
                    key={mode}
                    type="button"
                    aria-pressed={on}
                    disabled={!briefing.board}
                    onClick={() => briefing.setCameraPreview(mode)}
                    className="px-3 py-1.5 text-xs border hover:bg-white/5"
                    style={{
                      borderRadius: 8,
                      borderColor: on ? GREEN : PORTAL_DARK.inputBorder,
                      backgroundColor: on ? `${GREEN}22` : "transparent",
                      color: on ? GREEN : PORTAL_DARK.muted,
                      opacity: briefing.board ? 1 : 0.5,
                    }}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
            <p className="text-xs mt-2" style={{ color: PORTAL_DARK.muted }}>
              {cameraPreviewMode === "live"
                ? "The room tiles play moving video, and the full-screen viewer plays it sharp. Each open tile is one transcode on the camera server — drop to Stills if the cameras start lagging."
                : "The room tiles refresh a picture a second through our own proxy, and the camera server does no extra work. You still see the room; you just will not see it move."}{" "}
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
            {/* The in-flight spinner that used to sit here is gone — the
                full-screen "Finding racer" overlay covers this panel now, and
                it also covers board mode, where this panel is never rendered. */}
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
      {boardMode && (
        <RaceControlPanels
          control={briefing}
          checkinCounts={activeSessions}
          // The same fact the amber strip above announces — the Called boxes
          // repeat it beside the count it starves. Only where a scanner could
          // exist at all: a browser with no serial support is not an outage.
          scannerOffline={
            serialSupported && connectionState !== "ready" && connectionState !== "connecting"
          }
          onAlarmCue={alarm.fire}
        />
      )}

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
      {/*
        SCAN HISTORY — what the desk actually experienced, per scan.
        Reads the ring buffer every POST writes. The header aggregates come from
        the server (summariseScans) rather than being recomputed here, so the
        summary and the rows can never tell different stories.
      */}
      {showScanHistory && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-start justify-center px-4 py-8 overflow-y-auto"
          {...modalBackdropProps(() => setShowScanHistory(false))}
        >
          <div
            className="p-6 w-full"
            style={{
              maxWidth: 880,
              backgroundColor: PORTAL_DARK.card,
              border: `1px solid ${PORTAL_DARK.border}`,
              borderRadius: 8,
              fontFamily: ADMIN_SANS,
            }}
          >
            <div className="flex items-center justify-between mb-4" style={{ gap: 12 }}>
              <h2 className="font-bold text-lg" style={{ color: PORTAL_DARK.fg }}>
                Scan history
              </h2>
              <div className="flex items-center gap-2">
                {/* Only offered when there is something hidden to reveal. */}
                {(showLookups || hiddenLookupCount > 0) && (
                  <button
                    type="button"
                    aria-pressed={showLookups}
                    onClick={() => setShowLookups(!showLookups)}
                    className="px-3 py-1.5 rounded-lg border text-xs hover:bg-white/5"
                    style={{
                      borderColor: showLookups ? PORTAL_BLUE : PORTAL_DARK.border,
                      color: showLookups ? PORTAL_BLUE_SOFT : PORTAL_DARK.muted,
                      borderRadius: 8,
                    }}
                  >
                    {showLookups ? "Hide look-ups" : `Show ${hiddenLookupCount} look-ups`}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => void loadScanHistory()}
                  className="px-3 py-1.5 rounded-lg border text-xs hover:bg-white/5"
                  style={{
                    borderColor: PORTAL_DARK.border,
                    color: PORTAL_DARK.muted,
                    borderRadius: 8,
                  }}
                >
                  {scanHistoryLoading ? "Loading…" : "Refresh"}
                </button>
                <button
                  type="button"
                  onClick={() => setShowScanHistory(false)}
                  className="px-3 py-1.5 rounded-lg border text-xs hover:bg-white/5"
                  style={{
                    borderColor: PORTAL_DARK.border,
                    color: PORTAL_DARK.muted,
                    borderRadius: 8,
                  }}
                >
                  Close
                </button>
              </div>
            </div>

            {/* Aggregates. Median before mean on purpose — one 9s upstream
                timeout in a hundred fast scans drags a mean somewhere no real
                scan ever was. */}
            {scanStats && (
              <div
                className="flex mb-4"
                style={{ flexWrap: "wrap", gap: 16, fontFamily: ADMIN_MONO, fontSize: 12 }}
              >
                {(
                  [
                    ["scans", String(scanStats.n)],
                    ["median", fmtScanMs(scanStats.medianMs)],
                    ["p95", fmtScanMs(scanStats.p95Ms)],
                    ["slowest", fmtScanMs(scanStats.slowestMs)],
                  ] as const
                ).map(([label, value]) => (
                  <span key={label} style={{ color: PORTAL_DARK.muted }}>
                    {label}{" "}
                    <strong style={{ color: PORTAL_DARK.fg, fontWeight: 700 }}>{value}</strong>
                  </span>
                ))}
                {/* Merged by display label, so the two e-ticket shapes read as
                    one count here rather than as two things a desk has to
                    reconcile. The split is still in the row tooltips. */}
                {Object.entries(
                  Object.entries(scanStats.byKind).reduce<Record<string, number>>((acc, [k, n]) => {
                    const { label } = scanKindLabel(k);
                    acc[label] = (acc[label] ?? 0) + n;
                    return acc;
                  }, {}),
                ).map(([label, n]) => (
                  <span key={label} style={{ color: PORTAL_DARK.muted }}>
                    {label} <strong style={{ color: PORTAL_DARK.fg }}>{n}</strong>
                  </span>
                ))}
              </div>
            )}

            {scanHistory === null ? (
              <p className="text-sm" style={{ color: PORTAL_DARK.muted }}>
                Loading…
              </p>
            ) : visibleScans.length === 0 ? (
              <p className="text-sm" style={{ color: PORTAL_DARK.muted }}>
                {hiddenLookupCount > 0
                  ? `No real scans yet — only ${hiddenLookupCount} gear look-up${
                      hiddenLookupCount === 1 ? "" : "s"
                    }, which wrote nothing.`
                  : "No scans recorded yet. The buffer fills as badges are scanned, and clears after two weeks of quiet."}
              </p>
            ) : (
              <div style={{ maxHeight: "60vh", overflowY: "auto" }}>
                <table
                  style={{ width: "100%", borderCollapse: "collapse", fontFamily: ADMIN_MONO }}
                >
                  <thead>
                    <tr style={{ color: PORTAL_DARK.muted, fontSize: 11, textAlign: "left" }}>
                      <th style={{ padding: "6px 8px", fontWeight: 500 }}>Time</th>
                      <th style={{ padding: "6px 8px", fontWeight: 500 }}>Scanned</th>
                      <th style={{ padding: "6px 8px", fontWeight: 500 }}>Result</th>
                      <th
                        style={{ padding: "6px 8px", fontWeight: 500, textAlign: "right" }}
                        title="Total server time for this scan"
                      >
                        Took
                      </th>
                      <th style={{ padding: "6px 8px", fontWeight: 500 }}>Heat</th>
                      <th style={{ padding: "6px 8px", fontWeight: 500 }}>Who</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleScans.map((e, i) => (
                      <tr
                        key={`${e.atMs}-${i}`}
                        style={{
                          borderTop: `1px solid ${PORTAL_DARK.border}`,
                          fontSize: 12,
                          opacity: e.dryRun ? 0.55 : 1,
                        }}
                      >
                        <td
                          style={{
                            padding: "6px 8px",
                            color: PORTAL_DARK.muted,
                            whiteSpace: "nowrap",
                          }}
                        >
                          {new Date(e.atMs).toLocaleTimeString("en-US", {
                            hour: "numeric",
                            minute: "2-digit",
                            second: "2-digit",
                            timeZone: "America/New_York",
                          })}
                        </td>
                        <td style={{ padding: "6px 8px", color: PORTAL_DARK.fg }}>
                          <span title={scanKindLabel(e.kind).title} style={{ cursor: "help" }}>
                            {scanKindLabel(e.kind).label}
                          </span>
                          {e.dryRun && <span style={{ color: PORTAL_DARK.muted }}> · look up</span>}
                        </td>
                        <td
                          style={{
                            padding: "6px 8px",
                            color: scanOutcomeColor(e.outcome),
                            fontWeight: 700,
                          }}
                        >
                          <span style={{ whiteSpace: "nowrap" }}>
                            {e.outcome}
                            {e.headsock && <span style={{ color: AMBER }}> · headsock</span>}
                          </span>
                          {/* WHY it failed, on its own line. The word "failed"
                              alone is the least useful thing this panel could
                              say at 8pm with a queue at the desk. */}
                          {e.detail && (
                            <span
                              style={{
                                display: "block",
                                color: PORTAL_DARK.muted,
                                fontWeight: 400,
                                fontSize: 11,
                                maxWidth: 260,
                                whiteSpace: "normal",
                              }}
                            >
                              {e.detail}
                            </span>
                          )}
                        </td>
                        <td
                          style={{
                            padding: "6px 8px",
                            textAlign: "right",
                            whiteSpace: "nowrap",
                            fontVariantNumeric: "tabular-nums",
                            color: e.totalMs >= 3000 ? RED : e.totalMs >= 1200 ? AMBER : GREEN,
                          }}
                          title={
                            e.ms
                              ? Object.entries(e.ms)
                                  .filter(([k]) => k !== "total")
                                  .map(([k, v]) => `${k} ${v}ms`)
                                  .join(", ")
                              : undefined
                          }
                        >
                          {fmtScanMs(e.totalMs)}
                        </td>
                        <td style={{ padding: "6px 8px", color: PORTAL_DARK.muted }}>
                          {e.track ? `${e.track}${e.heatNumber ? ` #${e.heatNumber}` : ""}` : "—"}
                        </td>
                        <td style={{ padding: "6px 8px", color: PORTAL_DARK.muted }}>
                          {e.firstName || "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="text-xs mt-3" style={{ color: PORTAL_DARK.muted }}>
              Newest first, last 120 scans. Hover a duration to see where the time went. Gear
              look-ups are hidden by default and never counted in the averages — they wrote nothing.
            </p>
          </div>
        </div>
      )}

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
