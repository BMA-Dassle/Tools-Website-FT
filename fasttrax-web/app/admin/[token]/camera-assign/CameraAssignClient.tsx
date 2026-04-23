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
};

type PastSession = {
  sessionId: string;
  name: string;
  scheduledStart: string;
  track: string;
  heatNumber: number;
  type: string;
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
 * Short, scannable label for a session shown on a quick-pick button:
 *   "Blue Starter 43", "Red Pro 44", "Mega Intermediate 12"
 * Strips "Track" from the resource name so the button stays narrow.
 */
function sessionChipLabel(s: { track?: string; type?: string; heatNumber?: number } | null | undefined): string {
  if (!s) return "—";
  const track = (s.track || "").replace(" Track", "").trim();
  const type = (s.type || "").trim();
  const heat = s.heatNumber != null ? String(s.heatNumber) : "";
  return [track, type, heat].filter(Boolean).join(" ");
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
  const [scanBuffer, setScanBuffer] = useState("");
  const [lastScan, setLastScan] = useState<{ camera: string; racer: string; at: number } | null>(null);
  // Bumps on every successful scan — drives the full-screen flash
  // overlay. We key a fresh <div> on this counter so the CSS
  // animation restarts from scratch each time.
  const [flashCounter, setFlashCounter] = useState(0);
  // Android keyboard is off by default (inputMode="none") so taps on the
  // scan input don't cover the roster. Staff can flip this on if they
  // need to hand-type a camera # and don't have a USB keyboard attached.
  const [showKeyboard, setShowKeyboard] = useState(false);

  const inputRef = useRef<HTMLInputElement | null>(null);
  // Mirror scanBuffer into a ref so the "skip while mid-scan" gates on
  // loadCalled / loadUpcoming / refreshSession don't cause those
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
  const loadCalled = useCallback(async () => {
    if (!track) { setCalledSessions([]); setCalledLoading(false); return; }
    if (scanBufferRef.current) return;
    setCalledLoading(true);
    try {
      const qs = new URLSearchParams({ token, track, limit: "4" });
      const res = await fetch(`/api/admin/camera-assign/called?${qs}`, { cache: "no-store" });
      if (!res.ok) return;
      const json = await res.json();
      setCalledSessions(json.sessions || []);
    } catch {
      /* non-fatal */
    } finally {
      setCalledLoading(false);
    }
  }, [token, track]);

  /** Load next 3 upcoming sessions (scheduledStart > now) from Pandora.
   *  Same scanBufferRef pattern as loadCalled — read via ref so typing
   *  doesn't flip this callback's identity and retrigger effects. */
  const loadUpcoming = useCallback(async () => {
    if (!track) { setUpcomingSessions([]); setUpcomingLoading(false); return; }
    if (scanBufferRef.current) return;
    setUpcomingLoading(true);
    try {
      const qs = new URLSearchParams({ token, track, limit: "3" });
      const res = await fetch(`/api/admin/camera-assign/upcoming?${qs}`, { cache: "no-store" });
      if (!res.ok) return;
      const json = await res.json();
      setUpcomingSessions(json.sessions || []);
    } catch {
      /* non-fatal */
    } finally {
      setUpcomingLoading(false);
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
    setSession(null);
    setParticipants([]);
    setNote(null);
    setActiveIndex(0);
    setLastScan(null);
    // Populate the live quick-pick feed + past dropdown for the new
    // track so they're always usable without a tap.
    void loadCalled();
    void loadUpcoming();
    void loadPast();
  }, [track, loadCalled, loadUpcoming, loadPast]);

  // In-place refresh every 30s for the current roster + the called-races
  // feed that powers the live quick-pick buttons. Preserves scan state;
  // merges new roster changes; auto-advances to the next session once
  // all cameras are assigned (see below).
  useEffect(() => {
    const id = setInterval(() => {
      void refreshSession();
      void loadCalled();
      void loadUpcoming();
    }, 30_000);
    return () => clearInterval(id);
  }, [refreshSession, loadCalled, loadUpcoming]);

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

  // Computed
  const assignedCount = useMemo(() => participants.filter((p) => p.systemNumber).length, [participants]);
  const totalCount = participants.length;
  const doneAll = totalCount > 0 && assignedCount === totalCount;

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
        <header className="mb-3 sm:mb-5">
          <h1 className="text-xl sm:text-2xl font-bold uppercase tracking-wider">Camera Assignment</h1>
          <p className="text-white/50 text-xs sm:text-sm mt-0.5 hidden sm:block">
            Scan each camera&apos;s NFC tag to bind it to a racer. Assignments are saved so videos can be matched back to racers.
          </p>
        </header>

        {/* Track chips — three small branded buttons. Tap an idle one
            to filter; tap the active one again to clear. Right side has
            the keyboard toggle (off by default so tapping the scan
            field doesn't pop Android's virtual keyboard on top of the
            roster). */}
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          {TRACK_CHIPS.map((t) => {
            const isActive = track === t.slug;
            return (
              <button
                key={t.slug}
                type="button"
                onClick={() => setTrack(isActive ? "" : t.slug)}
                className={`text-xs uppercase tracking-wider font-semibold px-3 py-1.5 rounded border transition-colors ${
                  isActive ? t.active : `bg-white/[0.02] ${t.idle}`
                }`}
              >
                {t.label}
              </button>
            );
          })}
          {track && (
            <span className="text-[10px] uppercase tracking-wider text-white/40">
              filtered
            </span>
          )}
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={() => setPastModalOpen(true)}
              disabled={!track || pastLoading || pastSessions.length === 0}
              title="Browse earlier sessions from today"
              className="text-xs uppercase tracking-wider font-semibold px-3 py-1.5 rounded border border-white/15 bg-white/[0.02] text-white/70 hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
            >
              {pastLoading ? (
                <>
                  <span
                    aria-hidden="true"
                    className="inline-block w-3 h-3 rounded-full border-2 border-white/20 border-t-white/70 animate-spin"
                  />
                  Loading…
                </>
              ) : (
                <>⏮ Earlier</>
              )}
            </button>
            <button
              type="button"
              onClick={() => setShowKeyboard((v) => !v)}
              title="Toggle the on-screen keyboard when tapping the scan field"
              className={`text-xs uppercase tracking-wider font-semibold px-3 py-1.5 rounded border transition-colors ${
                showKeyboard
                  ? "bg-white/15 border-white/30 text-white"
                  : "bg-white/[0.02] border-white/15 text-white/60 hover:bg-white/10"
              }`}
            >
              ⌨ Kb {showKeyboard ? "on" : "off"}
            </button>
          </div>
        </div>

        {/* Working-session pill — staff's locked selection. Never
            changes automatically; only tapping a context pill below
            sets this. Empty placeholder until first tap. */}
        {track && (
          <div className="flex items-center gap-2 mb-2 flex-wrap">
            <span className="text-[10px] uppercase tracking-wider text-white/40 font-semibold mr-1">
              Working on:
            </span>
            {session ? (
              <span
                className={`text-xs uppercase tracking-wider font-semibold px-3 py-1.5 rounded border ${trackChipClasses(session.track, true)}`}
              >
                {sessionChipLabel(session)}
              </span>
            ) : (
              <span className="text-xs uppercase tracking-wider font-semibold px-3 py-1.5 rounded border border-dashed border-white/25 text-white/40">
                tap a heat below →
              </span>
            )}
          </div>
        )}

        {/* Context row — up to 3 previous called, the current called,
            and up to 3 upcoming scheduled. Auto-updates every 30s
            except mid-scan. Tapping any pill loads that session as
            the working session. The 'currently called' pill is
            highlighted with a NOW badge so staff knows which one
            matches the call being made right now. */}
        {track && (
          <div className="flex items-center gap-2 mb-3 flex-wrap">
            {(calledLoading || upcomingLoading) && calledSessions.length === 0 && upcomingSessions.length === 0 && (
              <span className="inline-flex items-center gap-1.5 text-xs uppercase tracking-wider text-[#00E2E5]/80 font-semibold px-3 py-1.5 rounded border border-dashed border-[#00E2E5]/30">
                <span
                  aria-hidden="true"
                  className="inline-block w-3 h-3 rounded-full border-2 border-[#00E2E5]/30 border-t-[#00E2E5] animate-spin"
                />
                Loading heats…
              </span>
            )}

            {/* Previous called (skip index 0 — that's the currently-called
                pill, rendered separately). Render in reverse order so the
                oldest is left-most: -3 -2 -1. */}
            {calledSessions.slice(1, 4).reverse().map((p) => {
              const isLoaded = !!session && String(session.sessionId) === String(p.sessionId);
              return (
                <button
                  key={`prev-${p.sessionId}`}
                  type="button"
                  onClick={() => {
                    if (isLoaded) return;
                    setOverrideSessionId(String(p.sessionId));
                    void loadSession(String(p.sessionId));
                  }}
                  disabled={isLoaded}
                  className={`text-xs uppercase tracking-wider font-semibold px-3 py-1.5 rounded border transition-colors ${trackChipClasses(p.track, isLoaded)} ${isLoaded ? "cursor-default" : ""}`}
                  title={isLoaded ? "Currently loaded" : "Jump to this previously-called race"}
                >
                  {sessionChipLabel(p)}
                </button>
              );
            })}

            {/* Most-recent called race (calledSessions[0]) — same style
                as the other previous-called pills. The NOW badge +
                ring highlight have been removed; staff can tell which
                is which from the row position (left-most of the
                called group = most recent). */}
            {calledSessions[0] && (() => {
              const p = calledSessions[0];
              const isLoaded = !!session && String(session.sessionId) === String(p.sessionId);
              return (
                <button
                  key={`called0-${p.sessionId}`}
                  type="button"
                  onClick={() => {
                    if (isLoaded) return;
                    setOverrideSessionId(String(p.sessionId));
                    void loadSession(String(p.sessionId));
                  }}
                  disabled={isLoaded}
                  className={`text-xs uppercase tracking-wider font-semibold px-3 py-1.5 rounded border transition-colors ${trackChipClasses(p.track, isLoaded)} ${isLoaded ? "cursor-default" : ""}`}
                  title={isLoaded ? "Currently loaded" : "Jump to this race"}
                >
                  {sessionChipLabel(p)}
                </button>
              );
            })()}

            {/* Upcoming scheduled (scheduledStart > now). Ascending —
                +1 +2 +3 soonest-first so the reading order mirrors time. */}
            {upcomingSessions.slice(0, 3).map((p) => {
              const isLoaded = !!session && String(session.sessionId) === String(p.sessionId);
              return (
                <button
                  key={`up-${p.sessionId}`}
                  type="button"
                  onClick={() => {
                    if (isLoaded) return;
                    setOverrideSessionId(String(p.sessionId));
                    void loadSession(String(p.sessionId));
                  }}
                  disabled={isLoaded}
                  className={`text-xs uppercase tracking-wider font-semibold px-3 py-1.5 rounded border transition-colors opacity-80 ${trackChipClasses(p.track, isLoaded)} ${isLoaded ? "cursor-default opacity-100" : ""}`}
                  title={isLoaded ? "Currently loaded" : "Pre-assign cameras for this upcoming race"}
                >
                  {sessionChipLabel(p)}
                </button>
              );
            })}

            {!calledLoading && !upcomingLoading && calledSessions.length === 0 && upcomingSessions.length === 0 && (
              <span className="text-[10px] uppercase tracking-wider text-white/30 ml-1">
                no heats found for this track today
              </span>
            )}
          </div>
        )}

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
          <button
            type="button"
            onClick={() => { setOverrideSessionId(""); void loadSession(); }}
            className="text-[#00E2E5] hover:underline shrink-0"
          >
            Refresh
          </button>
        </div>

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
              // inputMode='none' suppresses the Android virtual keyboard
              // entirely when the toggle is off; the USB NFC reader (HID
              // keyboard) still types into the field. When staff flips
              // the toggle ON for manual entry we show 'numeric' — a
              // compact 0-9 pad matching what the camera IDs actually are.
              inputMode={showKeyboard ? "numeric" : "none"}
              pattern="[0-9]*"
              enterKeyHint="enter"
              value={scanBuffer}
              onChange={(e) => setScanBuffer(e.target.value)}
              onKeyDown={onInputKey}
              placeholder="Waiting for scan…"
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
            return (
              <button
                key={String(p.personId)}
                type="button"
                onClick={() => setActiveIndex(i)}
                style={isActive ? { boxShadow: "0 0 18px rgba(0,226,229,0.45)" } : undefined}
                className={`w-full text-left rounded-lg border p-3 transition-colors ${
                  isActive
                    ? "border-[#00E2E5]/60 bg-[#00E2E5]/10"
                    : hasCam
                      ? "border-emerald-500/25 bg-emerald-500/5"
                      : "border-white/10 bg-white/[0.02] hover:bg-white/[0.04]"
                }`}
              >
                <div className="flex items-center gap-3">
                  <div className={`text-sm tabular-nums w-6 text-center shrink-0 ${
                    isActive ? "text-[#00E2E5]" : hasCam ? "text-emerald-400" : "text-white/40"
                  }`}>
                    {i + 1}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold truncate">
                      {p.firstName} {p.lastName}
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
                        className="text-xs text-white/40 hover:text-red-400"
                      >
                        redo
                      </button>
                    </div>
                  ) : isActive ? (
                    <span className="text-xs uppercase px-1.5 py-0.5 rounded bg-[#00E2E5]/20 text-[#00E2E5] shrink-0">
                      scan next
                    </span>
                  ) : null}
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
    </div>
  );
}
