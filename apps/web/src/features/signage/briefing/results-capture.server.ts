import "server-only";

/**
 * Grab the current standings for a track, server-side, in one round trip.
 *
 * WHY A SERVERLESS FUNCTION CAN DO THIS AT ALL: the SMS-Timing server pushes a
 * full frame the moment a client sends `START {resource}@{client}` — the same
 * handshake /leaderboards and live-session.tsx use from the browser. One
 * outbound wss connect, first frame, close: sub-second, no persistent process,
 * no bridge. Node 22+ ships a global WebSocket, so no dependency either.
 *
 * WHY IT WORKS AFTER THE CHEQUERED FLAG (verified live 2026-08-11): a finished
 * heat's frame keeps being served — S:4, C:0, full driver standings — until
 * staff load the NEXT heat. That after-window is what "grab the last best
 * times at the end of the race" (owner) rides. The rolling snapshot in
 * race-results.server.ts covers the case where the window slams shut early.
 *
 * FAILS TO NULL, always: no race, wrong shape, timeout, socket refused. A
 * capture problem must never take down the TV feed that triggered it.
 */
import { parseResultsFrame, type ResultsFrame } from "./results-frame";
import { parseRaceStateFrame, type RaceStateFrame } from "./race-state";
import type { TrackKey } from "../track";

/** Track → resource id @ BMI client key. Mirrors live-session.tsx SERVER_KEYS
 *  (FastTrax rides the shared headpinzftmyers key — CENTER NAMESPACE TRAP,
 *  see signage/constants.ts). */
const SERVER_KEYS: Record<TrackKey, string> = {
  blue: "11208654@headpinzftmyers",
  red: "11208660@headpinzftmyers",
  mega: "-1@headpinzftmyers",
};

const WS_URL = "wss://webserver22.sms-timing.com:10015/";

/** First frame or bust. 4s is generous — the live handshake answers in well
 *  under a second — while staying far inside any route timeout. */
const CAPTURE_TIMEOUT_MS = 4_000;

/**
 * The same one-frame handshake, read for the track's RUN STATE instead of its
 * standings.
 *
 * Separate from captureTrackResults because the two disagree about what an
 * empty answer means: a driverless frame is nothing to a results capture and a
 * perfectly good "no race loaded" to a state watcher. Sharing one parser would
 * force one of them to lie. The socket work is identical, so only the parse
 * differs — see race-state.ts.
 */
export function captureTrackState(track: TrackKey): Promise<RaceStateFrame | null> {
  return captureFrame(track, parseRaceStateFrame);
}

export function captureTrackResults(track: TrackKey): Promise<ResultsFrame | null> {
  return captureFrame(track, parseResultsFrame);
}

/** One connect, one frame, close. Fails to null on anything at all. */
function captureFrame<T>(track: TrackKey, parse: (raw: string) => T | null): Promise<T | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: T | null, ws?: WebSocket) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws?.close();
      } catch {
        /* already closing */
      }
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), CAPTURE_TIMEOUT_MS);

    try {
      const ws = new WebSocket(WS_URL);
      ws.onopen = () => {
        try {
          ws.send(`START ${SERVER_KEYS[track]}`);
        } catch {
          finish(null, ws);
        }
      };
      ws.onmessage = (evt) => {
        const raw = typeof evt.data === "string" ? evt.data : String(evt.data);
        finish(parse(raw), ws);
      };
      ws.onerror = () => finish(null, ws);
      ws.onclose = () => finish(null);
    } catch {
      finish(null);
    }
  });
}
