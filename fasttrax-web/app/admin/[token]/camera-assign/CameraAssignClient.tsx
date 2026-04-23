"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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
  const [overrideSessionId, setOverrideSessionId] = useState<string>("");
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

  /** Load the active session (next upcoming by default, or override if picked).
   *  Full reset — use this for initial load, track switch, and manual reload. */
  const loadSession = useCallback(async (sessionIdOverride?: string) => {
    setLoading(true);
    setErr(null);
    try {
      const qs = new URLSearchParams({ token });
      if (sessionIdOverride) qs.set("sessionId", sessionIdOverride);
      if (track) qs.set("track", track);
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
    // Don't refresh while staff is on a test session (overrideSessionId)
    // or actively scanning — would clobber in-progress work.
    if (overrideSessionId) return;
    if (scanBuffer) return;

    try {
      const qs = new URLSearchParams({ token });
      if (track) qs.set("track", track);
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
  }, [token, track, overrideSessionId, scanBuffer, session]);

  /** Load today's past sessions for the test-data dropdown. Scoped to
   *  today (days=1) — staff only testing on the day's earlier heats. */
  const loadPast = useCallback(async () => {
    try {
      const qs = new URLSearchParams({ token, mode: "past", days: "1" });
      if (track) qs.set("track", track);
      const res = await fetch(`/api/admin/camera-assign/session?${qs}`, { cache: "no-store" });
      if (!res.ok) return;
      const json = await res.json();
      setPastSessions(json.sessions || []);
      setPastLoaded(true);
    } catch { /* non-fatal */ }
  }, [token, track]);

  // Initial load — and re-runs whenever `track` changes so the three
  // track buttons can switch the roster. `loadSession` itself captures
  // `track` via its useCallback deps, so its identity flips when track
  // flips, and this effect re-fires.
  useEffect(() => {
    setOverrideSessionId("");   // clear any test-session override on track switch
    setPastLoaded(false);       // force past-sessions to reload for the new track
    setPastSessions([]);
    void loadSession();
    // Populate the past dropdown on load + on track change so it's
    // always usable, no need for staff to tap/focus it first.
    void loadPast();
  }, [loadSession, loadPast]);

  // In-place refresh every 30s. Preserves scan state; merges new roster
  // changes; auto-advances to the next session once all cameras are
  // assigned (see below for the auto-advance effect).
  useEffect(() => {
    const id = setInterval(() => { void refreshSession(); }, 30_000);
    return () => clearInterval(id);
  }, [refreshSession]);

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

  // Auto-advance: once the current session is fully assigned, wait ~5s
  // (so staff sees the "all set" banner) and then load the next upcoming
  // session. Skipped on test sessions and while the scan input has
  // uncommitted text (don't yank state mid-action).
  useEffect(() => {
    if (!doneAll) return;
    if (overrideSessionId) return;
    if (scanBuffer) return;
    const timer = setTimeout(() => {
      void loadSession();
      // Refresh past-sessions too — the session we just completed may
      // now be eligible for the test picker.
      void loadPast();
    }, 5_000);
    return () => clearTimeout(timer);
  }, [doneAll, overrideSessionId, scanBuffer, loadSession, loadPast]);

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
          <button
            type="button"
            onClick={() => setShowKeyboard((v) => !v)}
            title="Toggle the on-screen keyboard when tapping the scan field"
            className={`ml-auto text-xs uppercase tracking-wider font-semibold px-3 py-1.5 rounded border transition-colors ${
              showKeyboard
                ? "bg-white/15 border-white/30 text-white"
                : "bg-white/[0.02] border-white/15 text-white/60 hover:bg-white/10"
            }`}
          >
            ⌨ Keyboard {showKeyboard ? "on" : "off"}
          </button>
        </div>

        {/* Test-data picker — full-width row under the chips */}
        <div className="mb-4">
          <label className="flex flex-col gap-1 text-xs text-white/60">
            Test with earlier session today
            <select
              value={overrideSessionId}
              onChange={(e) => {
                const v = e.target.value;
                setOverrideSessionId(v);
                if (v) void loadSession(v);
                else void loadSession();  // back to live next-upcoming
              }}
              className="bg-white/5 border border-white/10 rounded px-2 py-1.5 text-sm text-white"
            >
              <option value="" style={{ backgroundColor: "#0a1128" }}>
                {pastLoaded && pastSessions.length === 0
                  ? "(no earlier sessions today)"
                  : "— live (next upcoming) —"}
              </option>
              {pastSessions.map((s) => (
                <option key={s.sessionId} value={s.sessionId} style={{ backgroundColor: "#0a1128" }}>
                  {formatEt(s.scheduledStart)} · {s.track.replace(" Track", "")} · H{s.heatNumber} · {s.type}
                </option>
              ))}
            </select>
          </label>
        </div>

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
            Scan NFC tag (or type camera # and press Enter)
          </label>
          <input
            id="camera-scan-input"
            ref={inputRef}
            type="text"
            // inputMode='none' suppresses the Android virtual keyboard
            // when focused; the USB NFC reader (HID keyboard) still
            // types into the field. Staff can flip the toggle above if
            // they need to hand-type a number.
            inputMode={showKeyboard ? "text" : "none"}
            value={scanBuffer}
            onChange={(e) => setScanBuffer(e.target.value)}
            onKeyDown={onInputKey}
            placeholder="Waiting for scan…"
            autoComplete="off"
            className="w-full bg-white/5 border border-white/10 rounded px-2 py-2 text-base text-white font-mono placeholder:text-white/30"
          />
          {lastScan && (
            <div className="mt-1 text-xs text-emerald-400 truncate">
              ✓ Camera <span className="font-mono">{lastScan.camera}</span> → {lastScan.racer}
            </div>
          )}
        </div>

        {/* Participants list — matches SMS admin card density */}
        <div className="space-y-2">
          {participants.length === 0 && !loading && (
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
    </div>
  );
}
