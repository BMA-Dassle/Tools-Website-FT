"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * Camera-assignment UI.
 *
 * Flow:
 *   1. On load, GET /api/admin/camera-assign/session → next upcoming
 *      session + its participants (with any pre-existing camera
 *      assignments merged in).
 *   2. Staff scans each kart's NFC tag with a USB NFC reader. The reader
 *      emulates a keyboard — it types the camera number + Enter into the
 *      always-focused input field. The onSubmit handler assigns that
 *      camera to the currently highlighted racer via POST /api/admin/
 *      camera-assign/assign, then auto-advances to the next unassigned
 *      racer.
 *   3. Each assignment writes a camera-watch:{cameraNumber} reverse
 *      lookup in Redis (12h TTL) so a downstream Viewpoint-watcher can
 *      route incoming videos back to the racer.
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
  cameraNumber?: string;
  assignedAt?: string;
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

const TRACK_BUTTONS: { slug: TrackSlug; label: string; tint: string; activeTint: string }[] = [
  { slug: "",     label: "All tracks", tint: "border-white/15 bg-white/5 hover:bg-white/10 text-white/80",
    activeTint: "border-white/40 bg-white/15 text-white ring-2 ring-white/30" },
  { slug: "blue", label: "Blue Track", tint: "border-blue-500/30 bg-blue-500/10 hover:bg-blue-500/20 text-blue-200",
    activeTint: "border-blue-400 bg-blue-500/25 text-white ring-2 ring-blue-400/50" },
  { slug: "red",  label: "Red Track",  tint: "border-red-500/30 bg-red-500/10 hover:bg-red-500/20 text-red-200",
    activeTint: "border-red-400 bg-red-500/25 text-white ring-2 ring-red-400/50" },
  { slug: "mega", label: "Mega Track", tint: "border-amber-500/30 bg-amber-500/10 hover:bg-amber-500/20 text-amber-200",
    activeTint: "border-amber-400 bg-amber-500/25 text-white ring-2 ring-amber-400/50" },
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

  const inputRef = useRef<HTMLInputElement | null>(null);

  /** Load the active session (next upcoming by default, or override if picked). */
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
      const firstUnassigned = (json.participants || []).findIndex((p) => !p.cameraNumber);
      setActiveIndex(firstUnassigned >= 0 ? firstUnassigned : 0);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "failed to load");
    } finally {
      setLoading(false);
    }
  }, [token, track]);

  /** Load list of today's past sessions for the test-data dropdown. */
  const loadPast = useCallback(async () => {
    try {
      const qs = new URLSearchParams({ token, mode: "past", days: "7" });
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
  }, [loadSession]);

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

  /** Submit one camera number for the currently highlighted racer. */
  const assign = useCallback(async (cameraNumber: string) => {
    const cam = cameraNumber.trim();
    if (!cam) return;
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
          cameraNumber: cam,
          sessionName: session?.name,
          scheduledStart: session?.scheduledStart,
          track: session?.track,
          raceType: session?.type,
          heatNumber: session?.heatNumber,
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
            ? { ...x, cameraNumber: cam, assignedAt: new Date().toISOString() }
            : x,
        ),
      );
      setLastScan({ camera: cam, racer: `${p.firstName} ${p.lastName}`, at: Date.now() });
      // Advance to next un-assigned racer; if none, stay put
      setActiveIndex((current) => {
        const next = participants.findIndex((x, i) => i > current && !x.cameraNumber);
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
    if (!confirm(`Un-assign camera ${p.cameraNumber} from ${p.firstName} ${p.lastName}?`)) return;
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
        prev.map((x, i) => (i === idx ? { ...x, cameraNumber: undefined, assignedAt: undefined } : x)),
      );
      setActiveIndex(idx);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "un-assign failed");
    }
  }, [participants, session, token]);

  // Computed
  const assignedCount = useMemo(() => participants.filter((p) => p.cameraNumber).length, [participants]);
  const totalCount = participants.length;
  const doneAll = totalCount > 0 && assignedCount === totalCount;

  return (
    <div className="min-h-screen bg-[#0a1128] text-white">
      <div className="max-w-5xl mx-auto p-3 sm:p-6">
        <header className="mb-3">
          <h1 className="text-lg sm:text-2xl font-bold uppercase tracking-wider">Camera Assignment</h1>
        </header>

        {/* Track buttons — 2×2 grid on mobile, 1×4 on desktop. Each has
            a min-height of ~56px so gloved/oily finger taps don't miss. */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
          {TRACK_BUTTONS.map((b) => {
            const active = track === b.slug;
            return (
              <button
                key={b.slug || "all"}
                type="button"
                onClick={() => setTrack(b.slug)}
                className={`min-h-[56px] px-3 py-3 rounded-lg border-2 font-semibold uppercase tracking-wide text-sm sm:text-base transition-colors ${
                  active ? b.activeTint : b.tint
                }`}
              >
                {b.label}
              </button>
            );
          })}
        </div>

        {/* Reload + test-data picker — stacked on mobile, inline on desktop */}
        <div className="flex flex-col sm:flex-row sm:items-end gap-2 mb-3">
          <button
            type="button"
            onClick={() => { setOverrideSessionId(""); void loadSession(); }}
            className="min-h-[44px] text-sm px-4 py-2 rounded-lg bg-white/10 active:bg-white/20 text-white border border-white/15"
          >
            ⟳ Reload
          </button>
          <label className="flex-1 flex flex-col gap-1 text-xs text-white/60">
            Test with past session (last 7 days)
            <select
              value={overrideSessionId}
              onFocus={() => { if (!pastLoaded) void loadPast(); }}
              onChange={(e) => {
                const v = e.target.value;
                setOverrideSessionId(v);
                if (v) void loadSession(v);
              }}
              className="min-h-[44px] bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white"
            >
              <option value="" style={{ backgroundColor: "#0a1128" }}>
                {pastLoaded
                  ? pastSessions.length === 0 ? "— no past sessions found —" : "— pick a past session —"
                  : "— tap to load past sessions —"}
              </option>
              {pastSessions.map((s) => (
                <option key={s.sessionId} value={s.sessionId} style={{ backgroundColor: "#0a1128" }}>
                  {formatEt(s.scheduledStart)} · {s.track.replace(" Track", "")} · H{s.heatNumber} · {s.type}
                </option>
              ))}
            </select>
          </label>
        </div>

        {/* Session header — compact on mobile, big counter always visible */}
        {loading && <div className="text-white/50 text-sm py-2">Loading…</div>}
        {err && <div className="text-red-400 text-sm mb-2">Error: {err}</div>}
        {note && !session && <div className="text-white/60 text-sm mb-2">{note}</div>}

        {session && (
          <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3 sm:p-4 mb-3">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="text-[10px] sm:text-xs uppercase tracking-wide text-white/50">Heat {session.heatNumber} · {session.type}</div>
                <div className="text-base sm:text-lg font-semibold truncate">{session.track.replace(" Track", "")} · {formatEt(session.scheduledStart)}</div>
              </div>
              <div className="text-right shrink-0">
                <div className="text-2xl sm:text-3xl font-bold tabular-nums leading-none">
                  <span className={doneAll ? "text-emerald-400" : "text-[#00E2E5]"}>
                    {assignedCount}
                  </span>
                  <span className="text-white/30"> / {totalCount}</span>
                </div>
                <div className="text-[10px] uppercase tracking-wide text-white/50 mt-0.5">
                  assigned
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Scan input — always focused, NFC writes here. inputMode="none"
            tells Android NOT to pop the virtual keyboard when the input
            is focused — the hardware-emulated NFC reader can still type
            into it, but tapping the field won't hide the roster behind
            a keyboard. */}
        <div className="sticky top-1 z-10 rounded-xl border-2 border-[#00E2E5]/60 bg-[#00E2E5]/10 p-3 mb-3 shadow-lg shadow-[#00E2E5]/10">
          <label htmlFor="camera-scan-input" className="text-[11px] uppercase tracking-wide text-white/70 block mb-1 font-semibold">
            Scan NFC tag
          </label>
          <input
            id="camera-scan-input"
            ref={inputRef}
            type="text"
            inputMode="none"
            value={scanBuffer}
            onChange={(e) => setScanBuffer(e.target.value)}
            onKeyDown={onInputKey}
            placeholder="Waiting for scan…"
            autoComplete="off"
            className="w-full bg-[#00E2E5]/10 border-2 border-[#00E2E5]/50 rounded-lg px-3 py-3 text-xl sm:text-2xl text-white font-mono placeholder:text-white/30 tabular-nums tracking-wider"
          />
          {lastScan && (
            <div className="mt-2 text-sm text-emerald-300 font-semibold truncate">
              ✓ <span className="font-mono">{lastScan.camera}</span> → {lastScan.racer}
            </div>
          )}
        </div>

        {/* Participants list */}
        <div className="space-y-2">
          {participants.length === 0 && !loading && (
            <div className="rounded-lg border border-white/10 bg-white/[0.02] text-center text-white/40 py-10">
              No participants for this session.
            </div>
          )}
          {participants.map((p, i) => {
            const isActive = i === activeIndex;
            const hasCam = !!p.cameraNumber;
            return (
              <button
                key={String(p.personId)}
                type="button"
                onClick={() => setActiveIndex(i)}
                className={`w-full text-left rounded-lg border-2 p-3 min-h-[72px] transition-colors ${
                  isActive
                    ? "border-[#00E2E5] bg-[#00E2E5]/15 ring-2 ring-[#00E2E5]/40"
                    : hasCam
                      ? "border-emerald-500/40 bg-emerald-500/10 active:bg-emerald-500/15"
                      : "border-white/15 bg-white/[0.03] active:bg-white/10"
                }`}
              >
                <div className="flex items-center gap-3">
                  {/* Order number */}
                  <div className={`text-xl sm:text-2xl font-bold tabular-nums min-w-[2rem] text-center ${isActive ? "text-[#00E2E5]" : hasCam ? "text-emerald-300" : "text-white/40"}`}>
                    {i + 1}
                  </div>
                  {/* Racer */}
                  <div className="flex-1 min-w-0">
                    <div className="text-base sm:text-lg font-semibold truncate">
                      {p.firstName} {p.lastName}
                    </div>
                    {isActive && !hasCam && (
                      <div className="text-[#00E2E5] text-xs font-semibold animate-pulse uppercase tracking-wide">
                        ← scan now
                      </div>
                    )}
                  </div>
                  {/* Camera */}
                  <div className="text-right shrink-0">
                    {hasCam ? (
                      <>
                        <div className="text-2xl sm:text-3xl font-bold font-mono text-emerald-400 tabular-nums leading-none">
                          {p.cameraNumber}
                        </div>
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); void unassign(i); }}
                          className="text-xs text-white/50 active:text-red-400 mt-1 px-2 py-1 min-h-[32px]"
                        >
                          ✕ redo
                        </button>
                      </>
                    ) : !isActive ? (
                      <div className="text-white/30 text-xs">—</div>
                    ) : null}
                  </div>
                </div>
              </button>
            );
          })}
        </div>

        {doneAll && (
          <div className="mt-4 rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-4 text-center">
            <div className="text-emerald-300 font-bold text-lg">All cameras assigned ✓</div>
            <div className="text-emerald-400/70 text-sm mt-1">
              {assignedCount} camera{assignedCount === 1 ? "" : "s"} registered. Viewpoint-watcher will link incoming videos automatically.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
