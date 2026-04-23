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

/**
 * FastTrax brand palette:
 *   brand red      #E53935
 *   cyan accent    #00E2E5
 *   violet (mega)  #8652FF
 *   card bg        #071027
 *   deep bg        #000418
 */
type TrackButton = {
  slug: TrackSlug;
  label: string;
  /** Active state background + shadow */
  accent: string;
  /** Idle border / text tint */
  idle: string;
  /** Active box-shadow (glow) */
  glow: string;
};

const TRACK_BUTTONS: TrackButton[] = [
  {
    slug: "",
    label: "All",
    accent: "bg-white text-[#000418]",
    idle: "border-white/25 text-white/80",
    glow: "0 0 24px rgba(255,255,255,0.35)",
  },
  {
    slug: "blue",
    label: "Blue",
    accent: "bg-[#00E2E5] text-[#000418]",
    idle: "border-[#00E2E5]/35 text-[#00E2E5]",
    glow: "0 0 26px rgba(0,226,229,0.55)",
  },
  {
    slug: "red",
    label: "Red",
    accent: "bg-[#E53935] text-white",
    idle: "border-[#E53935]/45 text-[#ff7171]",
    glow: "0 0 26px rgba(229,57,53,0.60)",
  },
  {
    slug: "mega",
    label: "Mega",
    accent: "bg-[#8652FF] text-white",
    idle: "border-[#8652FF]/45 text-[#c4adff]",
    glow: "0 0 26px rgba(134,82,255,0.55)",
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
    <div className="min-h-screen bg-[#000418] text-white font-body">
      <div className="max-w-5xl mx-auto px-3 sm:px-6 pt-3 pb-10">
        {/* Brand header — racing banner style, red glow on the word CAMERA */}
        <header className="mb-4 sm:mb-5 relative">
          <div className="flex items-baseline gap-2 flex-wrap">
            <h1
              className="font-display text-3xl sm:text-5xl leading-none"
              style={{ textShadow: "0 0 30px rgba(229,57,53,0.55)" }}
            >
              <span style={{ color: "#E53935" }}>CAMERA</span>
              <span className="text-white"> ASSIGN</span>
            </h1>
          </div>
          {/* brand gradient stripe */}
          <div className="mt-3 h-[3px] rounded-full bg-gradient-to-r from-[#E53935] via-white/60 to-[#00E2E5]" />
        </header>

        {/* Track pill buttons — 4-across on mobile too (one row), hefty
            tap targets, filled+glowing when active */}
        <div className="grid grid-cols-4 gap-2 mb-4">
          {TRACK_BUTTONS.map((b) => {
            const active = track === b.slug;
            return (
              <button
                key={b.slug || "all"}
                type="button"
                onClick={() => setTrack(b.slug)}
                style={active ? { boxShadow: b.glow } : undefined}
                className={`
                  min-h-[56px] px-2 py-3 rounded-full border-2
                  font-heading font-black uppercase tracking-widest
                  text-sm sm:text-base transition-all duration-150
                  ${active
                    ? `${b.accent} border-transparent scale-[1.02]`
                    : `bg-[#071027] ${b.idle} active:scale-[0.98]`}
                `}
              >
                {b.label}
              </button>
            );
          })}
        </div>

        {/* Reload + test-data picker */}
        <div className="flex flex-col sm:flex-row sm:items-end gap-2 mb-4">
          <button
            type="button"
            onClick={() => { setOverrideSessionId(""); void loadSession(); }}
            className="min-h-[44px] text-sm font-heading font-bold uppercase tracking-wider px-5 py-2.5 rounded-full bg-[#071027] active:bg-[#0c1a3a] text-white/90 border-2 border-white/15"
          >
            ⟳ Reload
          </button>
          <label className="flex-1 flex flex-col gap-1 text-[10px] uppercase tracking-widest text-white/50 font-heading font-bold">
            Test · past session (last 7d)
            <select
              value={overrideSessionId}
              onFocus={() => { if (!pastLoaded) void loadPast(); }}
              onChange={(e) => {
                const v = e.target.value;
                setOverrideSessionId(v);
                if (v) void loadSession(v);
              }}
              className="min-h-[44px] bg-[#071027] border-2 border-white/10 rounded-full px-4 py-2 text-sm text-white font-body"
            >
              <option value="" style={{ backgroundColor: "#071027" }}>
                {pastLoaded
                  ? pastSessions.length === 0 ? "— no past sessions found —" : "— pick a past session —"
                  : "— tap to load past sessions —"}
              </option>
              {pastSessions.map((s) => (
                <option key={s.sessionId} value={s.sessionId} style={{ backgroundColor: "#071027" }}>
                  {formatEt(s.scheduledStart)} · {s.track.replace(" Track", "")} · H{s.heatNumber} · {s.type}
                </option>
              ))}
            </select>
          </label>
        </div>

        {/* Status banners */}
        {loading && (
          <div className="text-[#00E2E5] text-sm font-heading uppercase tracking-widest py-2 animate-pulse">
            Loading…
          </div>
        )}
        {err && (
          <div className="rounded-xl border-2 border-[#E53935] bg-[#E53935]/10 px-4 py-3 mb-3 text-sm">
            <span className="font-heading font-black uppercase tracking-wider text-[#ff7171]">Error </span>
            <span className="text-white/90">{err}</span>
          </div>
        )}
        {note && !session && (
          <div className="rounded-xl border-2 border-white/10 bg-[#071027] px-4 py-8 mb-3 text-center">
            <div className="font-heading font-black uppercase tracking-widest text-white/40 text-sm">{note}</div>
          </div>
        )}

        {/* Session header card — heat/track on left, big counter on right */}
        {session && (
          <div
            className="relative rounded-2xl border-2 p-4 sm:p-5 mb-4 overflow-hidden"
            style={{
              borderColor: "rgba(0,226,229,0.35)",
              background: "linear-gradient(135deg, rgba(0,226,229,0.10), rgba(0,226,229,0.02))",
            }}
          >
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="text-[10px] sm:text-xs uppercase tracking-[0.2em] text-white/50 font-heading font-bold">
                  Heat {session.heatNumber} · {session.type}
                </div>
                <div className="font-display text-2xl sm:text-4xl leading-none mt-1 truncate">
                  <span style={{ color: "#00E2E5" }}>{session.track.replace(" Track", "")}</span>
                  <span className="text-white/30 mx-2">·</span>
                  <span className="text-white tabular-nums">{formatEt(session.scheduledStart)}</span>
                </div>
              </div>
              <div className="text-right shrink-0">
                <div className="font-display text-4xl sm:text-5xl leading-none tabular-nums">
                  <span
                    style={{
                      color: doneAll ? "#34d399" : "#00E2E5",
                      textShadow: doneAll
                        ? "0 0 24px rgba(52,211,153,0.55)"
                        : "0 0 24px rgba(0,226,229,0.55)",
                    }}
                  >
                    {assignedCount}
                  </span>
                  <span className="text-white/25">/{totalCount}</span>
                </div>
                <div className="text-[10px] uppercase tracking-[0.2em] text-white/50 mt-1 font-heading font-bold">
                  Assigned
                </div>
              </div>
            </div>
            {/* bottom accent stripe */}
            <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-gradient-to-r from-[#E53935] via-white/40 to-[#00E2E5]" />
          </div>
        )}

        {/* Sticky scan input — THE focal point. Big cyan racing slab,
            pulsing glow when waiting. inputMode=none keeps Android's
            virtual keyboard closed; USB NFC reader still types into it. */}
        <div
          className="sticky top-1 z-10 rounded-2xl border-2 p-3 sm:p-4 mb-4 backdrop-blur"
          style={{
            borderColor: "rgba(0,226,229,0.55)",
            background: "linear-gradient(135deg, rgba(0,226,229,0.18), rgba(0,226,229,0.04))",
            boxShadow: scanBuffer
              ? "0 0 36px rgba(0,226,229,0.45)"
              : "0 0 22px rgba(0,226,229,0.25)",
          }}
        >
          <label
            htmlFor="camera-scan-input"
            className="text-[11px] sm:text-xs uppercase tracking-[0.25em] block mb-1.5 font-heading font-black"
            style={{ color: "#00E2E5" }}
          >
            ▸ Scan NFC Tag
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
            className="w-full bg-[#000418]/70 border-2 border-[#00E2E5]/50 rounded-xl px-4 py-3 text-2xl sm:text-3xl text-white font-mono placeholder:text-white/25 tabular-nums tracking-[0.15em] focus:outline-none focus:border-[#00E2E5]"
          />
          {lastScan && (
            <div className="mt-2.5 flex items-center gap-2 text-sm truncate">
              <span className="font-heading font-black uppercase tracking-widest text-emerald-400 shrink-0">✓ Assigned</span>
              <span className="font-mono text-emerald-300 tabular-nums">#{lastScan.camera}</span>
              <span className="text-white/30 shrink-0">→</span>
              <span className="text-white truncate font-semibold">{lastScan.racer}</span>
            </div>
          )}
        </div>

        {/* Participants list — each row is a racing-themed grid slot */}
        <div className="space-y-2.5">
          {participants.length === 0 && !loading && (
            <div className="rounded-2xl border-2 border-white/10 bg-[#071027] text-center py-12">
              <div className="font-heading font-black uppercase tracking-widest text-white/40 text-sm">
                No participants
              </div>
            </div>
          )}
          {participants.map((p, i) => {
            const isActive = i === activeIndex;
            const hasCam = !!p.cameraNumber;

            // Border + glow react to row state
            const borderColor = isActive
              ? "rgba(0,226,229,0.85)"
              : hasCam
                ? "rgba(52,211,153,0.45)"
                : "rgba(255,255,255,0.10)";
            const boxShadow = isActive
              ? "0 0 28px rgba(0,226,229,0.45), inset 0 0 1px rgba(0,226,229,0.6)"
              : hasCam
                ? "0 0 14px rgba(52,211,153,0.12)"
                : "none";

            return (
              <button
                key={String(p.personId)}
                type="button"
                onClick={() => setActiveIndex(i)}
                style={{ borderColor, boxShadow }}
                className={`w-full text-left rounded-2xl border-2 p-3 sm:p-4 min-h-[88px] transition-all duration-150 relative overflow-hidden ${
                  isActive
                    ? "bg-gradient-to-br from-[#00E2E5]/12 to-[#00E2E5]/[0.02]"
                    : hasCam
                      ? "bg-gradient-to-br from-emerald-500/10 to-emerald-500/[0.02] active:from-emerald-500/15"
                      : "bg-[#071027] active:bg-[#0a1530]"
                }`}
              >
                <div className="flex items-center gap-3 sm:gap-4">
                  {/* Grid-slot number */}
                  <div className="shrink-0">
                    <div
                      className={`font-display text-3xl sm:text-4xl tabular-nums leading-none ${
                        isActive
                          ? "text-[#00E2E5]"
                          : hasCam
                            ? "text-emerald-400"
                            : "text-white/25"
                      }`}
                      style={isActive ? { textShadow: "0 0 16px rgba(0,226,229,0.6)" } : undefined}
                    >
                      {String(i + 1).padStart(2, "0")}
                    </div>
                  </div>

                  {/* Racer block */}
                  <div className="flex-1 min-w-0">
                    <div className="font-display text-lg sm:text-2xl leading-none truncate">
                      {p.firstName.toUpperCase()} {p.lastName.toUpperCase()}
                    </div>
                    {isActive && !hasCam && (
                      <div
                        className="text-[11px] font-heading font-black uppercase tracking-[0.25em] mt-1 animate-pulse"
                        style={{ color: "#00E2E5" }}
                      >
                        ▸ Scan now
                      </div>
                    )}
                    {hasCam && !isActive && (
                      <div className="text-[10px] uppercase tracking-[0.2em] text-emerald-400/70 font-heading font-bold mt-1">
                        Locked in
                      </div>
                    )}
                  </div>

                  {/* Camera slot — the money shot */}
                  <div className="text-right shrink-0">
                    {hasCam ? (
                      <>
                        <div className="text-[9px] uppercase tracking-[0.25em] text-emerald-500/80 font-heading font-black mb-0.5">
                          Camera
                        </div>
                        <div
                          className="font-display text-3xl sm:text-4xl font-black font-mono tabular-nums leading-none"
                          style={{
                            color: "#34d399",
                            textShadow: "0 0 18px rgba(52,211,153,0.5)",
                          }}
                        >
                          {p.cameraNumber}
                        </div>
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); void unassign(i); }}
                          className="mt-1.5 text-[10px] uppercase tracking-widest font-heading font-bold text-white/40 active:text-[#ff7171] px-2 py-1 min-h-[28px] rounded-full border border-white/10"
                        >
                          ✕ redo
                        </button>
                      </>
                    ) : isActive ? (
                      <div className="text-[10px] uppercase tracking-[0.25em] text-white/20 font-heading font-bold">
                        Awaiting<br/>camera
                      </div>
                    ) : (
                      <div className="text-xl sm:text-2xl text-white/15 font-mono">—</div>
                    )}
                  </div>
                </div>

                {/* Active-row bottom stripe */}
                {isActive && (
                  <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-gradient-to-r from-[#E53935] via-white/40 to-[#00E2E5]" />
                )}
              </button>
            );
          })}
        </div>

        {doneAll && (
          <div
            className="mt-5 relative rounded-2xl border-2 p-5 text-center overflow-hidden"
            style={{
              borderColor: "rgba(52,211,153,0.55)",
              background: "linear-gradient(135deg, rgba(52,211,153,0.15), rgba(52,211,153,0.02))",
            }}
          >
            <div
              className="font-display text-3xl sm:text-4xl text-emerald-300"
              style={{ textShadow: "0 0 28px rgba(52,211,153,0.55)" }}
            >
              ALL SET — GREEN FLAG
            </div>
            <div className="text-emerald-400/70 text-sm font-heading font-bold uppercase tracking-widest mt-2">
              {assignedCount} camera{assignedCount === 1 ? "" : "s"} registered · videos will attach automatically
            </div>
            <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-gradient-to-r from-[#E53935] via-white/40 to-[#00E2E5]" />
          </div>
        )}

      </div>
    </div>
  );
}
