import "server-only";

import { STAY_SEATED_CLIP_FILE } from "./pit-board";

/**
 * Pandora's Q-SYS proxy — how the pit station actually plays a cue and reads
 * the player's live state (docs/qsys-audio-websocket.md is the wire doc the
 * owner supplied 2026-08-14; POST /qsys/audio/play & friends are in Pandora's
 * /api-docs).
 *
 * WHY PANDORA AND NOT THE CORE: the Core's HTTP API and WebSocket live on
 * port 8001 of a LAN address with no auth — reachable from a venue box, not
 * from Vercel. Pandora holds the WebSocket itself (reconnect-forever) and
 * re-serves the cached state over authenticated HTTPS, so
 * GET /qsys/audio/live answers instantly without touching the Core — poll it
 * as often as needed. It also proxies /play with validation and resolves the
 * Core's address from the Square location's qsysAddress attribute.
 *
 * THE VOCABULARY MATCHES OURS EXACTLY, by design: zones are `red` / `blue` /
 * `mega` (our TrackKey), clips are `pre` / `post` / `big` (our cues — `big`
 * is the pre-race with the extra big-race warnings, configured on the Core
 * since 2026-08-15; audio.server.ts owns the 8+ grid rule that picks it).
 * `post-red` / `post-blue` are the post-race with the RETURNING ROOM named
 * (owner 2026-08-16: on a Mega night two rooms serve one circuit, so the
 * generic post cannot say where to walk) — audio.server.ts picks by the
 * returning group's briefed room and falls back to the generic `post` until
 * the files exist. They play BY FILE like the stay-seated loop (owner: an
 * upload beats Core clip config) — see POST_ROOM_FILES for the exact names.
 * /play takes exactly one of clip | file. Zones run independently —
 * playing one never cancels another.
 *
 * Bearer auth with SWAGGER_ADMIN_KEY, same as every other Pandora call in
 * this repo (e.g. /api/tv/pit-photo).
 */
import type { TrackKey } from "../track";

const PANDORA_BASE = "https://bma-pandora-api.azurewebsites.net/v2";
const PANDORA_KEY = process.env.SWAGGER_ADMIN_KEY || "";

/** FastTrax's Square location id — the key Pandora resolves qsysAddress from.
 *  The same constant the rest of the repo uses for FT's Square ledger. */
const FT_SQUARE_LOCATION_ID = "LAB52GY480CJF";

export type QsysClip = "pre" | "post" | "post-red" | "post-blue" | "big" | "stay-seated";

/**
 * The ambient "karts are rolling in — stay in your kart" loop, played by file
 * like the big-race pre (no configured clip on the Core). ONE file for every
 * zone — the zone param does the routing. audio.server.ts owns when it loops
 * and the rule that a real pre/post stops it instantly.
 */
// One definition, shared with the pit station — see pit-board.ts. The client
// must draw the same "the loop yields to a real cue" rule the server enforces,
// and this module is server-only, so the constant cannot live here.
export const STAY_SEATED_FILE = STAY_SEATED_CLIP_FILE;

/**
 * Pandora's WebSocket RELAY of the Core's push feed — same frames, verbatim,
 * over wss with NO auth (read-only telemetry, per the wire doc). This is the
 * pit tablet's default feed: an https page can hold it with no mixed-content
 * exception and no LAN access, unlike the Core's own ws:// listener. Pandora
 * adds a synthetic hello ({source:"pandora", upstreamConnected}) plus
 * {type:"upstream", connected} frames when its own link to the Core drops
 * and returns.
 */
export const PANDORA_QSYS_SOCKET_URL = `${PANDORA_BASE.replace(/^https/, "wss")}/qsys/audio/ws/${FT_SQUARE_LOCATION_ID}`;

/** The live timing block, exactly as the Core pushes it. Numeric fields are
 *  optional ("when known"); the *Text fields are display strings. Drive
 *  logic off the numbers and `playing`, never off the strings (wire doc). */
export interface QsysZoneTiming {
  source: "player" | "estimated" | "none" | string;
  remaining?: number;
  remainingText: string;
  elapsed?: number;
  elapsedText: string;
  duration?: number;
  durationText: string;
  progress?: number;
}

export interface QsysZoneState {
  zone: string;
  label: string;
  /** An unwired zone can never play — requests to it fail. */
  wired: boolean;
  playing: boolean;
  state: string;
  file: string;
  lastSource: string;
  timing: QsysZoneTiming;
}

export interface QsysLiveState {
  /** Pandora's own socket to the Core. While false, zones are the last state
   *  before the drop — stale, not wrong. */
  connected: boolean;
  zones: QsysZoneState[];
}

function pandoraHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${PANDORA_KEY}`,
    "content-type": "application/json",
    Accept: "application/json",
  };
}

export interface PlayQsysResult {
  ok: boolean;
  error?: string;
  /** The clip's length in seconds when the player reported it in time — the
   *  /play reply is held ~0.6s so it usually can. */
  durationS: number | null;
}

/**
 * Play a configured clip on one zone. Success is the zone reporting
 * `playing` — or `debounced`, which means the same clip is ALREADY going out
 * (a repeat inside the player's debounce window), and for a one-shot cue
 * that is success, not failure.
 *
 * Throws nothing: the caller (audio.server.ts) releases its one-shot claim
 * on a failed play, so every failure must come back as `ok: false`.
 */
/**
 * The room-phrase post announcements, played BY FILE like the stay-seated
 * loop (owner 2026-08-16: "we can send file names as well — can we just do
 * that?"). Upload is the whole job: drop these two MP3s on the Core's media
 * drive under EXACTLY these names — no Control Script clip config needed.
 * The zone param does the routing, same as Stay Seated.
 */
export const POST_ROOM_FILES = {
  "post-red": "Post Race Red Room.mp3",
  "post-blue": "Post Race Blue Room.mp3",
} as const;

/** Which clips play by FILE rather than by the Core's clip config. Null means
 *  a real configured clip (`pre` / `post` / `big`). */
function fileFor(clip: QsysClip): string | null {
  if (clip === "stay-seated") return STAY_SEATED_FILE;
  if (clip === "post-red" || clip === "post-blue") return POST_ROOM_FILES[clip];
  return null;
}

export async function playQsysCue(zone: TrackKey, clip: QsysClip): Promise<PlayQsysResult> {
  if (!PANDORA_KEY) return { ok: false, error: "SWAGGER_ADMIN_KEY is not set", durationS: null };
  const file = fileFor(clip);
  try {
    const res = await fetch(`${PANDORA_BASE}/qsys/audio/play`, {
      method: "POST",
      headers: pandoraHeaders(),
      body: JSON.stringify(
        file
          ? { locationID: FT_SQUARE_LOCATION_ID, zone, file }
          : { locationID: FT_SQUARE_LOCATION_ID, zone, clip },
      ),
      // The reply is deliberately held ~0.6s by the Core so it can carry the
      // clip duration; the budget covers that plus an Azure cold start.
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
    });
    const json = (await res.json().catch(() => null)) as {
      message?: string;
      data?: {
        results?: Array<{
          zone?: string;
          status?: string;
          error?: string;
          duration?: number;
        }>;
      };
    } | null;

    if (!res.ok) {
      return {
        ok: false,
        error: json?.message ?? `Q-SYS play failed (${res.status})`,
        durationS: null,
      };
    }

    const results = json?.data?.results ?? [];
    // ALWAYS logged (owner 2026-08-14: "they played pre on one track and it
    // updated both") — this is the evidence line for which zones the PLAYER
    // says it lit for our single-zone request. If a `{zone: "blue"}` play
    // comes back with red in the results, or the live feed shows both zones
    // sounding, the routing lives in the Core's Control Script clip config
    // (GET /qsys/audio/clips), not in this request.
    console.log(`[qsys] play ${clip} zone=${zone} →`, JSON.stringify(results));
    const mine = results.find((r) => r.zone === zone) ?? results[0];
    if (!mine || (mine.status !== "playing" && mine.status !== "debounced")) {
      return {
        ok: false,
        error: mine?.error ?? `the ${zone} zone did not start (${mine?.status ?? "no result"})`,
        durationS: null,
      };
    }
    return {
      ok: true,
      durationS: typeof mine.duration === "number" && mine.duration > 0 ? mine.duration : null,
    };
  } catch (err) {
    return {
      ok: false,
      error: `could not reach the PA${err instanceof Error ? ` — ${err.message}` : ""}`,
      durationS: null,
    };
  }
}

/**
 * Stop whatever is sounding on one zone — POST /qsys/audio/stop, the owner's
 * own contract (2026-08-15: `{ locationID, zone }`). Exists for exactly one
 * caller: a pre/post press cutting the stay-seated loop off so the real
 * announcement plays instantly instead of refusing with "PA busy". `zone` is
 * a plain string, not TrackKey, because the sounding zone comes off the live
 * feed verbatim.
 */
export async function stopQsysZone(zone: string): Promise<{ ok: boolean; error?: string }> {
  if (!PANDORA_KEY) return { ok: false, error: "SWAGGER_ADMIN_KEY is not set" };
  try {
    const res = await fetch(`${PANDORA_BASE}/qsys/audio/stop`, {
      method: "POST",
      headers: pandoraHeaders(),
      body: JSON.stringify({ locationID: FT_SQUARE_LOCATION_ID, zone }),
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
    });
    if (!res.ok) return { ok: false, error: `Q-SYS stop failed (${res.status})` };
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: `could not reach the PA${err instanceof Error ? ` — ${err.message}` : ""}`,
    };
  }
}

/**
 * The player's live state, from Pandora's WebSocket cache. Null on any
 * failure — this is display data riding the board poll, and a Pandora blip
 * must cost a countdown, never the controls. The FIRST request after a quiet
 * spell opens Pandora's socket and may come back `connected: false` with no
 * zones; the cache is warm within about a second, i.e. by the next poll.
 */
export async function readQsysLive(): Promise<QsysLiveState | null> {
  if (!PANDORA_KEY) return null;
  try {
    const res = await fetch(`${PANDORA_BASE}/qsys/audio/live/${FT_SQUARE_LOCATION_ID}`, {
      headers: pandoraHeaders(),
      signal: AbortSignal.timeout(4000),
      cache: "no-store",
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      data?: { connected?: boolean; zones?: QsysZoneState[] };
    };
    const data = json?.data;
    if (!data) return null;
    return {
      connected: data.connected === true,
      zones: Array.isArray(data.zones) ? data.zones : [],
    };
  } catch {
    return null;
  }
}
