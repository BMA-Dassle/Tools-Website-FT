"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { modalBackdropProps } from "@/lib/a11y";

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

export default function CameraAssignClient({ token, track: initialTrack }: { token: string; track?: string }) {
  const [track, setTrack] = useState<TrackSlug>((initialTrack as TrackSlug) || "");
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
  /** Row-blink state for duplicate-camera rejection. When a staffer
   *  scans a camera already bound to another racer in the current
   *  session, we flash THAT row red and hold the cursor on the
   *  current racer so they can re-scan a different camera. Cleared
   *  on a timer so the red fades out. */
  const [conflictBlinkPid, setConflictBlinkPid] = useState<string | null>(null);
  const conflictTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (conflictTimerRef.current) clearTimeout(conflictTimerRef.current); }, []);

  const inputRef = useRef<HTMLInputElement | null>(null);
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
  const loadSession = useCallback(async (sessionIdOverride?: string) => {
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
  const refreshSession = useCallback(async () => {
    // No track → nothing to refresh (UI is showing the pick-a-track prompt).
    if (!track) return;
    // Don't refresh while staff is on a test session (overrideSessionId)
    // or actively scanning — would clobber in-progress work.
    if (overrideSessionId) return;
    if (scanBufferRef.current) return;

    try {
      const qs = new URLSearchParams({ token, track });
      const res = await fetch(`/api/admin/camera-assign/session?${qs}`, { cache: "no-store" });
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
  const loadHeats = useCallback(async () => {
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
      const res = await fetch(`/api/admin/camera-assign/heats?${qs}`, { cache: "no-store" });
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
  const loadDay = useCallback(async () => {
    if (!track) { setDaySessions([]); setDayLoading(false); return; }
    if (scanBufferRef.current) return;
    setDayLoading(true);
    try {
      const qs = new URLSearchParams({ token, track });
      const res = await fetch(`/api/admin/camera-assign/day?${qs}`, { cache: "no-store" });
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

  // In-place refresh every 30s for the current roster + the heats feed
  // + the full-day schedule. Preserves scan state; merges new roster
  // changes.
  useEffect(() => {
    const id = setInterval(() => {
      void refreshSession();
      void loadHeats();
      void loadDay();
    }, 30_000);
    return () => clearInterval(id);
  }, [refreshSession, loadHeats, loadDay]);

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
    const sys = systemNumber.trim();
    if (!sys) return;
    if (activeIndex < 0 || activeIndex >= participants.length) {
      setErr("No racer highlighted — can't assign.");
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
  }, [participants, activeIndex, session, token]);

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
      setNfcError(e instanceof Error ? e.message : "NFC permission denied");
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
          {TRACK_CHIPS.map((t) => {
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
            <button
              type="button"
              onClick={() => setPastModalOpen(true)}
              disabled={!track || pastLoading || pastSessions.length === 0}
              title="Browse earlier sessions from today"
              aria-label="Earlier sessions"
              className="text-xs uppercase tracking-wider font-semibold px-2.5 py-1.5 rounded border border-white/15 bg-white/[0.02] text-white/70 hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed inline-flex items-center gap-1"
            >
              {pastLoading ? (
                <span
                  aria-hidden="true"
                  className="inline-block w-3 h-3 rounded-full border-2 border-white/20 border-t-white/70 animate-spin"
                />
              ) : (
                <span>⏮</span>
              )}
              <span className="hidden sm:inline">
                {pastLoading ? "Loading…" : "Earlier"}
              </span>
            </button>
            <button
              type="button"
              onClick={() => setShowKeyboard((v) => !v)}
              title="Toggle the on-screen keyboard when tapping the scan field"
              aria-label={`On-screen keyboard ${showKeyboard ? "on" : "off"}`}
              className={`text-xs uppercase tracking-wider font-semibold px-2.5 py-1.5 rounded border transition-colors inline-flex items-center gap-1 ${
                showKeyboard
                  ? "bg-white/15 border-white/30 text-white"
                  : "bg-white/[0.02] border-white/15 text-white/60 hover:bg-white/10"
              }`}
            >
              <span>⌨</span>
              <span className="hidden sm:inline">Kb {showKeyboard ? "on" : "off"}</span>
            </button>
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
          </div>
        </div>

        {/* Working-on pill — shows which heat is currently loaded.
            Kept from the old layout because staff valued the quick
            glance confirmation. */}
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
                  Tap a heat from the schedule below
                </span>
              )}
            </div>
          );
        })()}

        {/* Full-day schedule — every heat for the selected track today,
            sorted by time. Replaces the old ±3 called + ±3 upcoming
            pill strip + Earlier modal. Past heats dimmed, live heat
            pulses cyan, upcoming normal. Tap any row to load it. */}
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
          return (
            <div className="mb-3 rounded-lg border border-white/10 bg-white/[0.02]">
              <div className="flex items-center justify-between px-3 py-2 border-b border-white/5">
                <div className="text-xs text-white/50 uppercase tracking-wider">
                  {daySessions.length === 0 && !dayLoading
                    ? "No heats today"
                    : `${daySessions.length} heat${daySessions.length === 1 ? "" : "s"} · ${counts.past} done · ${counts.live} live · ${counts.upcoming} upcoming`}
                </div>
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
                {daySessions.map((s) => {
                  const isLoaded = activeSid === String(s.sessionId);
                  const statusIcon = s.status === "past" ? "✓" : s.status === "live" ? "●" : "○";
                  const statusColor = s.status === "past" ? "text-white/40" : s.status === "live" ? "text-[#00E2E5]" : "text-white/60";
                  return (
                    <button
                      key={`day-${s.sessionId}`}
                      type="button"
                      onClick={() => {
                        if (isLoaded) return;
                        setOverrideSessionId(String(s.sessionId));
                        void loadSession(String(s.sessionId));
                      }}
                      disabled={isLoaded}
                      className={`w-full flex items-center gap-2 px-3 py-2 text-left text-xs border-t border-white/[0.04] transition-colors ${
                        isLoaded
                          ? "bg-[#00E2E5]/15 cursor-default"
                          : s.status === "past"
                            ? "opacity-60 hover:bg-white/[0.03] hover:opacity-100"
                            : s.status === "live"
                              ? "bg-[#00E2E5]/5 hover:bg-[#00E2E5]/10 animate-pulse"
                              : "hover:bg-white/[0.04]"
                      }`}
                      title={isLoaded ? "Currently loaded" : `Load Heat ${s.heatNumber}`}
                    >
                      <span aria-hidden="true" className={`w-4 text-center shrink-0 ${statusColor}`}>
                        {statusIcon}
                      </span>
                      <span className="tabular-nums text-white/80 w-16 shrink-0">
                        {fmt(s.scheduledStart)}
                      </span>
                      <span className="text-white/50 w-14 shrink-0 uppercase tracking-wider">
                        Heat <span className="text-white font-semibold">{s.heatNumber}</span>
                      </span>
                      <span className="text-white/60 flex-1 truncate">
                        {s.type}
                      </span>
                      <span
                        className={`tabular-nums text-xs px-1.5 py-0.5 rounded shrink-0 ${
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
                })}
              </div>
            </div>
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
              onClick={() => { setOverrideSessionId(""); void loadSession(); }}
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
              // type="tel" pulls up the phone-style number pad on iOS
              // and a plain digits-only keyboard on Android (better than
              // type="number" which brings spinners + accepts decimals).
              type="tel"
              // Bulletproof Android-keyboard suppression: `readOnly` when
              // the Kb toggle is off. Android/iOS never open the virtual
              // keyboard for a readOnly field, even if inputMode hints
              // are ignored by the IME. USB NFC readers + Web NFC both
              // update the value programmatically so readOnly doesn't
              // block them. When staff flips the toggle ON for manual
              // entry, readOnly drops + inputMode='numeric' shows the
              // compact 0-9 pad.
              readOnly={!showKeyboard}
              inputMode={showKeyboard ? "numeric" : "none"}
              pattern="[0-9]*"
              enterKeyHint="enter"
              value={scanBuffer}
              onChange={(e) => setScanBuffer(e.target.value)}
              onKeyDown={onInputKey}
              placeholder={nfcActive ? "📡 Listening — tap an NFC tag…" : "Waiting for scan…"}
              autoComplete="off"
              className="flex-1 min-w-0 bg-white/5 border border-white/10 rounded px-2 py-2 text-base text-white font-mono placeholder:text-white/30"
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
          {track && loading && participants.length === 0 && (
            <div className="rounded-lg border border-white/10 bg-white/[0.02] text-center py-10">
              <div className="inline-flex items-center gap-2 text-[#00E2E5] text-sm">
                <span
                  aria-hidden="true"
                  className="inline-block w-4 h-4 rounded-full border-2 border-[#00E2E5]/30 border-t-[#00E2E5] animate-spin"
                />
                Loading roster…
              </div>
            </div>
          )}
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
                <div className="flex items-center gap-3">
                  <div className={`text-sm tabular-nums w-6 text-center shrink-0 ${
                    isBlocked ? "text-red-300" : isActive ? "text-[#00E2E5]" : hasCam ? "text-emerald-400" : "text-white/40"
                  }`}>
                    {i + 1}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className={`text-sm font-semibold truncate ${isBlocked ? "text-red-300" : ""}`}>
                      {p.firstName} {p.lastName}
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
                  {hasCam ? (
                    <div className="flex items-center gap-2 shrink-0">
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
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 shrink-0">
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
                    </div>
                  )}
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
