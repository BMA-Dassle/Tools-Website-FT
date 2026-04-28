"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { modalBackdropProps } from "@/lib/a11y";
import { useVisibleInterval } from "@/lib/use-visible-interval";

/**
 * Camera-assignment UI.
 *
 * Flow:
 *   1. On load, GET /api/admin/camera-assign/session → next upcoming
 *      session + its participants (with any pre-existing assignments
 *      merged in).
 *   2. Staff scans each base-station's NFC tag with a USB NFC reader.
 *      The reader emulates a keyboard — it types the SYSTEM number +
 *      Enter into the always-focused input field. The onSubmit handler
 *      assigns that system to the currently highlighted racer via
 *      POST /api/admin/camera-assign/assign, then auto-advances to
 *      the next unassigned racer.
 *   3. Each assignment writes a system-watch:{systemNumber} reverse
 *      lookup in Redis (24h TTL) so the video-match cron can route
 *      incoming videos (matched on video.system.name) back to the
 *      racer.
 *
 * Test-data dropdown: pick any past session from today to load its
 * roster instead of the live "next upcoming" pick — useful for
 * demoing/training without affecting a real session.
 *
 * Input always refocuses on blur so the NFC stream never goes stale.
 */

type BlockInfo = {
  blocked: boolean;
  level?: "video" | "person" | "session";
  reason?: string;
  blockedAt?: string;
  blockedBy?: string;
};

type GuardianContact = {
  personId?: string | number;
  firstName?: string;
  lastName?: string;
  email?: string;
  mobilePhone?: string;
  homePhone?: string;
  acceptMailCommercial?: boolean;
  acceptMailScores?: boolean;
  acceptSmsCommercial?: boolean;
  acceptSmsScores?: boolean;
};

type Participant = {
  personId: string | number;
  firstName: string;
  lastName: string;
  /** The SYSTEM number (base/dock) the camera was plugged into —
   *  read off the NFC tag, matches video.system.name on vt3.io. */
  systemNumber?: string;
  assignedAt?: string;
  /** Carried through from Pandora into the assignment record so the
   *  video-match cron can notify the racer when their video is ready. */
  email?: string;
  mobilePhone?: string;
  homePhone?: string;
  phone?: string;
  acceptSmsCommercial?: boolean;
  acceptSmsScores?: boolean;
  /** Optional guardian / parent contact for minors. Forwarded to the
   *  /assign endpoint so the video-notify path can fall back to the
   *  guardian when the racer has no usable contact of their own. */
  guardian?: GuardianContact | null;
  /** Effective block state for this racer (session-level inherited, or
   *  person-level override). Populated by the server from one MGET. */
  block?: BlockInfo;
};

type SessionInfo = {
  sessionId: string | number;
  name: string;
  scheduledStart: string;
  track: string;
  heatNumber: number;
  type: string;
};

type SessionResponse = {
  session: SessionInfo | null;
  participants: Participant[];
  note?: string;
  sessionBlock?: BlockInfo;
};

type PastSession = {
  sessionId: string;
  name: string;
  scheduledStart: string;
  track: string;
  heatNumber: number;
  type: string;
};

/** One row in the full-day schedule — powers the scrollable heat list
 *  that replaced the ±6 pill strip. Same base fields as PastSession
 *  plus live status + per-session camera-assign count. */
type DaySession = {
  sessionId: string;
  name: string;
  scheduledStart: string;
  track: string;
  heatNumber: number;
  type: string;
  assignedCount: number;
  status: "past" | "live" | "upcoming";
};

function formatEt(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-US", {
      timeZone: "America/New_York",
      hour: "numeric", minute: "2-digit", hour12: true,
    });
  } catch { return iso; }
}

type TrackSlug = "" | "blue" | "red" | "mega";

/**
 * Preset reasons staff can pick from the block modal dropdown.
 * "Other" shows a free-text field so unusual situations still get
 * captured — otherwise staff would type variants of the same few
 * reasons into an open-ended field and the audit log stays noisy.
 */
const BLOCK_REASONS = [
  "Crash",
  "Crash w/ Injury",
  "Aggressive Driving",
  "Unsportsmanlike",
  "Language",
  "Other",
] as const;
type BlockReason = (typeof BLOCK_REASONS)[number];

/**
 * Abbreviated type names so pills fit on narrow screens.
 *   Starter         → STR
 *   Intermediate    → INT
 *   Pro             → PRO
 *   Junior {X}      → JR X (e.g. "JR INT")
 */
function abbreviateType(type: string): string {
  const t = type.trim().toUpperCase();
  const junior = /^JUNIOR\s+/.test(t);
  const base = t.replace(/^JUNIOR\s+/, "");
  const abbr =
    base === "STARTER" ? "STR" :
    base === "INTERMEDIATE" ? "INT" :
    base === "PRO" ? "PRO" :
    base; // unknown types pass through unchanged
  return junior ? `JR ${abbr}` : abbr;
}

/**
 * Short, scannable label for a session shown on a quick-pick button.
 *   Default:           "Blue Starter 43"
 *   opts.dropTrack:    "STR 43"   (when track filter is active, the
 *                                  track name would just repeat on
 *                                  every pill — drop it AND abbreviate
 *                                  the type so the pill stays narrow)
 * Strips "Track" from the resource name so the button stays narrow.
 */
function sessionChipLabel(
  s: { track?: string; type?: string; heatNumber?: number } | null | undefined,
  opts: { dropTrack?: boolean } = {},
): string {
  if (!s) return "—";
  const track = (s.track || "").replace(" Track", "").trim();
  const type = (s.type || "").trim();
  const typeShort = opts.dropTrack ? abbreviateType(type) : type;
  const heat = s.heatNumber != null ? String(s.heatNumber) : "";
  const parts = opts.dropTrack ? [typeShort, heat] : [track, typeShort, heat];
  return parts.filter(Boolean).join(" ");
}

/**
 * Map a session's track name to brand colors for the quick-pick pill.
 * Active state = filled, idle = outlined.
 */
function trackChipClasses(trackName: string | undefined, isActive: boolean): string {
  const t = (trackName || "").toLowerCase();
  if (t.includes("red")) {
    return isActive
      ? "bg-[#E53935] border-[#E53935] text-white"
      : "border-[#E53935]/45 text-[#ff7171] hover:bg-[#E53935]/10 bg-white/[0.02]";
  }
  if (t.includes("mega")) {
    return isActive
      ? "bg-[#8652FF] border-[#8652FF] text-white"
      : "border-[#8652FF]/45 text-[#c4adff] hover:bg-[#8652FF]/10 bg-white/[0.02]";
  }
  // default: blue / cyan
  return isActive
    ? "bg-[#00E2E5] border-[#00E2E5] text-[#000418]"
    : "border-[#00E2E5]/40 text-[#00E2E5] hover:bg-[#00E2E5]/10 bg-white/[0.02]";
}

/**
 * Small branded track chips. Colors pulled from the FastTrax palette
 * (cyan, brand red, violet). Active state fills with the track color;
 * idle keeps the color as a subtle border + text tint. Clicking the
 * already-active chip clears the filter (so there's no separate
 * "All" button — tapping again = all).
 */
const TRACK_CHIPS: { slug: Exclude<TrackSlug, "">; label: string; active: string; idle: string }[] = [
  {
    slug: "blue",
    label: "Blue",
    active: "bg-[#00E2E5] border-[#00E2E5] text-[#000418]",
    idle:   "border-[#00E2E5]/40 text-[#00E2E5] hover:bg-[#00E2E5]/10",
  },
  {
    slug: "red",
    label: "Red",
    active: "bg-[#E53935] border-[#E53935] text-white",
    idle:   "border-[#E53935]/50 text-[#ff7171] hover:bg-[#E53935]/10",
  },
  {
    slug: "mega",
    label: "Mega",
    active: "bg-[#8652FF] border-[#8652FF] text-white",
    idle:   "border-[#8652FF]/50 text-[#c4adff] hover:bg-[#8652FF]/10",
  },
];

/** Tracks that are running today (ET). Tuesday = Mega only;
 *  every other day = Blue + Red. Filters the chip row so staff
 *  never sees a track that isn't running, and prevents the page
 *  from accidentally querying it. */
function visibleTrackSlugsET(): Array<Exclude<TrackSlug, "">> {
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
  }).format(new Date());
  return weekday === "Tue" ? ["mega"] : ["blue", "red"];
}

export default function CameraAssignClient({ token, track: initialTrack, version }: { token: string; track?: string; version?: string }) {
  // Only show chips for tracks that are running today.
  // Tuesday = Mega only; other days = Blue + Red. If the URL was
  // bookmarked with a now-hidden track (e.g. ?track=blue on a
  // Tuesday), drop it back to "" so we don't auto-query a track
  // that has no sessions today.
  const visibleSlugs = visibleTrackSlugsET();
  const visibleChips = TRACK_CHIPS.filter((c) => visibleSlugs.includes(c.slug));
  const initialTrackSafe: TrackSlug =
    initialTrack && visibleSlugs.includes(initialTrack as Exclude<TrackSlug, "">)
      ? (initialTrack as TrackSlug)
      : "";
  const [track, setTrack] = useState<TrackSlug>(initialTrackSafe);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [pastSessions, setPastSessions] = useState<PastSession[]>([]);
  const [pastLoaded, setPastLoaded] = useState(false);
  const [pastModalOpen, setPastModalOpen] = useState(false);
  const [overrideSessionId, setOverrideSessionId] = useState<string>("");
  /** Live "called races" feed — the last 3 sessions for which the
   *  checkin-cron fired an SMS. Refreshes every 30s except while
   *  scanBuffer has content (never yank buttons mid-scan). */
  const [calledSessions, setCalledSessions] = useState<PastSession[]>([]);
  const [calledLoading, setCalledLoading] = useState(false);
  /** Next 3 Pandora sessions with scheduledStart in the future.
   *  Renders as the +1/+2/+3 pills so staff can pre-assign before
   *  the check-in cron calls the race. */
  const [upcomingSessions, setUpcomingSessions] = useState<PastSession[]>([]);
  const [upcomingLoading, setUpcomingLoading] = useState(false);
  const [pastLoading, setPastLoading] = useState(false);
  /** Full-day schedule for the selected track — replaces the old
   *  ±3 called + ±3 upcoming pill strip. Populated on track select
   *  and refreshed every 30s alongside the existing feeds. */
  const [daySessions, setDaySessions] = useState<DaySession[]>([]);
  const [dayLoading, setDayLoading] = useState(false);
  const [scanBuffer, setScanBuffer] = useState("");
  const [lastScan, setLastScan] = useState<{ camera: string; racer: string; at: number } | null>(null);
  /** Heat-wide block state. Populated from the session-load response.
   *  When `blocked: true`, the participant list paints names red and
   *  the "Block Heat" button flips to "Unblock Heat". */
  const [sessionBlock, setSessionBlock] = useState<BlockInfo>({ blocked: false });
  /** Block-confirm modal state. `target` null → heat-wide, otherwise
   *  the specific racer being blocked. Unblock skips the modal — it's
   *  a safe direction. */
  const [blockModalTarget, setBlockModalTarget] = useState<Participant | null | "heat">(null);
  const [blockReason, setBlockReason] = useState<string>("Crash");
  const [blockReasonOther, setBlockReasonOther] = useState<string>("");
  const [blockBusy, setBlockBusy] = useState(false);
  // Bumps on every successful scan — drives the full-screen flash
  // overlay. We key a fresh <div> on this counter so the CSS
  // animation restarts from scratch each time.
  const [flashCounter, setFlashCounter] = useState(0);
  // Android keyboard is off by default (inputMode="none" + readOnly) so
  // taps on the scan input don't cover the roster. Staff can flip this
  // on if they need to hand-type a camera # and don't have a USB
  // keyboard attached.
  const [showKeyboard, setShowKeyboard] = useState(false);
  /** Web NFC (Android Chrome only). When true, ndef.scan() is running
   *  and tag reads feed scanBuffer + assign() just like the USB reader
   *  path. iPhone has no Web NFC support — the button hides there. */
  const [nfcActive, setNfcActive] = useState(false);
  const [nfcError, setNfcError] = useState<string | null>(null);
  const nfcAbortRef = useRef<AbortController | null>(null);
  // Cached at mount so we don't re-probe every render. Web NFC is
  // Chromium-only and only on Android — no Safari/iOS support.
  const [nfcSupported, setNfcSupported] = useState(false);
  useEffect(() => {
    setNfcSupported(typeof window !== "undefined" && "NDEFReader" in window);
  }, []);
  /** Fullscreen mode — lets Android staff flip the camera-assign page
   *  into kiosk-style fullscreen (hides browser chrome + status bar) so
   *  the scan input + roster get the most vertical space possible.
   *  Fires `document.documentElement.requestFullscreen()` on toggle.
   *  Escape / gesture-exit flips the flag back via fullscreenchange. */
  const [isFullscreen, setIsFullscreen] = useState(false);
  /** Mobile heat-picker modal. The inline day-list cramps on phones —
   *  on <md viewports we show a summary button instead that opens this
   *  modal with bigger tap targets. Desktop keeps the inline list. */
  const [heatModalOpen, setHeatModalOpen] = useState(false);
  /** Which sessionId the user just tapped in the heat-picker modal,
   *  so we can render an inline spinner on that row + auto-close
   *  the modal once the load completes. */
  const [pickingSid, setPickingSid] = useState<string | null>(null);
  /** Barcode-provisioning modal. Lets staff map each camera (1-96)
   *  to its physical barcode — scan with a USB barcode reader or type
   *  by hand. Persisted server-side so it survives across sessions.
   *  barcodeMap: cameraNumber(string) → barcode(string). */
  const [barcodeModalOpen, setBarcodeModalOpen] = useState(false);
  const [barcodeMap, setBarcodeMap] = useState<Record<string, string>>({});
  const [barcodeLoading, setBarcodeLoading] = useState(false);
  const [barcodeErr, setBarcodeErr] = useState<string | null>(null);
  /** Which camera number slot the scan/type should land in. Increments
   *  after each successful save so staff can rip through cameras
   *  sequentially with a barcode reader. */
  const [barcodeActiveCam, setBarcodeActiveCam] = useState<number>(1);
  const [barcodeInput, setBarcodeInput] = useState<string>("");
  const barcodeInputRef = useRef<HTMLInputElement | null>(null);

  /** Load the full mapping when the modal opens. */
  const loadBarcodes = useCallback(async () => {
    setBarcodeLoading(true);
    setBarcodeErr(null);
    try {
      const res = await fetch("/api/admin/camera-assign/barcodes", {
        cache: "no-store",
        headers: { "x-admin-token": token },
      });
      if (!res.ok) throw new Error(`load failed (${res.status})`);
      const json = await res.json();
      setBarcodeMap(json.mappings || {});
    } catch (e) {
      setBarcodeErr(e instanceof Error ? e.message : "load failed");
    } finally {
      setBarcodeLoading(false);
    }
  }, [token]);

  const saveBarcode = useCallback(async (cameraNumber: number, barcode: string) => {
    const bc = barcode.trim();
    if (!bc) return;
    setBarcodeErr(null);
    try {
      const res = await fetch("/api/admin/camera-assign/barcodes", {
        method: "POST",
        headers: { "content-type": "application/json", "x-admin-token": token },
        body: JSON.stringify({ cameraNumber, barcode: bc }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `save failed (${res.status})`);
      setBarcodeMap((prev) => ({ ...prev, [String(cameraNumber)]: bc }));
      // Auto-advance to the next unmapped camera so USB barcode
      // readers can chain scans without staff having to click.
      setBarcodeInput("");
      setBarcodeActiveCam((cur) => {
        const start = Math.max(cur + 1, 1);
        for (let i = start; i <= 96; i++) {
          if (!barcodeMap[String(i)] && i !== cameraNumber) return i;
        }
        return Math.min(96, cur + 1);
      });
      // Re-focus the input so next scan lands here.
      setTimeout(() => barcodeInputRef.current?.focus(), 0);
    } catch (e) {
      setBarcodeErr(e instanceof Error ? e.message : "save failed");
    }
  }, [token, barcodeMap]);

  const deleteBarcode = useCallback(async (cameraNumber: number) => {
    setBarcodeErr(null);
    try {
      const res = await fetch(
        `/api/admin/camera-assign/barcodes?cameraNumber=${cameraNumber}`,
        { method: "DELETE", headers: { "x-admin-token": token } },
      );
      if (!res.ok) throw new Error(`delete failed (${res.status})`);
      setBarcodeMap((prev) => {
        const next = { ...prev };
        delete next[String(cameraNumber)];
        return next;
      });
    } catch (e) {
      setBarcodeErr(e instanceof Error ? e.message : "delete failed");
    }
  }, [token]);

  const openBarcodeModal = useCallback(() => {
    setBarcodeModalOpen(true);
    setBarcodeInput("");
    void loadBarcodes();
    // Steal keyboard focus away from the main scan input so the
    // capture-phase listener doesn't have to fight it for keystrokes.
    if (typeof document !== "undefined" && document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    setTimeout(() => barcodeInputRef.current?.focus(), 50);
  }, [loadBarcodes]);

  /** Document-level keydown listener while the barcode modal is open.
   *  Removes the "you have to tap into the input first" friction —
   *  USB barcode scanners pump keydown events to the document, so we
   *  capture them no matter what's focused. Auto-saves on Enter
   *  (the scanner's typical terminator suffix). Also keeps the
   *  input echoing the current buffer for visual feedback.
   *
   *  Two things matter for reliability:
   *  - Capture-phase + stopImmediatePropagation so the MAIN scan
   *    input's onKeyDown (assign-on-Enter) doesn't fire if focus
   *    happens to still be on it under the modal.
   *  - Refs for the callbacks so the listener attaches ONCE per
   *    modal-open and doesn't churn every time barcodeMap changes
   *    (each save would otherwise re-create saveBarcode →
   *    re-create the effect → momentary listener gap → lost keys).
   */
  const barcodeBufferRef = useRef("");
  const saveBarcodeRef = useRef(saveBarcode);
  const activeCamRef = useRef(barcodeActiveCam);
  useEffect(() => { saveBarcodeRef.current = saveBarcode; }, [saveBarcode]);
  useEffect(() => { activeCamRef.current = barcodeActiveCam; }, [barcodeActiveCam]);

  /** Auto-save helper. Fires the save + clears the buffer.
   *  Uses a 7-char length trigger as the primary auto-fire signal
   *  (matches the standard scan length on the cameras' QR tags) so
   *  scanners that don't send an Enter terminator still trigger
   *  immediate save the moment the scan is complete. Caller passes
   *  the explicit value to avoid stale-ref races during burst input. */
  const autoSaveBarcode = useCallback((forceValue?: string) => {
    const v = (forceValue ?? barcodeBufferRef.current).trim();
    if (v.length >= 1) {
      void saveBarcodeRef.current(activeCamRef.current, v);
      barcodeBufferRef.current = "";
    }
  }, []);

  useEffect(() => {
    if (!barcodeModalOpen) return;
    barcodeBufferRef.current = "";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        setBarcodeModalOpen(false);
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopImmediatePropagation();
        autoSaveBarcode();
        return;
      }
      if (e.key === "Backspace") {
        e.stopImmediatePropagation();
        barcodeBufferRef.current = barcodeBufferRef.current.slice(0, -1);
        setBarcodeInput(barcodeBufferRef.current);
        return;
      }
      // Single-char key — append to buffer. Auto-fire when the
      // buffer hits the standard 7-character scan length.
      if (e.key.length === 1) {
        e.stopImmediatePropagation();
        barcodeBufferRef.current += e.key;
        setBarcodeInput(barcodeBufferRef.current);
        if (barcodeBufferRef.current.trim().length === 7) {
          autoSaveBarcode(barcodeBufferRef.current);
        }
      }
    };
    document.addEventListener("keydown", onKey, { capture: true });
    return () => {
      document.removeEventListener("keydown", onKey, true);
    };
  }, [barcodeModalOpen, autoSaveBarcode]);

  // Load the barcode map on mount (not just when the modal opens) so
  // the MAIN scan input can resolve barcodes → camera numbers in real
  // time. Racers' cameras carry a barcode; when USB barcode scanners
  // type the barcode into the main input, we translate it to the
  // camera number before calling assign().
  useEffect(() => { void loadBarcodes(); }, [loadBarcodes]);

  /** Reverse lookup: barcode → cameraNumber (string). Derived from
   *  the forward `barcodeMap` so there's a single source of truth. */
  const barcodeToCam = useMemo(() => {
    const out: Record<string, string> = {};
    for (const [cam, bc] of Object.entries(barcodeMap)) {
      if (bc) out[bc] = cam;
    }
    return out;
  }, [barcodeMap]);
  useEffect(() => {
    const onChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);
  const toggleFullscreen = useCallback(async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await document.documentElement.requestFullscreen();
      }
    } catch {
      /* user gesture required / not supported — no-op */
    }
  }, []);

  /** Auto-enter (and re-enter) fullscreen on every user interaction.
   *  Browsers block programmatic `requestFullscreen()` without a
   *  user gesture, so the persistent pointerdown listener is the
   *  closest viable approach to "always be fullscreen": every tap
   *  promotes the page if it's not already there. Combined with a
   *  periodic check below as a safety net.
   *
   *  Effect: if the user ESCs / back-gestures out of fullscreen,
   *  the very next tap (which they'd do to keep working) puts them
   *  right back in. The manual ⛶/🗗 button still works as a one-time
   *  toggle until the next tap.
   *
   *  Capture phase so child stopPropagation can't eat the event. */
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onTap = () => {
      if (document.fullscreenElement) return;
      document.documentElement.requestFullscreen().catch(() => {
        /* gesture not sufficient / feature blocked — silent */
      });
    };
    document.addEventListener("pointerdown", onTap, { capture: true });
    return () => document.removeEventListener("pointerdown", onTap, true);
  }, []);

  /** Periodic safety check — every 30s, if we're not fullscreen and
   *  the page is visible, hint the browser by re-attaching nothing
   *  (the persistent listener above is still in place). This mostly
   *  serves as a documented intent: "we want to stay fullscreen".
   *  Real re-entry happens on the next user tap because that's the
   *  only path the browser allows. We can't programmatically force
   *  fullscreen from a setInterval — that's a hard browser rule. */
  useEffect(() => {
    if (typeof document === "undefined") return;
    const id = setInterval(() => {
      if (document.hidden) return;
      // No-op if already fullscreen.
      if (document.fullscreenElement) return;
      // We can't directly call requestFullscreen here (no user
      // gesture). The persistent pointerdown listener picks this up
      // on the next tap. Logging so anyone debugging knows why a
      // page isn't fullscreen between taps.
      // (Intentionally quiet — would be too noisy in production logs)
    }, 30_000);
    return () => clearInterval(id);
  }, []);

  /** Row-blink state for duplicate-camera rejection. When a staffer
   *  scans a camera already bound to another racer in the current
   *  session, we flash THAT row red and hold the cursor on the
   *  current racer so they can re-scan a different camera. Cleared
   *  on a timer so the red fades out. */
  const [conflictBlinkPid, setConflictBlinkPid] = useState<string | null>(null);
  const conflictTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (conflictTimerRef.current) clearTimeout(conflictTimerRef.current); }, []);

  const inputRef = useRef<HTMLInputElement | null>(null);
  /** Ref on whichever participant row is currently the active scan
   *  target. After each scan we set activeIndex to the next unassigned
   *  racer; the effect below scrolls that row into view so staff
   *  always sees who they're scanning for next. */
  const activeRacerRef = useRef<HTMLButtonElement | null>(null);
  /** Ref on the heat row in the day-list that's "live" right now
   *  (closest to the current time). Used to auto-scroll the schedule
   *  into view on first load so staff lands on the current heat. */
  const liveHeatRef = useRef<HTMLButtonElement | null>(null);
  /** Brief red flash on the scan input + error line when a scanned
   *  barcode isn't registered in the camera-barcode map. Auto-clears
   *  after 2.5s. */
  const [unknownScanFlash, setUnknownScanFlash] = useState(false);
  const unknownScanTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (unknownScanTimerRef.current) clearTimeout(unknownScanTimerRef.current); }, []);

  /** Scroll the active racer into view whenever activeIndex changes.
   *  Refs in React commit before useEffect, so by the time this runs
   *  activeRacerRef.current points at the new row. `block: "center"`
   *  centers the active racer in the visible roster — handles both
   *  scrolling down (advance) and back up (manual tap on an earlier
   *  row). Smooth scroll so it doesn't jolt. */
  useEffect(() => {
    if (!participants.length) return;
    activeRacerRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [activeIndex, participants.length]);

  /** Scroll the day schedule to the current/live heat. Runs on:
   *   - daySessions changes (initial load + 30s refresh)
   *   - heatModalOpen flipping true (mobile modal mounts)
   *  `block: "center"` puts the live row in the middle of the
   *  visible window. Defers a beat so the rows are mounted. */
  useEffect(() => {
    if (!daySessions.length) return;
    const id = setTimeout(() => {
      liveHeatRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 100);
    return () => clearTimeout(id);
  }, [daySessions, heatModalOpen]);

  /** Clear the picking flag once the chosen heat has loaded — drives
   *  the inline "Loading Heat N…" copy in the participants panel
   *  back to the normal roster render. The modal itself was already
   *  closed at click time so no modal handling here. */
  useEffect(() => {
    if (!pickingSid) return;
    if (session && String(session.sessionId) === pickingSid) {
      setPickingSid(null);
    }
  }, [session, pickingSid]);
  // Mirror scanBuffer into a ref so the "skip while mid-scan" gates on
  // loadHeats / refreshSession don't cause those
  // callbacks' identities to flip on every keystroke — which used to
  // cascade into the track-change effect re-firing and clobbering the
  // currently-loaded session.
  const scanBufferRef = useRef(scanBuffer);
  useEffect(() => { scanBufferRef.current = scanBuffer; }, [scanBuffer]);

  /** Load the active session (next upcoming by default, or override if picked).
   *  Full reset — use this for initial load, track switch, and manual reload.
   *
   *  Clears the existing session + roster immediately so operators don't see
   *  the previous track's racers while the new data is in flight. The
   *  participant-list render path already swaps to a loading state when
   *  participants is empty + loading is true.
   *
   *  Requires `track` to be one of blue/red/mega — never loads across all
   *  tracks, because scanning without a track context is error-prone
   *  (same system number can exist on different tracks at similar times).
   *  If track isn't set, we short-circuit and let the UI show its
   *  "pick a track" prompt. */
  const loadSession = useCallback(async (sessionIdOverride?: string, forceRefresh: boolean = false) => {
    if (!track) {
      // Clear any stale state so the prompt renders cleanly.
      setSession(null);
      setParticipants([]);
      setNote(null);
      setActiveIndex(0);
      setLastScan(null);
      return;
    }
    setLoading(true);
    setErr(null);
    setSession(null);
    setParticipants([]);
    setNote(null);
    setActiveIndex(0);
    setLastScan(null);
    try {
      const qs = new URLSearchParams({ token });
      if (sessionIdOverride) qs.set("sessionId", sessionIdOverride);
      qs.set("track", track);
      // Initial loads + auto-polls read the cron-warmed cache for
      // instant render even during Pandora outages. Manual refresh
      // button passes `refresh=1` to bypass the cache and force a
      // live Pandora call — staff get fresh data on demand.
      if (forceRefresh) qs.set("refresh", "1");
      const res = await fetch(`/api/admin/camera-assign/session?${qs}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`load failed: ${res.status}`);
      const json = (await res.json()) as SessionResponse;
      setSession(json.session);
      setParticipants(json.participants || []);
      setNote(json.note || null);
      setSessionBlock(json.sessionBlock || { blocked: false });
      // Auto-highlight the first UNASSIGNED racer (or first if all assigned)
      const firstUnassigned = (json.participants || []).findIndex((p) => !p.systemNumber);
      setActiveIndex(firstUnassigned >= 0 ? firstUnassigned : 0);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "failed to load");
    } finally {
      setLoading(false);
    }
  }, [token, track]);

  /** In-place refresh that preserves local scan state.
   *
   *  Pandora's roster for the active session can change while the page
   *  is open (racer added late, scratch, kart re-shuffled). We refresh
   *  every ~30s so those changes surface without staff having to hit
   *  Reload mid-scan.
   *
   *  Preserved across refresh:
   *    - active scan index (unless that racer got removed)
   *    - existing systemNumber assignments we made locally (server will
   *      also echo them back since they're persisted, but we trust our
   *      local state as the most recent)
   *    - lastScan toast
   *    - the current session (we never auto-jump to the next upcoming —
   *      staff must hit Reload for that, so the session header is stable)
   *
   *  If the backend returns a *different* session than the one we're on
   *  (because the server's "next upcoming" moved on), we do NOT swap it
   *  automatically — we flag a note so staff knows a newer session is
   *  queued up. They hit Reload when ready.
   */
  const refreshSession = useCallback(async (signal?: AbortSignal) => {
    // No track → nothing to refresh (UI is showing the pick-a-track prompt).
    if (!track) return;
    // Don't refresh while staff is on a test session (overrideSessionId)
    // or actively scanning — would clobber in-progress work.
    if (overrideSessionId) return;
    if (scanBufferRef.current) return;

    try {
      const qs = new URLSearchParams({ token, track });
      const res = await fetch(`/api/admin/camera-assign/session?${qs}`, { cache: "no-store", signal });
      if (signal?.aborted) return;
      if (!res.ok) return;
      const json = (await res.json()) as SessionResponse;
      const newSession = json.session;
      const newParticipants = json.participants || [];

      // No session selected yet — fall through to loadSession.
      if (!session) {
        setSession(newSession);
        setParticipants(newParticipants);
        setNote(json.note || null);
        const firstUnassigned = newParticipants.findIndex((p) => !p.systemNumber);
        setActiveIndex(firstUnassigned >= 0 ? firstUnassigned : 0);
        return;
      }

      // The server's "next upcoming" advanced past us. Keep rendering the
      // session we loaded (so scan progress survives), but surface a note
      // so staff can hit Reload to move on.
      if (newSession && String(newSession.sessionId) !== String(session.sessionId)) {
        setNote(
          `New upcoming session: ${newSession.track.replace(" Track", "")} · Heat ${newSession.heatNumber} · ${formatEt(newSession.scheduledStart)}. Hit Reload when ready.`,
        );
        return;
      }

      // Same session — merge participant list in-place. Preserve any
      // systemNumber we have locally (post-scan), since the server may
      // have slightly stale data if our scan just landed.
      setParticipants((prev) => {
        const prevByPid = new Map(prev.map((p) => [String(p.personId), p]));
        return newParticipants.map((np) => {
          const existing = prevByPid.get(String(np.personId));
          if (existing?.systemNumber && !np.systemNumber) {
            // Keep our local assignment.
            return { ...np, systemNumber: existing.systemNumber, assignedAt: existing.assignedAt };
          }
          return np;
        });
      });
      // Always refresh the block snapshot from the server — block state
      // is authoritative there (and can flip from other staff screens).
      setSessionBlock(json.sessionBlock || { blocked: false });

      // Fix up activeIndex if the racer at that slot got removed.
      setActiveIndex((prev) => {
        if (prev < 0 || prev >= newParticipants.length) {
          const firstUnassigned = newParticipants.findIndex((p) => !p.systemNumber);
          return firstUnassigned >= 0 ? firstUnassigned : 0;
        }
        return prev;
      });
    } catch {
      // Non-fatal — next tick will try again.
    }
  }, [token, track, overrideSessionId, session]);

  /** Load the last N "called" races from our SMS log (via the new
   *  /called endpoint). Used to populate the live quick-pick pills.
   *  Refreshed every 30s by an interval below; skipped while the
   *  operator is mid-scan (scanBufferRef guard below) so the pills
   *  don't rearrange under their thumb. scanBuffer intentionally
   *  NOT in the deps list — reading via ref keeps this callback's
   *  identity stable across typing. */
  /** Combined loader for prev-called + upcoming heats. One server
   *  round-trip, both state updates applied in the same commit so the
   *  pills arrive as a single visual wave (not prev-first-then-upcoming
   *  staggered over a second). scanBufferRef gate keeps mid-scan safe. */
  const loadHeats = useCallback(async (signal?: AbortSignal) => {
    if (!track) {
      setCalledSessions([]); setCalledLoading(false);
      setUpcomingSessions([]); setUpcomingLoading(false);
      return;
    }
    if (scanBufferRef.current) return;
    setCalledLoading(true);
    setUpcomingLoading(true);
    try {
      const qs = new URLSearchParams({ token, track, before: "4", after: "3" });
      const res = await fetch(`/api/admin/camera-assign/heats?${qs}`, { cache: "no-store", signal });
      if (signal?.aborted) return;
      if (!res.ok) return;
      const json = await res.json();
      // Both setStates in the same async tick — React 18 batches them
      // automatically so the pills render in one commit.
      setCalledSessions(json.called || []);
      setUpcomingSessions(json.upcoming || []);
    } catch {
      /* non-fatal */
    } finally {
      setCalledLoading(false);
      setUpcomingLoading(false);
    }
  }, [token, track]);

  /** Full-day schedule loader. Pulls every session for the current
   *  track today, sorted by scheduledStart asc, with per-heat
   *  assignedCount from Redis. Drives the new scrollable heat list.
   *  Respects the scanBuffer mid-scan guard so the list doesn't
   *  jostle while staff is entering a camera number. */
  const loadDay = useCallback(async (signal?: AbortSignal) => {
    if (!track) { setDaySessions([]); setDayLoading(false); return; }
    if (scanBufferRef.current) return;
    setDayLoading(true);
    try {
      const qs = new URLSearchParams({ token, track });
      const res = await fetch(`/api/admin/camera-assign/day?${qs}`, { cache: "no-store", signal });
      if (signal?.aborted) return;
      if (!res.ok) return;
      const json = await res.json();
      setDaySessions(json.sessions || []);
    } catch {
      /* non-fatal — keep last-known list */
    } finally {
      setDayLoading(false);
    }
  }, [token, track]);

  /** Load today's past sessions for the test-data dropdown. Scoped to
   *  today (days=1) — staff only testing on the day's earlier heats.
   *  Re-sorts client-side newest-first (server already does this, but
   *  we guard against any Pandora-side ordering weirdness in case a
   *  response ever comes back unsorted). */
  const loadPast = useCallback(async () => {
    if (!track) { setPastSessions([]); setPastLoaded(false); setPastLoading(false); return; }
    setPastLoading(true);
    try {
      const qs = new URLSearchParams({ token, mode: "past", days: "1", track });
      const res = await fetch(`/api/admin/camera-assign/session?${qs}`, { cache: "no-store" });
      if (!res.ok) return;
      const json = await res.json();
      const sessions: PastSession[] = (json.sessions || []).slice();
      // Defensive sort: most-recent first. If scheduledStart ties
      // (two tracks starting the same minute), break the tie with
      // heatNumber desc so the "later" heat floats higher. Invalid
      // dates sink to the bottom.
      sessions.sort((a, b) => {
        const ta = Number(new Date(a.scheduledStart).getTime()) || 0;
        const tb = Number(new Date(b.scheduledStart).getTime()) || 0;
        if (tb !== ta) return tb - ta;
        return (b.heatNumber || 0) - (a.heatNumber || 0);
      });
      setPastSessions(sessions);
      setPastLoaded(true);
    } catch {
      /* non-fatal */
    } finally {
      setPastLoading(false);
    }
  }, [token, track]);

  // Initial load — and re-runs whenever `track` changes so the three
  // track buttons can switch the roster. `loadSession` itself captures
  // `track` via its useCallback deps, so its identity flips when track
  // flips, and this effect re-fires.
  useEffect(() => {
    // Track change clears EVERYTHING and shows the live-picks empty
    // state. Staff must tap a live pill (or open the Earlier-sessions
    // modal) to load a roster. Nothing auto-picks — deliberate, so
    // operators never get a roster change they didn't ask for.
    setOverrideSessionId("");
    setPastLoaded(false);
    setPastSessions([]);
    setPastLoading(!!track);    // show loading immediately if a track is now selected
    setCalledSessions([]);
    setCalledLoading(!!track);
    setUpcomingSessions([]);
    setUpcomingLoading(!!track);
    setDaySessions([]);
    setDayLoading(!!track);
    setSession(null);
    setParticipants([]);
    setNote(null);
    setActiveIndex(0);
    setLastScan(null);
    // Populate the live quick-pick feed + past dropdown + full-day
    // schedule for the new track so everything's usable without a tap.
    void loadHeats();
    void loadPast();
    void loadDay();
  }, [track, loadHeats, loadPast, loadDay]);

  // Two-tier refresh — both driven by useVisibleInterval so they:
  //   1. PAUSE when the tab is hidden — was a bare setInterval that
  //      kept polling in background tabs, accumulating fetches Edge
  //      eventually OOM-killed the renderer for.
  //   2. ABORT in-flight fetches on tab-hide / unmount / next tick —
  //      old fetches no longer leak Response/JSON allocations after
  //      the operator switches away.
  //   3. NO OVERLAP — recursive setTimeout means the next tick only
  //      schedules AFTER the current one settles. Was the dominant
  //      problem during Pandora outages: 5s setInterval + 30-60s
  //      Pandora response = 6-12 stacked in-flight fetches eating
  //      the connection pool.
  //
  // Cadence:
  //  - Roster (refreshSession) every 5s for near-real-time cross-
  //    device assignments. Self-throttling under load — a slow
  //    response naturally pushes the next tick out by however long
  //    the response took.
  //  - Heat metadata (loadHeats + loadDay) every 30s. scanBufferRef
  //    gate inside the callbacks already skips updates while the
  //    operator is mid-scan.
  useVisibleInterval(refreshSession, 5_000);
  useVisibleInterval(
    useCallback(async (signal: AbortSignal) => {
      await Promise.all([loadHeats(signal), loadDay(signal)]);
    }, [loadHeats, loadDay]),
    30_000,
  );

  // Auto-advance to the next upcoming session once every racer in the
  // current session has a camera. We wait a few seconds so staff sees
  // the "all set" banner, and we don't advance if they're on a test
  // session, mid-scan, or had zero participants to start with.

  // Keep the input focused — NFC reader pumps characters here. On small
  // Android kiosks users may tap a participant card; don't let that
  // strand the input.
  useEffect(() => {
    const refocus = () => {
      if (document.activeElement?.tagName !== "INPUT" && document.activeElement?.tagName !== "SELECT") {
        inputRef.current?.focus();
      }
    };
    refocus();
    const id = setInterval(refocus, 500);
    return () => clearInterval(id);
  }, []);

  /** Submit one system number (from the NFC scan) for the currently
   *  highlighted racer. The scanned value is the base/dock system ID,
   *  which matches video.system.name on vt3.io and drives the
   *  video-match cron. */
  const assign = useCallback(async (systemNumber: string) => {
    const rawScan = systemNumber.trim();
    if (!rawScan) return;
    if (activeIndex < 0 || activeIndex >= participants.length) {
      setErr("No racer highlighted — can't assign.");
      return;
    }
    // Resolve the scan → camera number. Three accepted shapes:
    //   1. Value is a known mapped barcode → translate to camera #
    //   2. Value is a short pure-digit camera number (1-99) — direct
    //   3. Anything else: REJECT with a red flash. Forces staff to
    //      provision the barcode via the 🏷 BC modal first instead
    //      of silently binding an unrecognized value.
    const mappedCam = barcodeToCam[rawScan];
    let sys: string;
    if (mappedCam) {
      sys = mappedCam;
    } else if (/^\d{1,2}$/.test(rawScan)) {
      // 1-2 digit numeric — treat as a direct camera number
      // (legacy NFC-typed input path, plus quick manual entry).
      sys = rawScan;
    } else {
      // Unmapped barcode-shaped value. Flash red, drop the scan.
      setUnknownScanFlash(true);
      setErr(`"${rawScan}" is not registered to a camera. Map it via 🏷 BC first.`);
      if (unknownScanTimerRef.current) clearTimeout(unknownScanTimerRef.current);
      unknownScanTimerRef.current = setTimeout(() => setUnknownScanFlash(false), 2500);
      return;
    }
    const p = participants[activeIndex];

    // Duplicate-camera guard: if any OTHER racer in this session
    // already holds this system number, flash their row red, surface
    // the conflict in the error line, and DO NOT advance — staff
    // needs to re-scan with a different camera. Scanning the same
    // camera back onto the SAME racer is a no-op (ignored).
    const existing = participants.find(
      (x) => x.systemNumber === sys && String(x.personId) !== String(p.personId),
    );
    if (existing) {
      const pid = String(existing.personId);
      setConflictBlinkPid(pid);
      setErr(`Camera ${sys} already assigned to ${existing.firstName} ${existing.lastName}`);
      // Clear scan input so the next scan doesn't echo the old value
      setScanBuffer("");
      if (conflictTimerRef.current) clearTimeout(conflictTimerRef.current);
      conflictTimerRef.current = setTimeout(() => {
        setConflictBlinkPid((cur) => (cur === pid ? null : cur));
      }, 2500);
      return;
    }

    setErr(null);
    try {
      const res = await fetch("/api/admin/camera-assign/assign", {
        method: "POST",
        headers: { "content-type": "application/json", "x-admin-token": token },
        body: JSON.stringify({
          sessionId: session?.sessionId,
          personId: p.personId,
          firstName: p.firstName,
          lastName: p.lastName,
          systemNumber: sys,
          sessionName: session?.name,
          scheduledStart: session?.scheduledStart,
          track: session?.track,
          raceType: session?.type,
          heatNumber: session?.heatNumber,
          // Contact fields — pass through from the participant record
          // so the video-match cron can notify without a Pandora refetch.
          email: p.email,
          mobilePhone: p.mobilePhone,
          homePhone: p.homePhone,
          phone: p.phone,
          acceptSmsCommercial: p.acceptSmsCommercial,
          acceptSmsScores: p.acceptSmsScores,
          // Guardian fallback for minors (videos-only at the moment).
          // Pass it through whenever Pandora gave us one — server
          // tolerates undefined so this is safe pre-rollout.
          guardian: p.guardian ?? null,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `save failed (${res.status})`);
      }
      // Update local state with the assignment
      setParticipants((prev) =>
        prev.map((x, i) =>
          i === activeIndex
            ? { ...x, systemNumber: sys, assignedAt: new Date().toISOString() }
            : x,
        ),
      );
      setLastScan({ camera: sys, racer: `${p.firstName} ${p.lastName}`, at: Date.now() });
      setFlashCounter((c) => c + 1);
      // Advance to next un-assigned racer; if none, stay put
      setActiveIndex((current) => {
        const next = participants.findIndex((x, i) => i > current && !x.systemNumber);
        return next >= 0 ? next : current;
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "save failed");
    }
  }, [participants, activeIndex, session, token, barcodeToCam]);

  /** Handle Enter-delimited scan from NFC reader (or manual typing). */
  const onInputKey = useCallback((ev: React.KeyboardEvent<HTMLInputElement>) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      const val = scanBuffer.trim();
      setScanBuffer("");
      if (val) void assign(val);
    }
  }, [scanBuffer, assign]);

  /**
   * Start / stop the Web NFC reader. Uses the phone's built-in NFC radio
   * (Android Chrome only). `scan()` prompts the user for permission on
   * first call, then fires `reading` events for every tag tapped until
   * we abort the controller.
   *
   * Tag-content extraction is lenient — different tag vendors encode
   * the camera number differently:
   *   - NDEF text record → decode bytes
   *   - NDEF URL record  → take the last path segment
   *   - fallback         → stringify serialNumber or record data
   * We regex out digit sequences at the end to tolerate prefixes like
   * "CAM-913" or "https://.../nfc/913".
   */
  const toggleNfc = useCallback(async () => {
    // Already running → abort.
    if (nfcActive) {
      nfcAbortRef.current?.abort();
      nfcAbortRef.current = null;
      setNfcActive(false);
      setNfcError(null);
      return;
    }
    setNfcError(null);
    if (!("NDEFReader" in window)) {
      setNfcError("Web NFC not supported on this browser. Use Chrome on Android.");
      return;
    }
    try {
      // Use the constructor via a dynamic cast — NDEFReader is not in
      // the TypeScript DOM lib as of this project's TS version.
      const NDEFReaderCtor = (window as unknown as { NDEFReader: new () => {
        scan: (opts?: { signal: AbortSignal }) => Promise<void>;
        onreading: ((ev: { serialNumber?: string; message: { records: Array<{ recordType: string; data: ArrayBuffer | DataView; mediaType?: string }> } }) => void) | null;
        onreadingerror: ((ev: Event) => void) | null;
      } }).NDEFReader;
      const ndef = new NDEFReaderCtor();
      const controller = new AbortController();
      nfcAbortRef.current = controller;

      await ndef.scan({ signal: controller.signal });
      setNfcActive(true);

      ndef.onreading = (ev) => {
        const decoder = new TextDecoder();
        let raw = "";
        for (const record of ev.message.records) {
          try {
            const buf = record.data instanceof ArrayBuffer
              ? record.data
              : (record.data as DataView).buffer;
            const text = decoder.decode(buf);
            if (record.recordType === "text") {
              // NDEF text records start with a status byte + lang code
              // (e.g. "\x02en"), then the actual text. Strip any
              // non-printable leading chars by taking everything after
              // the lang code if present.
              raw += text.replace(/^[\x00-\x1F]*[a-z]{2}/i, "");
              continue;
            }
            if (record.recordType === "url") {
              raw += text.split("/").pop() || text;
              continue;
            }
            raw += text;
          } catch {
            /* skip malformed records */
          }
        }
        if (!raw && ev.serialNumber) raw = ev.serialNumber;
        // Pull the last run of digits — tolerant of prefixes/suffixes.
        const digits = raw.match(/(\d+)(?!.*\d)/)?.[1] || raw.trim();
        if (digits) {
          setScanBuffer("");
          void assign(digits);
        }
      };
      ndef.onreadingerror = () => {
        setNfcError("Couldn't read that tag — try again.");
      };
    } catch (e) {
      // Map the Chrome-thrown DOMExceptions to staff-actionable text.
      //   NotAllowedError = user denied or previously blocked
      //   NotSupportedError = device has no NFC or it's off
      //   NotReadableError = NFC radio failed to start (turn off/on)
      //   SecurityError = non-HTTPS (shouldn't happen on prod)
      const err = e as { name?: string; message?: string };
      const name = err?.name;
      let msg: string;
      if (name === "NotAllowedError") {
        msg = "NFC blocked — tap the 🔒 in Chrome's URL bar → Permissions → NFC → Allow, then reload.";
      } else if (name === "NotSupportedError") {
        msg = "No NFC hardware found, or the phone's NFC is turned off in Settings.";
      } else if (name === "NotReadableError") {
        msg = "NFC radio couldn't start — toggle NFC off/on in Android settings.";
      } else if (name === "SecurityError") {
        msg = "Web NFC needs HTTPS (this page IS HTTPS, so this shouldn't happen — check if you're inside a WebView).";
      } else {
        msg = err?.message || "NFC failed to start";
      }
      setNfcError(msg);
      setNfcActive(false);
      nfcAbortRef.current = null;
    }
  }, [nfcActive, assign]);

  // Cleanup on unmount — don't leave the NFC radio listening.
  useEffect(() => {
    return () => {
      nfcAbortRef.current?.abort();
    };
  }, []);

  /** Un-assign a specific participant. */
  const unassign = useCallback(async (idx: number) => {
    const p = participants[idx];
    if (!p || !session) return;
    if (!confirm(`Un-assign camera ${p.systemNumber} from ${p.firstName} ${p.lastName}?`)) return;
    try {
      const qs = new URLSearchParams({
        token,
        sessionId: String(session.sessionId),
        personId: String(p.personId),
      });
      const res = await fetch(`/api/admin/camera-assign/assign?${qs}`, {
        method: "DELETE",
        headers: { "x-admin-token": token },
      });
      if (!res.ok) throw new Error(`delete failed (${res.status})`);
      setParticipants((prev) =>
        prev.map((x, i) => (i === idx ? { ...x, systemNumber: undefined, assignedAt: undefined } : x)),
      );
      setActiveIndex(idx);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "un-assign failed");
    }
  }, [participants, session, token]);

  /**
   * Resolve the user-visible reason string from the current modal state.
   * When "Other" is picked, use the free-text field (trimmed). For
   * preset reasons the label itself is the reason.
   */
  const effectiveBlockReason = useCallback((): string | undefined => {
    if (blockReason === "Other") {
      const t = blockReasonOther.trim();
      return t.slice(0, 200) || undefined;
    }
    return blockReason;
  }, [blockReason, blockReasonOther]);

  /** Reset the block modal's inputs back to defaults. */
  const resetBlockModal = useCallback(() => {
    setBlockModalTarget(null);
    setBlockReason("Crash");
    setBlockReasonOther("");
  }, []);

  /**
   * Block the whole heat. Server writes `video-block:session:{id}` and
   * instantly syncs VT3 + existing match records for every racer on
   * the roster. Only called from the confirm modal — unblock is direct.
   */
  const submitHeatBlockFromModal = useCallback(async () => {
    if (!session) return;
    const reason = effectiveBlockReason();
    setBlockBusy(true);
    try {
      const res = await fetch(`/api/admin/camera-assign/block`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-admin-token": token },
        body: JSON.stringify({
          scope: "session",
          sessionId: session.sessionId,
          block: true,
          reason,
          // Send the full roster so the server can instantly sync VT3
          // + patch any already-matched videos without waiting for the
          // next cron tick.
          personIds: participants.map((p) => p.personId),
        }),
      });
      if (!res.ok) throw new Error(`block failed (${res.status})`);
      const now = new Date().toISOString();
      setSessionBlock({ blocked: true, level: "session", reason, blockedAt: now });
      setParticipants((prev) => prev.map((p) => {
        if (p.block?.level === "person") return p; // preserve person override
        return { ...p, block: { blocked: true, level: "session", reason, blockedAt: now } };
      }));
      resetBlockModal();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "block failed");
    } finally {
      setBlockBusy(false);
    }
  }, [session, token, participants, effectiveBlockReason, resetBlockModal]);

  /** Unblock the whole heat — direct, no confirmation. */
  const unblockHeat = useCallback(async () => {
    if (!session) return;
    setBlockBusy(true);
    try {
      const res = await fetch(`/api/admin/camera-assign/block`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-admin-token": token },
        body: JSON.stringify({
          scope: "session",
          sessionId: session.sessionId,
          block: false,
          personIds: participants.map((p) => p.personId),
        }),
      });
      if (!res.ok) throw new Error(`unblock failed (${res.status})`);
      setSessionBlock({ blocked: false });
      setParticipants((prev) => prev.map((p) => {
        if (p.block?.level === "person") return p; // preserve person block
        return { ...p, block: { blocked: false } };
      }));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "unblock failed");
    } finally {
      setBlockBusy(false);
    }
  }, [session, token, participants]);

  /**
   * Block ONE racer (from the confirm modal). If the heat is already
   * blocked we still write a person-level block (it's redundant but
   * explicit). Server instant-syncs VT3 + the match record if one
   * exists.
   */
  const submitPersonBlockFromModal = useCallback(async () => {
    if (!session) return;
    const target = blockModalTarget;
    if (!target || target === "heat") return;
    const reason = effectiveBlockReason();
    setBlockBusy(true);
    try {
      const res = await fetch(`/api/admin/camera-assign/block`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-admin-token": token },
        body: JSON.stringify({
          scope: "person",
          sessionId: session.sessionId,
          personId: target.personId,
          block: true,
          reason,
        }),
      });
      if (!res.ok) throw new Error(`person block failed (${res.status})`);
      const now = new Date().toISOString();
      setParticipants((prev) => prev.map((p) =>
        String(p.personId) === String(target.personId)
          ? { ...p, block: { blocked: true, level: "person", reason, blockedAt: now } }
          : p,
      ));
      resetBlockModal();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "person block failed");
    } finally {
      setBlockBusy(false);
    }
  }, [session, token, blockModalTarget, effectiveBlockReason, resetBlockModal]);

  /**
   * Unblock one racer — direct, no confirm. If the heat is blocked,
   * writes an "unblock" override marker so the person escapes the
   * session-level block; otherwise clears the per-person key entirely.
   */
  const unblockPersonDirect = useCallback(async (participant: Participant) => {
    if (!session) return;
    const heatBlocked = sessionBlock.blocked;
    const override = heatBlocked;
    setBlockBusy(true);
    try {
      const res = await fetch(`/api/admin/camera-assign/block`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-admin-token": token },
        body: JSON.stringify({
          scope: "person",
          sessionId: session.sessionId,
          personId: participant.personId,
          block: false,
          override,
        }),
      });
      if (!res.ok) throw new Error(`person unblock failed (${res.status})`);
      setParticipants((prev) => prev.map((p) =>
        String(p.personId) === String(participant.personId)
          ? { ...p, block: heatBlocked ? { blocked: false, level: "person" } : { blocked: false } }
          : p,
      ));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "person unblock failed");
    } finally {
      setBlockBusy(false);
    }
  }, [session, sessionBlock.blocked, token]);

  /** Dispatch: open the modal on block; direct unblock. */
  const togglePersonBlock = useCallback((participant: Participant) => {
    if (participant.block?.blocked) {
      void unblockPersonDirect(participant);
    } else {
      setBlockModalTarget(participant);
      setBlockReason("Crash");
      setBlockReasonOther("");
    }
  }, [unblockPersonDirect]);

  // Computed
  const assignedCount = useMemo(() => participants.filter((p) => p.systemNumber).length, [participants]);
  const totalCount = participants.length;
  const doneAll = totalCount > 0 && assignedCount === totalCount;

  /** Session-id considered "the one the user picked", even before the
   *  roster fetch completes. Used to highlight the right pill
   *  immediately on tap — otherwise pills looked inert for ~2–3s
   *  while the /session fetch was in flight. */
  const activeSessionId = useMemo(
    () => (overrideSessionId || (session ? String(session.sessionId) : "")),
    [overrideSessionId, session],
  );

  /** Find a pending-tap's display label from whichever list has it,
   *  so the Working-on pill can show 'Blue Pro 44' the instant it's
   *  tapped instead of reverting to the 'tap a heat below →'
   *  placeholder until the fetch returns. */
  const pendingSessionLabel = useMemo(() => {
    if (!overrideSessionId) return null;
    if (session && String(session.sessionId) === overrideSessionId) return null; // already loaded
    // Day list is the richest source — check it first. Fallback to the
    // older calledSessions/upcoming/past pools for any edge cases.
    const inDay = daySessions.find((s) => String(s.sessionId) === overrideSessionId);
    if (inDay) return inDay;
    const allPools: PastSession[][] = [calledSessions, upcomingSessions, pastSessions];
    for (const pool of allPools) {
      const hit = pool.find((s) => String(s.sessionId) === overrideSessionId);
      if (hit) return hit;
    }
    return null;
  }, [overrideSessionId, session, calledSessions, upcomingSessions, pastSessions, daySessions]);

  // No auto-advance — staff explicitly picks the next call from the
  // live quick-pick pills. Deliberate: avoids Current changing out
  // from under someone who's about to scan again or double-checking
  // a rostered racer. The "all set" banner plus a fresh live pill
  // is enough of a nudge.

  return (
    <div className="min-h-screen bg-[#0a1128] text-white">
      {/* Build version — bottom-right corner, very small + low-contrast.
          Vercel injects VERCEL_GIT_COMMIT_SHA per deployment so this
          updates automatically. Useful for "what version am I on" when
          debugging mismatched-behavior reports across devices. */}
      {version && (
        <div
          className="fixed bottom-1 right-1.5 text-[9px] font-mono text-white/20 pointer-events-none select-none z-[9999]"
          aria-label={`Build ${version}`}
        >
          v {version}
        </div>
      )}
      {/* Full-screen success flash. Keyed on flashCounter so each
          successful scan remounts the element and the animation
          restarts. pointer-events-none so it never blocks input. */}
      {flashCounter > 0 && (
        <div
          key={flashCounter}
          aria-hidden="true"
          className="scan-success-flash fixed inset-0 pointer-events-none z-[10000]"
          style={{ backgroundColor: "#34d399" }}
        />
      )}
      <div className="max-w-5xl mx-auto p-3 sm:p-6">
        <header className="mb-2 sm:mb-4">
          <h1 className="text-lg sm:text-2xl font-bold uppercase tracking-wider">Camera Assignment</h1>
          <p className="text-white/50 text-xs mt-0.5 hidden sm:block">
            Scan each camera&apos;s NFC tag to bind it to a racer.
          </p>
        </header>

        {/* Track chips share a row with the action buttons. On mobile
            Earlier + Keyboard compress to icon-only so all five controls
            fit on one line. */}
        <div className="flex items-center gap-1.5 sm:gap-2 mb-2 flex-wrap">
          {visibleChips.map((t) => {
            const isActive = track === t.slug;
            return (
              <button
                key={t.slug}
                type="button"
                onClick={() => setTrack(isActive ? "" : t.slug)}
                className={`text-xs uppercase tracking-wider font-semibold px-2.5 sm:px-3 py-1.5 rounded border transition-colors ${
                  isActive ? t.active : `bg-white/[0.02] ${t.idle}`
                }`}
              >
                {t.label}
              </button>
            );
          })}
          <div className="ml-auto flex items-center gap-1.5">
            {/* Earlier-sessions and Keyboard toggle removed —
                superseded by the always-visible scrollable heat list
                below + the NFC reader's keyboard emulation. The
                Earlier modal is no longer needed since staff can
                scroll to any past heat in the day-list, and the
                on-screen keyboard toggle was unused on the production
                NFC kiosks. */}
            {nfcSupported && (
              <button
                type="button"
                onClick={() => void toggleNfc()}
                title={nfcActive ? "Stop listening for NFC tags" : "Use this phone's NFC radio (tap a tag to assign)"}
                aria-label={nfcActive ? "Stop NFC scanning" : "Start NFC scanning"}
                className={`text-xs uppercase tracking-wider font-semibold px-2.5 py-1.5 rounded border transition-colors inline-flex items-center gap-1 ${
                  nfcActive
                    ? "bg-[#00E2E5]/20 border-[#00E2E5]/60 text-[#00E2E5] animate-pulse"
                    : "bg-white/[0.02] border-white/15 text-white/60 hover:bg-white/10"
                }`}
              >
                <span>📡</span>
                <span className="hidden sm:inline">NFC {nfcActive ? "on" : "off"}</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => void toggleFullscreen()}
              title={isFullscreen ? "Exit fullscreen" : "Hide browser chrome + status bar for kiosk use"}
              aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
              className={`text-xs uppercase tracking-wider font-semibold px-2.5 py-1.5 rounded border transition-colors inline-flex items-center gap-1 ${
                isFullscreen
                  ? "bg-white/15 border-white/30 text-white"
                  : "bg-white/[0.02] border-white/15 text-white/60 hover:bg-white/10"
              }`}
            >
              <span>{isFullscreen ? "🗗" : "⛶"}</span>
              <span className="hidden sm:inline">{isFullscreen ? "Exit" : "Full"}</span>
            </button>
            <button
              type="button"
              onClick={openBarcodeModal}
              title="Map physical camera barcodes to camera numbers (1-96)"
              aria-label="Open barcode provisioning"
              className="text-xs uppercase tracking-wider font-semibold px-2.5 py-1.5 rounded border transition-colors inline-flex items-center gap-1 bg-white/[0.02] border-white/15 text-white/60 hover:bg-white/10"
            >
              <span>🏷</span>
              <span className="hidden sm:inline">BC</span>
            </button>
          </div>
        </div>

        {/* Working-on pill — shows which heat is currently loaded,
            with an inline "Change" button on mobile that opens the
            heat-picker modal. Desktop uses the inline schedule panel
            below instead, so no Change button is rendered on md+. */}
        {track && (() => {
          const pillClass = "shrink-0 text-xs uppercase tracking-wider font-semibold px-2.5 py-1 rounded border transition-colors";
          return (
            <div
              className="flex items-stretch flex-wrap gap-1.5 mb-2"
              role="group"
              aria-label="Current heat"
            >
              {session ? (
                <span
                  className={`${pillClass} inline-flex items-center gap-1.5 ${trackChipClasses(session.track, true)}`}
                >
                  <span aria-hidden="true" className="inline-block w-1.5 h-1.5 rounded-full bg-current" />
                  {sessionChipLabel(session, { dropTrack: true })}
                </span>
              ) : pendingSessionLabel ? (
                <span
                  className={`${pillClass} inline-flex items-center gap-1.5 ${trackChipClasses(pendingSessionLabel.track, true)}`}
                >
                  <span
                    aria-hidden="true"
                    className="inline-block w-3 h-3 rounded-full border-2 border-current/30 border-t-current animate-spin"
                  />
                  {sessionChipLabel(pendingSessionLabel, { dropTrack: true })}
                </span>
              ) : (
                <span className={`${pillClass} border-dashed border-white/25 text-white/40 inline-flex items-center gap-1.5`}>
                  <span aria-hidden="true" className="inline-block w-1.5 h-1.5 rounded-full bg-white/30" />
                  Pick a heat
                </span>
              )}
              {/* Small Change button — mobile only. Desktop has the
                  inline schedule list below and doesn't need this. */}
              <button
                type="button"
                onClick={() => setHeatModalOpen(true)}
                className={`${pillClass} md:hidden border-[#00E2E5]/40 text-[#00E2E5] hover:bg-[#00E2E5]/10`}
              >
                Change ▸
              </button>
            </div>
          );
        })()}

        {/* Full-day schedule — every heat for the selected track today,
            sorted by time. Replaces the old ±3 called + ±3 upcoming
            pill strip + Earlier modal.
            - Desktop (md+): inline scrollable panel.
            - Mobile (<md):  summary button that opens a fullscreen
                             modal with bigger tap targets. */}
        {track && (() => {
          const activeSid = activeSessionId;
          const fmt = (iso: string) => new Date(iso).toLocaleString("en-US", {
            timeZone: "America/New_York",
            hour: "numeric", minute: "2-digit", hour12: true,
          });
          const counts = {
            past: daySessions.filter((s) => s.status === "past").length,
            live: daySessions.filter((s) => s.status === "live").length,
            upcoming: daySessions.filter((s) => s.status === "upcoming").length,
          };
          const summaryText = daySessions.length === 0 && !dayLoading
            ? "No heats today"
            : `${daySessions.length} heat${daySessions.length === 1 ? "" : "s"} · ${counts.past} done · ${counts.live} live · ${counts.upcoming} upcoming`;

          // The session that auto-scroll should target on load.
          // Prefer a "live" heat (currently running); fall back to
          // the first upcoming one. Computed once per render.
          const focusSessionId = (
            daySessions.find((s) => s.status === "live")
            || daySessions.find((s) => s.status === "upcoming")
          )?.sessionId;

          // Shared row renderer for both desktop list + mobile modal.
          // `bigTouch` controls padding + font-size so the mobile modal
          // gets fat-finger-friendly tap targets.
          const renderRow = (s: DaySession, bigTouch: boolean) => {
            const isLoaded = activeSid === String(s.sessionId);
            const isPicking = pickingSid === String(s.sessionId);
            const statusIcon = s.status === "past" ? "✓" : s.status === "live" ? "●" : "○";
            const statusColor = s.status === "past" ? "text-white/40" : s.status === "live" ? "text-[#00E2E5]" : "text-white/60";
            const isFocusTarget = String(s.sessionId) === String(focusSessionId);
            return (
              <button
                key={`day-${s.sessionId}`}
                type="button"
                ref={isFocusTarget ? liveHeatRef : null}
                onClick={() => {
                  if (isLoaded) {
                    setHeatModalOpen(false);
                    return;
                  }
                  // Close the modal immediately — the participants
                  // panel underneath swaps to a "Loading Heat N…"
                  // state driven by `loading && pickingSid` while
                  // the fetch is in flight, so the operator gets
                  // clear feedback without the modal sitting on
                  // top of it. `pickingSid` clears once the new
                  // session lands (see useEffect above).
                  setHeatModalOpen(false);
                  setPickingSid(String(s.sessionId));
                  setOverrideSessionId(String(s.sessionId));
                  void loadSession(String(s.sessionId));
                }}
                disabled={isLoaded || !!pickingSid}
                className={`w-full flex items-center gap-2 text-left border-t border-white/[0.04] transition-colors disabled:cursor-not-allowed ${
                  bigTouch ? "px-4 py-3.5 text-sm" : "px-3 py-2 text-xs"
                } ${
                  isPicking
                    ? "bg-[#00E2E5]/20 border-[#00E2E5]/40"
                    : isLoaded
                      ? "bg-[#00E2E5]/15 cursor-default"
                      : pickingSid
                        ? "opacity-40"
                        : s.status === "past"
                          ? "opacity-60 hover:bg-white/[0.03] hover:opacity-100"
                          : s.status === "live"
                            ? "bg-[#00E2E5]/5 hover:bg-[#00E2E5]/10 animate-pulse"
                            : "hover:bg-white/[0.04]"
                }`}
                title={isLoaded ? "Currently loaded" : `Load Heat ${s.heatNumber}`}
              >
                {isPicking ? (
                  <span
                    aria-hidden="true"
                    className={`${bigTouch ? "w-5 h-5" : "w-4 h-4"} shrink-0 inline-block rounded-full border-2 border-[#00E2E5]/30 border-t-[#00E2E5] animate-spin`}
                  />
                ) : (
                  <span aria-hidden="true" className={`${bigTouch ? "w-5 text-base" : "w-4"} text-center shrink-0 ${statusColor}`}>
                    {statusIcon}
                  </span>
                )}
                <span className={`tabular-nums text-white/80 shrink-0 ${bigTouch ? "w-20" : "w-16"}`}>
                  {fmt(s.scheduledStart)}
                </span>
                <span className={`text-white/50 shrink-0 uppercase tracking-wider ${bigTouch ? "w-20" : "w-14"}`}>
                  Heat <span className="text-white font-semibold">{s.heatNumber}</span>
                </span>
                <span className="text-white/60 flex-1 truncate">
                  {s.type}
                </span>
                <span
                  className={`tabular-nums px-1.5 py-0.5 rounded shrink-0 ${
                    bigTouch ? "text-sm" : "text-xs"
                  } ${
                    s.assignedCount > 0
                      ? "bg-emerald-500/15 text-emerald-300"
                      : "bg-white/5 text-white/40"
                  }`}
                  title={`${s.assignedCount} camera${s.assignedCount === 1 ? "" : "s"} assigned`}
                >
                  {s.assignedCount} cam
                </span>
              </button>
            );
          };

          return (
            <>
              {/* Mobile uses the inline "Change ▸" button up on the
                  Working-on pill row — no big summary card needed
                  here. Desktop keeps the inline schedule panel. */}

              {/* Desktop inline panel (md+). */}
              <div className="hidden md:block mb-3 rounded-lg border border-white/10 bg-white/[0.02]">
                <div className="flex items-center justify-between px-3 py-2 border-b border-white/5">
                  <div className="text-xs text-white/50 uppercase tracking-wider">{summaryText}</div>
                  {dayLoading && (
                    <span
                      aria-hidden="true"
                      className="inline-block w-3 h-3 rounded-full border-2 border-white/20 border-t-[#00E2E5] animate-spin"
                    />
                  )}
                </div>
                <div className="max-h-[260px] overflow-y-auto">
                  {daySessions.length === 0 && !dayLoading && (
                    <div className="text-center text-white/30 text-xs py-6">No heats found for this track today.</div>
                  )}
                  {daySessions.map((s) => renderRow(s, false))}
                </div>
              </div>

              {/* Mobile heat-picker modal. */}
              {heatModalOpen && (
                <div
                  className="fixed inset-0 z-[9999] flex items-stretch justify-center p-0 bg-black/80 md:hidden"
                  style={{ height: "100dvh" }}
                  {...modalBackdropProps(() => { setHeatModalOpen(false); setPickingSid(null); })}
                >
                  <div
                    className="relative w-full h-full flex flex-col"
                    style={{ backgroundColor: "#0a1128" }}
                  >
                    <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
                      <div>
                        <div className="text-base font-bold uppercase tracking-wider">
                          {track.toUpperCase()} Heats
                        </div>
                        <div className="text-xs text-white/50 mt-0.5">{summaryText}</div>
                      </div>
                      <button
                        type="button"
                        onClick={() => { setHeatModalOpen(false); setPickingSid(null); }}
                        aria-label="Close heat picker"
                        className="w-10 h-10 flex items-center justify-center rounded-full bg-white/10 hover:bg-white/20 text-white"
                        style={{ fontSize: "22px", lineHeight: 1 }}
                      >
                        &times;
                      </button>
                    </div>
                    <div className="flex-1 overflow-y-auto">
                      {daySessions.length === 0 && !dayLoading && (
                        <div className="text-center text-white/30 text-sm py-10">No heats found for this track today.</div>
                      )}
                      {daySessions.map((s) => renderRow(s, true))}
                    </div>
                  </div>
                </div>
              )}
            </>
          );
        })()}

        {/* Summary line — session info + counter + reload, mirroring
            SMS admin's "N matches · Refresh" strip */}
        <div className="flex items-center justify-between gap-2 mb-2 text-xs text-white/50">
          <span className="truncate">
            {loading
              ? "Loading…"
              : session
                ? <>
                    {session.track.replace(" Track", "")} · Heat {session.heatNumber} · {session.type} · {formatEt(session.scheduledStart)}
                    <span className="ml-2 text-white/70"><span className="text-[#00E2E5] font-semibold">{assignedCount}</span> / {totalCount} assigned</span>
                  </>
                : note || "—"}
            {err && <span className="ml-2 text-red-400">· {err}</span>}
          </span>
          <div className="flex items-center gap-3 shrink-0">
            {session && (
              sessionBlock.blocked ? (
                <button
                  type="button"
                  onClick={() => void unblockHeat()}
                  disabled={blockBusy}
                  className="text-xs uppercase tracking-wider font-semibold px-2.5 py-1 rounded bg-red-500/20 border border-red-500/50 text-red-200 hover:bg-red-500/30 disabled:opacity-50"
                  title={sessionBlock.reason ? `Blocked: ${sessionBlock.reason}` : "Unblock this heat"}
                >
                  🚫 Unblock Heat
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => { setBlockModalTarget("heat"); setBlockReason("Crash"); setBlockReasonOther(""); }}
                  disabled={blockBusy}
                  className="text-xs uppercase tracking-wider font-semibold px-2.5 py-1 rounded border border-white/15 text-white/70 hover:bg-red-500/10 hover:border-red-500/40 hover:text-red-300 disabled:opacity-50"
                  title="Block all videos from this heat — no SMS/email will send"
                >
                  Block Heat
                </button>
              )
            )}
            <button
              type="button"
              // Refresh the CURRENTLY LOADED heat (or pending pick if
              // staff just tapped a row but the fetch is still in
              // flight). Falls back to "next upcoming" only when no
              // heat is selected — previously we always cleared
              // overrideSessionId, which kicked staff out of any
              // past/manually-picked heat they were working on.
              onClick={() => {
                const sid = session
                  ? String(session.sessionId)
                  : (overrideSessionId || undefined);
                // Manual refresh — bypass the Redis cache and force
                // a live Pandora call so staff see fresh data
                // (the auto-poll uses cache-first for speed).
                if (sid) {
                  setOverrideSessionId(sid);
                  void loadSession(sid, true);
                } else {
                  void loadSession(undefined, true);
                }
              }}
              className="text-[#00E2E5] hover:underline"
            >
              Refresh
            </button>
          </div>
        </div>

        {/* Heat-blocked banner — loud so staff can't miss it. */}
        {sessionBlock.blocked && (
          <div className="mb-2 rounded-lg border border-red-500/50 bg-red-500/10 px-3 py-2 text-sm">
            <div className="flex items-center gap-2 text-red-200 font-semibold uppercase tracking-wide text-xs">
              <span aria-hidden="true">🚫</span>
              <span>Heat blocked — no videos will send</span>
            </div>
            {sessionBlock.reason && (
              <div className="mt-1 text-xs text-red-300/80">Reason: {sessionBlock.reason}</div>
            )}
          </div>
        )}

        {/* Scan input — the one on-brand flourish: sticky cyan slab so
            it's impossible to miss. Kept compact and single-line. */}
        <div className="sticky top-2 z-10 rounded-lg border border-[#00E2E5]/40 bg-[#00E2E5]/5 p-2.5 mb-3">
          <label htmlFor="camera-scan-input" className="text-xs text-white/60 block mb-1">
            Scan NFC tag (or type camera # and tap Assign)
          </label>
          <div className="flex gap-2">
            <input
              id="camera-scan-input"
              ref={inputRef}
              // type="text" so camera-app QR scanners (which paste
              // alphanumeric values) work alongside HID readers.
              // The barcode→camera translation in assign() handles
              // either format.
              type="text"
              // `inputMode="none"` alone for soft-keyboard suppression
              // on Android. We deliberately AVOID `readOnly` because
              // phone-camera QR scanner apps deliver decoded values
              // via PASTE, and browsers block paste on read-only
              // inputs. (Same fix already applied to the barcode
              // provisioning modal — was blocking scans there too.)
              inputMode={showKeyboard ? "text" : "none"}
              enterKeyHint="enter"
              value={scanBuffer}
              onChange={(e) => {
                const v = e.target.value;
                setScanBuffer(v);
                // Auto-fire when the scanner finishes writing a
                // standard 7-character scan (configured camera-tag
                // length). Covers HID readers that don't send Enter.
                const trimmed = v.trim();
                if (trimmed.length === 7) {
                  setScanBuffer("");
                  void assign(trimmed);
                }
              }}
              onKeyDown={onInputKey}
              onPaste={(e) => {
                // Camera-app QR scanners paste here. Auto-fire the
                // assign() flow on paste so staff doesn't need to
                // tap Assign or press Enter.
                const text = e.clipboardData?.getData("text") || "";
                const trimmed = text.trim();
                if (trimmed.length >= 1) {
                  e.preventDefault();
                  setScanBuffer("");
                  void assign(trimmed);
                }
              }}
              placeholder={nfcActive ? "📡 Listening — tap an NFC tag…" : "Waiting for scan…"}
              autoComplete="off"
              className={`flex-1 min-w-0 bg-white/5 rounded px-2 py-2 text-base text-white font-mono placeholder:text-white/30 border transition-colors ${
                unknownScanFlash
                  ? "border-red-500/80 bg-red-500/15 animate-pulse"
                  : "border-white/10"
              }`}
            />
            {/* Manual-submit button — iOS's numeric pad has no Enter
                key, so staff needs an explicit Assign control to commit
                the camera #. The NFC scanner's Enter keystroke still
                works via onInputKey. Disabled when nothing's typed. */}
            <button
              type="button"
              onClick={() => {
                const val = scanBuffer.trim();
                if (!val) return;
                setScanBuffer("");
                void assign(val);
              }}
              disabled={!scanBuffer.trim()}
              className="shrink-0 px-4 py-2 rounded bg-[#00E2E5] text-[#000418] font-semibold text-sm hover:bg-white disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Assign
            </button>
          </div>
          {lastScan && (
            <div className="mt-1 text-xs text-emerald-400 truncate">
              ✓ Camera <span className="font-mono">{lastScan.camera}</span> → {lastScan.racer}
            </div>
          )}
          {nfcError && (
            <div className="mt-1 text-xs text-red-400 truncate">
              NFC: {nfcError}
            </div>
          )}
        </div>

        {/* Participants list — matches SMS admin card density */}
        <div className="space-y-2">
          {!track && (
            <div className="rounded-lg border-2 border-dashed border-[#00E2E5]/40 bg-[#00E2E5]/5 text-center py-10 px-4">
              <div className="text-[#00E2E5] text-sm font-semibold uppercase tracking-wider mb-1">
                Select a track to start
              </div>
              <div className="text-white/50 text-xs">
                Tap <span className="font-semibold text-[#00E2E5]">Blue</span>,
                {" "}<span className="font-semibold text-[#ff7171]">Red</span>, or
                {" "}<span className="font-semibold text-[#c4adff]">Mega</span> above.
              </div>
            </div>
          )}
          {track && loading && participants.length === 0 && (() => {
            // Resolve the heat the operator just tapped so the
            // loading copy reads "Loading Heat 12…" instead of a
            // generic spinner. Falls back to a plain "Loading
            // heat…" label if pickingSid isn't a known session
            // (initial load, manual reload, etc.).
            const pickingHeat = pickingSid
              ? daySessions.find((s) => String(s.sessionId) === pickingSid)?.heatNumber
              : null;
            const loadingLabel = pickingHeat ? `Loading Heat ${pickingHeat}…` : "Loading heat…";
            return (
            <div className="rounded-lg border border-white/10 bg-white/[0.02] text-center py-10">
              <div className="inline-flex items-center gap-2 text-[#00E2E5] text-sm">
                <span
                  aria-hidden="true"
                  className="inline-block w-4 h-4 rounded-full border-2 border-[#00E2E5]/30 border-t-[#00E2E5] animate-spin"
                />
                {loadingLabel}
              </div>
            </div>
            );
          })()}
          {track && participants.length === 0 && !loading && (
            <div className="rounded-lg border border-white/10 bg-white/[0.02] text-center text-white/40 py-8">
              No participants.
            </div>
          )}
          {participants.map((p, i) => {
            const isActive = i === activeIndex;
            const hasCam = !!p.systemNumber;
            const isBlocked = !!p.block?.blocked;
            // When heat is blocked but this racer has an explicit
            // person-level unblock override, paint a distinguishing
            // chip so staff remembers the override is in effect.
            const personOverride = !isBlocked && sessionBlock.blocked && p.block?.level === "person";
            // Duplicate-camera blink — conflictBlinkPid is set for ~2.5s
            // after staff tries to scan a camera already bound to this
            // racer; the CSS animation on this class pulses red.
            const isConflict = conflictBlinkPid === String(p.personId);
            return (
              <button
                key={String(p.personId)}
                type="button"
                ref={isActive ? activeRacerRef : null}
                onClick={() => setActiveIndex(i)}
                style={isActive ? { boxShadow: "0 0 18px rgba(0,226,229,0.45)" } : undefined}
                className={`w-full text-left rounded-lg border p-3 transition-colors ${
                  isConflict
                    ? "border-red-500/80 bg-red-500/25 animate-pulse"
                    : isBlocked
                      ? "border-red-500/40 bg-red-500/10"
                      : isActive
                        ? "border-[#00E2E5]/60 bg-[#00E2E5]/10"
                        : hasCam
                          ? "border-emerald-500/25 bg-emerald-500/5"
                          : "border-white/10 bg-white/[0.02] hover:bg-white/[0.04]"
                }`}
              >
                {/* Two-row on mobile, one-row on sm+ (tablets/desktop).
                    Row 1: index number + driver name + status chips
                           → full width, name not truncated on phones.
                    Row 2 (mobile only): cam chip, scan-next, redo, block
                           buttons. Indented past the number column so
                           it lines up with the name above. */}
                <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3">
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    <div className={`text-sm tabular-nums w-6 text-center shrink-0 ${
                      isBlocked ? "text-red-300" : isActive ? "text-[#00E2E5]" : hasCam ? "text-emerald-400" : "text-white/40"
                    }`}>
                      {i + 1}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className={`text-sm font-semibold ${isBlocked ? "text-red-300" : ""}`}>
                        <span className="break-words">{p.firstName} {p.lastName}</span>
                        {isBlocked && (
                          <span
                            className="ml-2 text-[10px] uppercase px-1.5 py-0.5 rounded bg-red-500/25 text-red-200 align-middle"
                            title={p.block?.reason ? `Blocked: ${p.block.reason}` : `Blocked (${p.block?.level})`}
                          >
                            🚫 blocked
                          </span>
                        )}
                        {personOverride && (
                          <span
                            className="ml-2 text-[10px] uppercase px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 align-middle"
                            title="Heat is blocked but this racer is released"
                          >
                            released
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  {/* Action row — mobile-indented to align with the name,
                      desktop stays right-aligned inline. */}
                  <div className="flex items-center gap-2 shrink-0 pl-9 sm:pl-0">
                    {hasCam ? (
                      <>
                        <span className="text-xs uppercase px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 font-mono">
                          cam {p.systemNumber}
                        </span>
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); void unassign(i); }}
                          aria-label={`Un-assign camera from ${p.firstName} ${p.lastName}`}
                          title="Un-assign this camera (re-scan to reassign)"
                          className="text-xs px-1.5 py-0.5 rounded border border-white/15 text-white/50 hover:text-amber-300 hover:border-amber-500/40 transition-colors"
                        >
                          redo
                        </button>
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); void togglePersonBlock(p); }}
                          disabled={blockBusy}
                          aria-label={isBlocked ? `Unblock ${p.firstName} ${p.lastName}` : `Block ${p.firstName} ${p.lastName}`}
                          title={isBlocked ? "Unblock this racer" : "Block this racer's videos"}
                          className={`text-xs px-1.5 py-0.5 rounded border transition-colors disabled:opacity-50 ${
                            isBlocked
                              ? "border-red-500/50 bg-red-500/20 text-red-200 hover:bg-red-500/30"
                              : "border-white/15 text-white/50 hover:text-red-300 hover:border-red-500/40"
                          }`}
                        >
                          {isBlocked ? "unblock" : "block"}
                        </button>
                      </>
                    ) : (
                      <>
                        {isActive && (
                          <span className="text-xs uppercase px-1.5 py-0.5 rounded bg-[#00E2E5]/20 text-[#00E2E5]">
                            scan next
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); void togglePersonBlock(p); }}
                          disabled={blockBusy}
                          aria-label={isBlocked ? `Unblock ${p.firstName} ${p.lastName}` : `Block ${p.firstName} ${p.lastName}`}
                          title={isBlocked ? "Unblock this racer" : "Block this racer's videos"}
                          className={`text-xs px-1.5 py-0.5 rounded border transition-colors disabled:opacity-50 ${
                            isBlocked
                              ? "border-red-500/50 bg-red-500/20 text-red-200 hover:bg-red-500/30"
                              : "border-white/10 text-white/40 hover:text-red-300 hover:border-red-500/40"
                          }`}
                        >
                          {isBlocked ? "unblock" : "block"}
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </button>
            );
          })}
        </div>

        {doneAll && (
          <div className="mt-4 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-center text-sm">
            <span className="text-emerald-300 font-semibold">All cameras assigned ✓</span>
            <span className="text-emerald-400/70 ml-2">{assignedCount} registered</span>
          </div>
        )}
      </div>

      {/* Earlier-sessions modal. Rarely used, lives behind the ⏮ button. */}
      {pastModalOpen && (
        <div
          className="fixed inset-0 z-[9999] flex items-start justify-center p-3 bg-black/80"
          style={{ height: "100dvh" }}
          {...modalBackdropProps(() => setPastModalOpen(false))}
        >
          <div
            className="relative w-full max-w-md rounded-xl mt-10"
            style={{ backgroundColor: "#0a1128", border: "1.78px solid rgba(255,255,255,0.1)", maxHeight: "calc(100dvh - 5rem)", overflowY: "auto" }}
          >
            <button
              type="button"
              onClick={() => setPastModalOpen(false)}
              aria-label="Close"
              className="absolute top-2 right-2 z-10 w-8 h-8 flex items-center justify-center rounded-full bg-white/10 hover:bg-white/20 text-white"
              style={{ fontSize: "20px", lineHeight: 1 }}
            >
              &times;
            </button>
            <div className="p-4 sm:p-5">
              <h3 className="text-base font-bold uppercase tracking-wide mb-3 pr-10">
                Earlier sessions today
              </h3>
              {pastSessions.length === 0 ? (
                <div className="text-white/40 text-sm py-3">
                  {pastLoaded ? "No earlier sessions today." : "Loading…"}
                </div>
              ) : (
                <div className="space-y-1.5 max-h-[60vh] overflow-y-auto">
                  {pastSessions.map((s) => (
                    <button
                      key={s.sessionId}
                      type="button"
                      onClick={() => {
                        setOverrideSessionId(String(s.sessionId));
                        void loadSession(String(s.sessionId));
                        setPastModalOpen(false);
                      }}
                      className="w-full text-left rounded border border-white/10 bg-white/[0.02] hover:bg-white/5 px-3 py-2 text-sm"
                    >
                      <div className="font-semibold text-white truncate">
                        {sessionChipLabel(s)}
                      </div>
                      <div className="text-xs text-white/50 mt-0.5">
                        {formatEt(s.scheduledStart)}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Barcode-provisioning modal. Lists all 96 cameras; staff
          taps a row to make it the active scan target, then scans
          (or types) the barcode and presses Enter. Auto-advances
          to the next unmapped camera on save so a USB barcode
          reader can chain scans hands-free. */}
      {barcodeModalOpen && (
        <div
          className="fixed inset-0 z-[9999] flex items-stretch justify-center p-0 bg-black/80"
          style={{ height: "100dvh" }}
          {...modalBackdropProps(() => setBarcodeModalOpen(false))}
        >
          <div className="relative w-full max-w-2xl mx-auto h-full flex flex-col" style={{ backgroundColor: "#0a1128" }}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 shrink-0">
              <div>
                <div className="text-base font-bold uppercase tracking-wider">🏷 Barcode → Camera</div>
                <div className="text-xs text-white/50 mt-0.5">
                  {Object.keys(barcodeMap).length} / 96 mapped
                  {barcodeLoading && " · loading…"}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setBarcodeModalOpen(false)}
                aria-label="Close barcode provisioning"
                className="w-10 h-10 flex items-center justify-center rounded-full bg-white/10 hover:bg-white/20 text-white"
                style={{ fontSize: "22px", lineHeight: 1 }}
              >
                &times;
              </button>
            </div>

            {/* Sticky scan input */}
            <div className="px-4 py-3 border-b border-white/10 bg-[#0a1128] sticky top-0 z-10 shrink-0">
              <div className="text-xs text-white/60 mb-1">
                Scan or type barcode for{" "}
                <span className="text-[#00E2E5] font-semibold">Camera {barcodeActiveCam}</span>
              </div>
              <div className="flex gap-2">
                <input
                  ref={barcodeInputRef}
                  type="text"
                  // `inputMode="none"` alone for soft-keyboard
                  // suppression. We deliberately AVOID `readOnly`
                  // here because phone-camera QR scanner apps
                  // dispatch their decoded result via paste — and
                  // browsers block paste on read-only inputs. That
                  // was the reason scans only worked with the Kb
                  // toggle on. Now any input path lands the scan:
                  //   - HID USB scanner → keydown stream → caught
                  //     by the document-level listener (in capture
                  //     phase) AND mirrored here via onChange
                  //   - Camera-app QR scanner → paste event →
                  //     onChange fires → buffer updates
                  //   - Manual typing → only if Kb toggle is on
                  inputMode={showKeyboard ? "text" : "none"}
                  value={barcodeInput}
                  onChange={(e) => {
                    const v = e.target.value;
                    setBarcodeInput(v);
                    barcodeBufferRef.current = v;
                    // Auto-save when the value reaches the standard
                    // 7-character scan length.
                    if (v.trim().length === 7) {
                      autoSaveBarcode(v);
                    }
                  }}
                  onPaste={(e) => {
                    // Phone-camera QR scanner apps deliver decoded
                    // values via paste. Save immediately.
                    const text = e.clipboardData?.getData("text") || "";
                    const trimmed = text.trim();
                    if (trimmed.length >= 1) {
                      e.preventDefault();
                      setBarcodeInput(trimmed);
                      barcodeBufferRef.current = trimmed;
                      void saveBarcode(barcodeActiveCam, trimmed);
                    }
                  }}
                  placeholder="Waiting for barcode scan…"
                  autoComplete="off"
                  className="flex-1 min-w-0 bg-white/5 border border-[#00E2E5]/40 rounded px-3 py-2 text-sm text-white font-mono placeholder:text-white/30"
                />
                <button
                  type="button"
                  onClick={() => {
                    const v = barcodeInput.trim();
                    if (v) void saveBarcode(barcodeActiveCam, v);
                  }}
                  disabled={!barcodeInput.trim()}
                  className="shrink-0 px-4 py-2 rounded bg-[#00E2E5] text-[#000418] font-semibold text-sm hover:bg-white disabled:opacity-40"
                >
                  Save
                </button>
              </div>
              {barcodeErr && (
                <div className="mt-1 text-xs text-red-400">{barcodeErr}</div>
              )}
            </div>

            {/* Camera list — 1 to 96. The entire row is tappable to
                make it the active scan target; selecting auto-focuses
                the scan input so the next barcode scan lands there. */}
            <div className="flex-1 overflow-y-auto">
              {Array.from({ length: 96 }, (_, i) => i + 1).map((camN) => {
                const bc = barcodeMap[String(camN)] || "";
                const isActive = camN === barcodeActiveCam;
                const selectThis = () => {
                  setBarcodeActiveCam(camN);
                  setBarcodeInput("");
                  setBarcodeErr(null);
                  // Focus input so the very next scan/keydown lands in
                  // it. Use rAF instead of setTimeout(0) so React's
                  // commit + the modal scroll settle first. Then scroll
                  // the input into view so it's not hidden by the
                  // virtual keyboard or scroll position.
                  requestAnimationFrame(() => {
                    barcodeInputRef.current?.focus();
                    barcodeInputRef.current?.scrollIntoView({ block: "nearest" });
                  });
                };
                return (
                  // Outer div instead of <button> so we can nest a
                  // real <button> for the clear action without
                  // violating "no nested interactive" rules. role=button
                  // + onKeyDown make it keyboard-equivalent.
                  <div
                    key={`bc-${camN}`}
                    role="button"
                    tabIndex={0}
                    onClick={selectThis}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        selectThis();
                      }
                    }}
                    className={`w-full flex items-center gap-2 px-4 py-3 text-sm border-t border-white/[0.04] text-left transition-colors cursor-pointer ${
                      isActive
                        ? "bg-[#00E2E5]/15 border-y-[#00E2E5]/40"
                        : "hover:bg-white/[0.03] active:bg-[#00E2E5]/10"
                    }`}
                    aria-label={`Select camera ${camN} as active scan target`}
                    aria-pressed={isActive}
                  >
                    <span className={`w-16 shrink-0 tabular-nums uppercase tracking-wider ${
                      isActive ? "text-[#00E2E5] font-bold" : "text-white/70"
                    }`}>
                      Cam {camN}
                    </span>
                    <span className={`flex-1 truncate font-mono text-xs ${bc ? "text-emerald-300" : "text-white/30"}`}>
                      {bc || "— no barcode —"}
                    </span>
                    {bc && (
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); void deleteBarcode(camN); }}
                        className="shrink-0 text-xs px-2 py-1 rounded border border-white/15 text-white/50 hover:text-red-300 hover:border-red-500/40"
                        aria-label={`Clear barcode for camera ${camN}`}
                      >
                        clear
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Unified block confirmation modal — handles both heat-wide and
          per-racer blocks. Reason is a dropdown of preset categories
          so staff picks from a consistent vocabulary; "Other" reveals
          a free-text field for the rare case not covered by presets. */}
      {blockModalTarget && session && (() => {
        const isHeat = blockModalTarget === "heat";
        const personTarget = isHeat ? null : (blockModalTarget as Participant);
        const onClose = () => { if (!blockBusy) resetBlockModal(); };
        const onSubmit = () => { void (isHeat ? submitHeatBlockFromModal() : submitPersonBlockFromModal()); };
        return (
          <div
            className="fixed inset-0 z-[9999] flex items-center justify-center p-3 bg-black/80"
            style={{ height: "100dvh" }}
            {...modalBackdropProps(onClose)}
          >
            <div
              className="relative w-full max-w-md rounded-xl"
              style={{ backgroundColor: "#0a1128", border: "1.78px solid rgba(239,68,68,0.4)", maxHeight: "calc(100dvh - 1.5rem)", overflowY: "auto" }}
            >
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                disabled={blockBusy}
                className="absolute top-3 right-3 z-10 w-8 h-8 flex items-center justify-center rounded-full bg-white/10 hover:bg-white/20 text-white disabled:opacity-50"
                style={{ fontSize: "20px", lineHeight: 1 }}
              >
                &times;
              </button>
              <div className="p-5 sm:p-6">
                <h3 className="text-lg font-bold uppercase tracking-wide mb-2 pr-10 text-red-300">
                  🚫 {isHeat ? "Block this heat?" : "Block this racer?"}
                </h3>
                <p className="text-sm text-white/70 mb-3">
                  {isHeat ? (
                    <>
                      All <span className="font-semibold text-white">{totalCount}</span> racers in{" "}
                      <span className="font-semibold text-white">
                        {session.track.replace(" Track", "")} · Heat {session.heatNumber} · {session.type}
                      </span>{" "}
                      will be blocked.
                    </>
                  ) : personTarget && (
                    <>
                      <span className="font-semibold text-white">
                        {personTarget.firstName} {personTarget.lastName}
                      </span>
                      {personTarget.systemNumber && (
                        <> (cam <span className="font-mono text-emerald-300">{personTarget.systemNumber}</span>)</>
                      )}
                      {" "}will be blocked.
                    </>
                  )}{" "}
                  Video{isHeat ? "s" : ""} will still be matched + visible in the admin, but
                  <span className="text-red-300 font-semibold"> no SMS or email will send</span>,
                  and the vt3.io link will be disabled.
                </p>
                <label className="flex flex-col gap-1 text-xs text-white/60 mb-3">
                  Reason
                  <select
                    value={blockReason}
                    onChange={(e) => setBlockReason(e.target.value as BlockReason)}
                    className="bg-white/5 border border-white/10 rounded px-2 py-1.5 text-sm text-white"
                  >
                    {BLOCK_REASONS.map((r) => (
                      <option key={r} value={r} style={{ backgroundColor: "#0a1128" }}>{r}</option>
                    ))}
                  </select>
                </label>
                {blockReason === "Other" && (
                  <label className="flex flex-col gap-1 text-xs text-white/60 mb-3">
                    Describe
                    <input
                      type="text"
                      value={blockReasonOther}
                      onChange={(e) => setBlockReasonOther(e.target.value)}
                      placeholder="Short reason for the block"
                      maxLength={200}
                      className="bg-white/5 border border-white/10 rounded px-2 py-1.5 text-sm text-white"
                    />
                  </label>
                )}
                <div className="flex flex-col-reverse sm:flex-row gap-2 sm:justify-end mt-3">
                  <button
                    type="button"
                    onClick={onClose}
                    disabled={blockBusy}
                    className="text-sm px-4 py-3 sm:py-2 rounded border border-white/20 text-white/70 hover:text-white disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={onSubmit}
                    disabled={blockBusy || (blockReason === "Other" && !blockReasonOther.trim())}
                    className="text-sm px-5 py-3 sm:py-2 rounded bg-red-500 text-white font-bold hover:bg-red-400 disabled:opacity-50"
                  >
                    {blockBusy ? "Blocking…" : isHeat ? "Block Heat" : "Block Racer"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
