import "server-only";

/**
 * Nx Witness (Network Optix) camera bridge — SERVER ONLY.
 *
 * The venue's CCTV lives on one Nx Witness system (cloud id in env). This module
 * is the ONLY thing that holds Nx credentials or talks to the relay; everything
 * guest-facing goes through /api/tv/camera, which calls in here.
 *
 * Two facts about the deployment shape drive every choice below:
 *
 *  1. WE ARE ON SERVERLESS. We never hold a video stream open — a function that
 *     pipes MJPEG for an hour is a function killed at its duration cap, and the
 *     bill to match. Every call here is one short request that returns one JPEG
 *     and ends; the board asks again a second later (see SceneCameraMonitor).
 *
 *  2. THE RELAY REDIRECTS, AND fetch DROPS THE BEARER ACROSS IT. Cameras are only
 *     reachable through Nx Cloud's relay, which 307s to a regional node on a
 *     different host — and Node's fetch strips the Authorization header on a
 *     cross-origin redirect (the same rule curl's plain `-L` follows). So we
 *     follow the redirect BY HAND and re-attach the bearer. Getting this wrong is
 *     a 401 "MissingCredentials".
 *
 * CREDENTIALS: a single Nx Cloud login mints a bearer scoped to the one system.
 * Owner login for now; swapping to a dedicated view-only Nx user is a pure env
 * change (NX_CLOUD_USERNAME / NX_CLOUD_PASSWORD) with no code touched — do it, so
 * a leaked token can read cameras and nothing else, and a password change here
 * does not dark every board.
 */

const RELAY_HOP_LIMIT = 4;

/** Env read at CALL TIME, never module scope — same rule as flags.ts, so a
 *  deploy that sets the vars does not need a cold start to pick them up, and
 *  tests can stub them. */
function env(name: string): string {
  return process.env[name] || "";
}

/** Is the bridge configured at all? The route 503s (not 500s) when it isn't, so
 *  a board on an unconfigured deploy shows "connecting", never an error. */
export function nxConfigured(): boolean {
  return !!(env("NX_CLOUD_SYSTEM_ID") && env("NX_CLOUD_USERNAME") && env("NX_CLOUD_PASSWORD"));
}

function relayBase(): string {
  return `https://${env("NX_CLOUD_SYSTEM_ID")}.relay.vmsproxy.com`;
}

interface CachedToken {
  token: string;
  expiresAtMs: number;
}
/** Module-level, so a warm instance mints once a day, not once a frame. Best
 *  effort — a cold instance simply mints its own. */
let cachedToken: CachedToken | null = null;

async function mintToken(): Promise<string> {
  const systemId = env("NX_CLOUD_SYSTEM_ID");
  const res = await fetch("https://nxvms.com/cdb/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "password",
      response_type: "token",
      client_id: "3rdParty",
      // BARE cloudSystemId scope. The documented broader scope
      // ("https://nxvms.com/cdb/oauth2/token cloudSystemId=…") mints a token that
      // then 401s against the server as "WrongSessionToken"; this is the form
      // that actually authorizes server requests.
      scope: `cloudSystemId=${systemId}`,
      username: env("NX_CLOUD_USERNAME"),
      password: env("NX_CLOUD_PASSWORD"),
    }),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`nx token mint failed: ${res.status}`);
  const json = (await res.json()) as { access_token?: string; expires_in?: string | number };
  if (!json.access_token) throw new Error("nx token mint: no access_token in response");
  const ttlSec = Number(json.expires_in);
  const safeTtl = Number.isFinite(ttlSec) && ttlSec > 0 ? ttlSec : 3600;
  // Renew 5 minutes early so a frame request never races the expiry.
  cachedToken = {
    token: json.access_token,
    expiresAtMs: Date.now() + Math.max(60, safeTtl - 300) * 1000,
  };
  return json.access_token;
}

async function getToken(force = false): Promise<string> {
  if (!force && cachedToken && cachedToken.expiresAtMs > Date.now()) return cachedToken.token;
  return mintToken();
}

/**
 * GET a path on the server through the relay, following the relay's cross-host
 * 307 by hand so the bearer survives it (see the header note up top). Returns the
 * raw Response; callers decide what to do with a non-2xx.
 */
async function relayGet(path: string, token: string): Promise<Response> {
  const headers = { Authorization: `Bearer ${token}` };
  let url = `${relayBase()}${path}`;
  for (let hop = 0; hop < RELAY_HOP_LIMIT; hop++) {
    const res = await fetch(url, { headers, redirect: "manual", cache: "no-store" });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) return res;
      url = new URL(location, url).toString();
      continue;
    }
    return res;
  }
  throw new Error("nx relay: too many redirects");
}

export interface CameraFrame {
  body: ArrayBuffer;
  contentType: string;
}

/** Clamp a requested pixel dimension to something a camera will honour. 0/absent
 *  means "let the server decide". */
function clampSize(v: number | undefined): number {
  if (!v || !Number.isFinite(v)) return 0;
  return Math.min(1920, Math.max(120, Math.floor(v)));
}

/**
 * One still frame from a camera, as JPEG bytes.
 *
 * `deviceId` is resolved server-side from a screen's saved config — NEVER taken
 * from the client — so this can only ever be aimed at a camera an admin
 * deliberately allowlisted onto a board. `timestampMs=-1` is "the latest frame".
 * Retries ONCE on a 401 in case the cached token was revoked mid-life.
 */
export async function fetchCameraFrame(
  deviceId: string,
  opts?: { width?: number; height?: number },
): Promise<CameraFrame> {
  const w = clampSize(opts?.width);
  const h = clampSize(opts?.height);
  const size = w || h ? `&size=${w}x${h}` : "";
  const path =
    `/rest/v4/devices/${encodeURIComponent(deviceId)}/image` +
    `?timestampMs=-1&format=jpg&tolerant=true${size}`;

  let token = await getToken();
  let res = await relayGet(path, token);
  if (res.status === 401) {
    token = await getToken(true);
    res = await relayGet(path, token);
  }
  if (!res.ok) throw new Error(`nx frame ${deviceId}: ${res.status}`);
  const body = await res.arrayBuffer();
  return { body, contentType: res.headers.get("content-type") || "image/jpeg" };
}

export interface NxCamera {
  id: string;
  name: string;
  /** Nx "custom group" — the venue/area label, e.g. "Fast Trax Fort Myers". */
  group: string | null;
  status: string | null;
}

/**
 * The camera list, for the admin picker. Ids + names only — no stream tokens, no
 * credentials. Nx device ids are GUIDs (strings), so plain JSON parsing is safe
 * here; the BMI 17-digit-id precision rule does not apply to Nx.
 */
export async function listCameras(): Promise<NxCamera[]> {
  const token = await getToken();
  const res = await relayGet("/rest/v4/devices", token);
  if (!res.ok) throw new Error(`nx devices: ${res.status}`);
  const raw = (await res.json()) as Array<Record<string, unknown>>;
  return raw
    .map((d) => {
      const params = (d.parameters ?? {}) as Record<string, unknown>;
      return {
        id: String(d.id ?? ""),
        name: String(d.name ?? ""),
        group: typeof params.customGroupId === "string" ? params.customGroupId : null,
        status: typeof d.status === "string" ? d.status : null,
      };
    })
    .filter((d) => d.id && d.name)
    .sort((a, b) => (a.group ?? "").localeCompare(b.group ?? "") || a.name.localeCompare(b.name));
}
