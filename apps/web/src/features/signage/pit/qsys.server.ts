import "server-only";

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
 * `mega` (our TrackKey), clips are `pre` / `post` (our cues). `big` — the
 * pre-race announcement with the extra big-race warnings, played instead of
 * `pre` for a grid of 8+ (audio.server.ts owns that rule) — is OURS alone:
 * the Core has no configured clip for it, so it plays BY FILE NAME
 * ("<Track> Track Big Race.mp3", owner 2026-08-15 emergency fix; /play takes
 * exactly one of clip | file). Zones run independently — playing one never
 * cancels another.
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

export type QsysClip = "pre" | "post" | "big";

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
/** The big-race pre plays by file, not by configured clip — see the header.
 *  Zone keys are lowercase; the files are titled ("Red Track Big Race.mp3"),
 *  and the mega zone's files are named "Dual" (owner 2026-08-15). */
function bigRaceFile(zone: TrackKey): string {
  const name = zone === "mega" ? "Dual" : `${zone.charAt(0).toUpperCase()}${zone.slice(1)}`;
  return `${name} Track Big Race.mp3`;
}

export async function playQsysCue(zone: TrackKey, clip: QsysClip): Promise<PlayQsysResult> {
  if (!PANDORA_KEY) return { ok: false, error: "SWAGGER_ADMIN_KEY is not set", durationS: null };
  try {
    const res = await fetch(`${PANDORA_BASE}/qsys/audio/play`, {
      method: "POST",
      headers: pandoraHeaders(),
      body: JSON.stringify(
        clip === "big"
          ? { locationID: FT_SQUARE_LOCATION_ID, zone, file: bigRaceFile(zone) }
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
