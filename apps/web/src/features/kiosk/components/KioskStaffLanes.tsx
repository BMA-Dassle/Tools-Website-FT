"use client";

/**
 * /kiosk/staff — Lanes tab. Read-only bowling + duckpin occupancy, straight
 * from QAMF via the lane-plan grid (never Neon — Conqueror walk-ins, leagues
 * and maintenance blocks never reach our DB). Fort Myers kiosks show BOTH
 * houses (HeadPinz bowling + FastTrax duckpin — one physical complex); Naples
 * shows its one house as a separate labelled block, never mixed.
 *
 * Polls every 30s while the tab is visible (house rule: boards update every
 * 30s); a hidden window stops polling rather than hammering the vendor.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { staffFetch } from "./KioskStaff";
import type { StaffLane, StaffLaneBoard } from "../staff/lanes";

type Board = StaffLaneBoard | { centerId: number; label: string; error: string };

const POLL_MS = 30_000;

function fmtClock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function laneTone(l: StaffLane): string {
  if (l.state === "error") return "border-red-400/60 bg-red-400/15 text-red-200";
  if (l.state === "busy" && l.isBlock)
    return "border-purple-300/40 bg-purple-300/10 text-purple-200";
  if (l.state === "busy") return "border-amber-300/50 bg-amber-300/10 text-amber-100";
  if (l.state === "soon") return "border-sky-300/40 bg-sky-300/10 text-sky-100";
  return "border-[#46d68c]/40 bg-[#46d68c]/5 text-[#8fe6ba]";
}

function laneLine(l: StaffLane): string {
  if (l.state === "error") return "Lane error / maintenance";
  if (l.state === "busy") {
    const who = l.title || (l.isBlock ? l.kind || "Blocked" : "In use");
    const until = l.untilMs ? ` · frees ~${fmtClock(l.untilMs)}` : "";
    const ppl = l.players > 0 ? ` · ${l.players}p` : "";
    return `${who}${ppl}${until}`;
  }
  if (l.state === "soon") {
    const who = l.title || l.kind || "Booked";
    return `${who} · starts ${l.untilMs ? fmtClock(l.untilMs) : "soon"}`;
  }
  return "Free";
}

export function KioskStaffLanes({ pin, center }: { pin: string; center: string }) {
  const [boards, setBoards] = useState<Board[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [readAt, setReadAt] = useState<number | null>(null);
  const aliveRef = useRef(true);

  const load = useCallback(async () => {
    setLoading(true);
    const { ok, data } = await staffFetch(
      pin,
      `/api/kiosk/staff?action=lanes&center=${encodeURIComponent(center)}`,
    );
    if (!aliveRef.current) return;
    setLoading(false);
    if (!ok) {
      setError(typeof data?.error === "string" ? data.error : "Couldn't read the lanes.");
      return;
    }
    setError(null);
    setBoards(data.boards as Board[]);
    setReadAt(typeof data.atMs === "number" ? data.atMs : Date.now());
  }, [pin, center]);

  // Load on open; poll every 30s while visible; refresh on becoming visible.
  useEffect(() => {
    aliveRef.current = true;
    // Deferred past the synchronous effect body (react-hooks/set-state-in-effect).
    void (async () => {
      await Promise.resolve();
      if (aliveRef.current) await load();
    })();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, POLL_MS);
    const onVis = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      aliveRef.current = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [load]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-sm text-white/45">
          {readAt ? `Read ${fmtClock(readAt)} — updates every 30s` : "Reading the floor…"}
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="rounded-full border border-white/15 px-4 py-1.5 text-xs font-bold text-white/60 disabled:opacity-40"
        >
          {loading ? "Reading…" : "Refresh"}
        </button>
      </div>

      {error && (
        <div className="rounded-xl border border-red-400/40 bg-red-400/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      )}

      {boards?.map((b) => (
        <div key={b.centerId} className="rounded-2xl border border-white/10 bg-[#0d1a36] p-5">
          <div className="text-sm font-bold uppercase tracking-widest text-white/40">{b.label}</div>

          {"error" in b ? (
            <p className="mt-3 text-sm text-red-200">
              Couldn&apos;t read this house from QAMF — {b.error}
            </p>
          ) : (
            <>
              {/* Schedule-vs-floor disagreements: exactly what a floor lead
                  should see. Blocking = the schedule alone would miss real
                  occupancy on that lane. */}
              {b.gaps.filter((g) => g.severity === "blocking").length > 0 && (
                <div className="mt-3 space-y-1 rounded-xl border border-red-400/40 bg-red-400/10 px-4 py-3 text-sm text-red-100">
                  <div className="font-bold text-red-200">Floor disagrees with the schedule</div>
                  {b.gaps
                    .filter((g) => g.severity === "blocking")
                    .map((g, i) => (
                      <div key={i}>
                        Lane {g.lane}: {g.problem}
                      </div>
                    ))}
                </div>
              )}

              <div className="mt-3 grid grid-cols-2 gap-2">
                {b.lanes.map((l) => (
                  <div key={l.lane} className={`rounded-xl border px-3 py-2 ${laneTone(l)}`}>
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-lg font-extrabold">Lane {l.lane}</span>
                      <span className="text-[10px] font-bold uppercase tracking-widest opacity-70">
                        {l.state === "busy" && l.isBlock ? "block" : l.state}
                      </span>
                    </div>
                    <div className="truncate text-xs opacity-90">{laneLine(l)}</div>
                  </div>
                ))}
              </div>

              {b.gaps.filter((g) => g.severity === "info").length > 0 && (
                <div className="mt-3 space-y-0.5 text-xs text-white/35">
                  {b.gaps
                    .filter((g) => g.severity === "info")
                    .map((g, i) => (
                      <div key={i}>
                        Lane {g.lane}: {g.problem}
                      </div>
                    ))}
                </div>
              )}
            </>
          )}
        </div>
      ))}

      {!boards && !error && (
        <div className="rounded-2xl border border-white/10 bg-[#0d1a36] p-8 text-center text-white/40">
          Reading the lane grid…
        </div>
      )}
    </div>
  );
}
