"use client";

/**
 * The live half of the driver view: position, last lap, gap, race clock.
 *
 * THE BROWSER OPENS THIS SOCKET, NOT US. `wss://webserver22.sms-timing.com:10015`
 * with a `START {resourceId}@{clientKey}` handshake — the same one /leaderboards
 * and the signage screens use, already allow-listed in the CSP. Nothing
 * server-side may connect: a probe connection displaces the live subscribers and
 * takes the boards down mid-race (owner, 2026-09-05). The server side of this
 * feature answers flags and lap history instead.
 *
 * FINDING THE KART. A frame is a whole track's field, and each driver row
 * carries `K` — the kart number. So the kart number alone locates a driver, with
 * no binding and no sign-in, which is exactly the property the entry screen
 * relies on. When the server already knows which track the kart is on we open
 * one socket; when it does not, we open all three and close the two that do not
 * contain it. /leaderboards holds three at once as a matter of course, so three
 * briefly is a proven load — but a mounted screen per kart must not hold three
 * forever, hence the narrowing.
 *
 * THE FRAME (verified against a live heat):
 *   {}                                  no race on this track
 *   { N: "[HEAT] 66 - Mega Pro", S: 4, C: 0, D: [ … ] }
 *   D[i] = { P: position, N: name, K: kart, L: laps, B: best ms,
 *            T: last ms, A: average ms, G: "00.250" gap ahead }
 *   S: 1 running · 2 paused · >= 3 finished
 *
 * FAILS TO NOTHING. No socket, no race, a parse error — the hook reports
 * `connected: false` and the screen falls back to what the server knows. A
 * driver screen must never show a stale number as if it were live.
 */
import { useEffect, useRef, useState } from "react";
import type { KartNumber, TrackKey } from "./types";

const WS_URL = "wss://webserver22.sms-timing.com:10015/";

/** Track → resource id @ BMI client key. FastTrax rides the shared
 *  `headpinzftmyers` key — see signage/constants.ts on the namespace trap. */
const SERVER_KEYS: Record<TrackKey, string> = {
  blue: "11208654@headpinzftmyers",
  red: "11208660@headpinzftmyers",
  mega: "-1@headpinzftmyers",
};

export type HeatState = "idle" | "running" | "paused" | "finished";

export interface LiveKart {
  connected: boolean;
  /** True once this kart has been found in a frame. */
  onTrack: boolean;
  track: TrackKey | null;
  heatName: string;
  state: HeatState;
  /** Interpolated between frames, ms. */
  remainingMs: number;
  position: number | null;
  driverName: string | null;
  laps: number | null;
  lastLapMs: number | null;
  bestLapMs: number | null;
  averageLapMs: number | null;
  /** The venue's own string, e.g. "00.250". Empty for the leader. */
  gapAhead: string;
  /** Positive = places gained since we started watching. */
  deltaPosition: number;
}

const EMPTY: LiveKart = {
  connected: false,
  onTrack: false,
  track: null,
  heatName: "",
  state: "idle",
  remainingMs: 0,
  position: null,
  driverName: null,
  laps: null,
  lastLapMs: null,
  bestLapMs: null,
  averageLapMs: null,
  gapAhead: "",
  deltaPosition: 0,
};

interface DriverRow {
  P?: number;
  N?: string;
  K?: string | number;
  L?: number;
  B?: number;
  T?: number;
  A?: number;
  G?: string;
}

/** One frame, read for the one kart we care about. PURE, so the parsing rule is
 *  testable without a socket. */
export function readFrameForKart(
  raw: string,
  kart: KartNumber,
): { frame: Omit<LiveKart, "connected" | "track" | "deltaPosition">; found: boolean } | null {
  if (raw === "{}") return null;
  let data: { N?: string; S?: number; C?: number; D?: DriverRow[] };
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  const rows = Array.isArray(data.D) ? data.D : [];
  const mine = rows.find((d) => String(d.K ?? "").trim() === kart);
  const s = typeof data.S === "number" ? data.S : 0;
  const state: HeatState = s === 1 ? "running" : s === 2 ? "paused" : s >= 3 ? "finished" : "idle";
  return {
    found: mine !== undefined,
    frame: {
      onTrack: mine !== undefined,
      heatName: (data.N ?? "").replace("[HEAT]", "Heat").trim(),
      state,
      remainingMs: typeof data.C === "number" ? data.C : 0,
      position: typeof mine?.P === "number" ? mine.P : null,
      driverName: typeof mine?.N === "string" ? mine.N : null,
      laps: typeof mine?.L === "number" ? mine.L : null,
      lastLapMs: mine?.T ? mine.T : null,
      bestLapMs: mine?.B ? mine.B : null,
      averageLapMs: mine?.A ? mine.A : null,
      gapAhead: typeof mine?.G === "string" ? mine.G : "",
    },
  };
}

/** Reconnect after this long with no frame. The venue resends every second, so
 *  silence this long is death, not calm — same reasoning as the bridge. */
const STALE_MS = 45_000;
const RECONNECT_MS = 3_000;

export function useLiveKart(kart: KartNumber, knownTrack: TrackKey | null): LiveKart {
  const [live, setLive] = useState<LiveKart>(EMPTY);
  const remainingRef = useRef(0);
  const syncedAtRef = useRef(0);
  const firstPositionRef = useRef<number | null>(null);

  useEffect(() => {
    if (!kart) return;
    // One socket when we know the track; all three until we find the kart.
    const tracks: TrackKey[] = knownTrack ? [knownTrack] : ["blue", "red", "mega"];
    const sockets = new Map<TrackKey, WebSocket>();
    const timers: ReturnType<typeof setTimeout>[] = [];
    let closed = false;
    let located: TrackKey | null = knownTrack;

    function connect(track: TrackKey) {
      if (closed) return;
      let stale: ReturnType<typeof setTimeout>;
      const resetStale = () => {
        clearTimeout(stale);
        stale = setTimeout(() => sockets.get(track)?.close(), STALE_MS);
        timers.push(stale);
      };

      let ws: WebSocket;
      try {
        ws = new WebSocket(WS_URL);
      } catch {
        const retry = setTimeout(() => connect(track), RECONNECT_MS);
        timers.push(retry);
        return;
      }
      sockets.set(track, ws);

      ws.onopen = () => {
        ws.send(`START ${SERVER_KEYS[track]}`);
        resetStale();
        setLive((p) => ({ ...p, connected: true }));
      };

      ws.onmessage = (evt) => {
        resetStale();
        if (typeof evt.data !== "string") return;
        const read = readFrameForKart(evt.data, kart);
        if (!read) return;

        if (!read.found) {
          // Not on this track. If we are still hunting, leave the socket open —
          // the kart may roll out onto it later in the evening.
          if (located === track) {
            setLive((p) => ({ ...p, onTrack: false }));
          }
          return;
        }

        // Found it. Narrow to this track and drop the other two.
        if (located !== track) {
          located = track;
          for (const [t, s] of sockets) {
            if (t !== track) {
              try {
                s.close();
              } catch {
                /* already closing */
              }
              sockets.delete(t);
            }
          }
        }

        remainingRef.current = read.frame.remainingMs;
        syncedAtRef.current = Date.now();
        const pos = read.frame.position;
        if (pos !== null && firstPositionRef.current === null) firstPositionRef.current = pos;
        const delta =
          pos !== null && firstPositionRef.current !== null ? firstPositionRef.current - pos : 0;

        setLive({ ...read.frame, connected: true, track, deltaPosition: delta });
      };

      ws.onclose = () => {
        clearTimeout(stale);
        sockets.delete(track);
        if (closed) return;
        setLive((p) => ({ ...p, connected: sockets.size > 0 }));
        // Only the located track is worth chasing once we have one.
        if (located === null || located === track) {
          const retry = setTimeout(() => connect(track), RECONNECT_MS);
          timers.push(retry);
        }
      };
      ws.onerror = () => ws.close();
    }

    for (const t of tracks) connect(t);

    // Phones kill sockets on lock. Come back when the screen does.
    function onVisible() {
      if (document.visibilityState !== "visible" || closed) return;
      const want = located ? [located] : tracks;
      for (const t of want) {
        const s = sockets.get(t);
        if (!s || s.readyState === WebSocket.CLOSED || s.readyState === WebSocket.CLOSING) {
          connect(t);
        }
      }
    }
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      closed = true;
      document.removeEventListener("visibilitychange", onVisible);
      for (const t of timers) clearTimeout(t);
      for (const s of sockets.values()) {
        try {
          s.close();
        } catch {
          /* already closing */
        }
      }
    };
  }, [kart, knownTrack]);

  // Smooth the countdown between frames. The wire sends one every second or two.
  useEffect(() => {
    const id = setInterval(() => {
      if (remainingRef.current <= 0) return;
      setLive((p) => {
        if (p.state !== "running") return p;
        const elapsed = Date.now() - syncedAtRef.current;
        return { ...p, remainingMs: Math.max(0, remainingRef.current - elapsed) };
      });
    }, 250);
    return () => clearInterval(id);
  }, []);

  return live;
}
