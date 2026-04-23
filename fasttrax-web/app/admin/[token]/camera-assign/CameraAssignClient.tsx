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

export default function CameraAssignClient({ token }: { token: string }) {
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
  }, [token]);

  /** Load list of today's past sessions for the test-data dropdown. */
  const loadPast = useCallback(async () => {
    try {
      const qs = new URLSearchParams({ token, mode: "past" });
      const res = await fetch(`/api/admin/camera-assign/session?${qs}`, { cache: "no-store" });
      if (!res.ok) return;
      const json = await res.json();
      setPastSessions(json.sessions || []);
      setPastLoaded(true);
    } catch { /* non-fatal */ }
  }, [token]);

  // Initial load
  useEffect(() => { loadSession(); }, [loadSession]);

  // Keep the input focused — NFC reader pumps characters here
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
        <header className="mb-3 sm:mb-5">
          <h1 className="text-xl sm:text-2xl font-bold uppercase tracking-wider">Camera Assignment</h1>
          <p className="text-white/50 text-xs sm:text-sm mt-0.5 hidden sm:block">
            Scan each kart&apos;s NFC tag to bind it to a racer. Assignments are saved; a Viewpoint-watcher can match incoming videos back to this roster.
          </p>
        </header>

        {/* Control bar — refresh + test-data picker */}
        <div className="flex flex-wrap items-end gap-3 mb-4">
          <button
            type="button"
            onClick={() => { setOverrideSessionId(""); void loadSession(); }}
            className="text-xs px-3 py-2 rounded bg-white/10 hover:bg-white/20 text-white border border-white/15"
          >
            ⟳ Load next upcoming
          </button>
          <div className="flex items-end gap-2">
            <label className="flex flex-col gap-1 text-xs text-white/60">
              Test with past session (today)
              <select
                value={overrideSessionId}
                onFocus={() => { if (!pastLoaded) void loadPast(); }}
                onChange={(e) => {
                  const v = e.target.value;
                  setOverrideSessionId(v);
                  if (v) void loadSession(v);
                }}
                className="bg-white/5 border border-white/10 rounded px-2 py-1.5 text-sm text-white min-w-[220px]"
              >
                <option value="" style={{ backgroundColor: "#0a1128" }}>
                  {pastLoaded ? "— pick a past session —" : "— click to load past sessions —"}
                </option>
                {pastSessions.map((s) => (
                  <option key={s.sessionId} value={s.sessionId} style={{ backgroundColor: "#0a1128" }}>
                    {formatEt(s.scheduledStart)} · {s.track} · Heat {s.heatNumber} · {s.type}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>

        {/* Session header */}
        {loading && <div className="text-white/50 text-sm py-4">Loading…</div>}
        {err && <div className="text-red-400 text-sm mb-3">Error: {err}</div>}
        {note && <div className="text-white/60 text-sm mb-3">{note}</div>}

        {session && (
          <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4 mb-4">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div>
                <div className="text-sm text-white/50">Session · Heat {session.heatNumber} · {session.type}</div>
                <div className="text-lg font-semibold">{session.track} · {formatEt(session.scheduledStart)}</div>
                <div className="text-xs text-white/40 mt-0.5">{session.name}</div>
              </div>
              <div className="text-right">
                <div className="text-3xl font-bold tabular-nums">
                  <span className={doneAll ? "text-emerald-400" : "text-[#00E2E5]"}>
                    {assignedCount}
                  </span>
                  <span className="text-white/30"> / {totalCount}</span>
                </div>
                <div className="text-xs uppercase tracking-wide text-white/50">
                  {doneAll ? "all cameras assigned" : "cameras assigned"}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Scan input — always focused, NFC writes here */}
        <div className="sticky top-2 z-10 rounded-xl border-2 border-[#00E2E5]/50 bg-[#00E2E5]/5 p-3 sm:p-4 mb-4">
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex-1 min-w-[200px]">
              <label className="text-xs text-white/60 block mb-1">
                Scan NFC tag (or type camera # and press Enter)
              </label>
              <input
                ref={inputRef}
                type="text"
                value={scanBuffer}
                onChange={(e) => setScanBuffer(e.target.value)}
                onKeyDown={onInputKey}
                placeholder="Waiting for scan…"
                autoFocus
                autoComplete="off"
                className="w-full bg-[#00E2E5]/10 border border-[#00E2E5]/40 rounded px-3 py-3 text-lg text-white font-mono placeholder:text-white/30"
              />
            </div>
            {lastScan && (
              <div className="text-right text-xs">
                <div className="text-emerald-400 font-semibold">
                  ✓ Camera <span className="font-mono">{lastScan.camera}</span> → {lastScan.racer}
                </div>
                <div className="text-white/40">Last scan {formatEt(new Date(lastScan.at).toISOString())}</div>
              </div>
            )}
          </div>
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
                className={`w-full text-left rounded-lg border p-3 sm:p-4 transition-colors ${
                  isActive
                    ? "border-[#00E2E5] bg-[#00E2E5]/10 ring-2 ring-[#00E2E5]/40"
                    : hasCam
                      ? "border-emerald-500/30 bg-emerald-500/5 hover:bg-emerald-500/10"
                      : "border-white/10 bg-white/[0.02] hover:bg-white/5"
                }`}
              >
                <div className="flex items-center gap-4">
                  {/* Order number */}
                  <div className={`text-2xl font-bold tabular-nums min-w-[2.5rem] ${isActive ? "text-[#00E2E5]" : "text-white/40"}`}>
                    {i + 1}
                  </div>
                  {/* Racer */}
                  <div className="flex-1">
                    <div className="text-lg font-semibold">
                      {p.firstName} {p.lastName}
                    </div>
                    <div className="text-xs text-white/40">personId {String(p.personId)}</div>
                  </div>
                  {/* Camera */}
                  <div className="text-right">
                    {hasCam ? (
                      <>
                        <div className="text-3xl font-bold font-mono text-emerald-400 tabular-nums">
                          {p.cameraNumber}
                        </div>
                        <div className="text-[10px] uppercase tracking-wide text-emerald-500/80">camera</div>
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); void unassign(i); }}
                          className="text-[10px] text-white/40 hover:text-red-400 mt-1"
                        >
                          un-assign
                        </button>
                      </>
                    ) : isActive ? (
                      <div className="text-[#00E2E5] uppercase text-xs font-semibold animate-pulse">
                        ← scan now
                      </div>
                    ) : (
                      <div className="text-white/30 text-xs">no camera yet</div>
                    )}
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
