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

/**
 * The two FastTrax briefing-room cameras, by room (Nx device ids from the live
 * device list, verified 2026-08-12).
 */
export const BRIEFING_ROOM_CAMERAS: Record<"blue" | "red", string> = {
  blue: "ae9373a3-f070-b2d6-d109-751c26159b6c",
  red: "dbecf8d8-d543-419a-bafc-bda19f48b689",
};

/**
 * THE PIT HOLDING AREAS — resolved from Nx LAYOUTS, by name (owner 2026-08-13).
 *
 * The rooms above are pinned device ids because there are exactly two of them
 * and they will not move. Holding is different: the owner keeps the view in Nx
 * itself and is splitting it per track ("I'm going to have a FT Holding Red and
 * FT Holding Blue"). Pinning a GUID here would mean a deploy every time that
 * changes, so instead we read the layout the owner already maintains and take
 * the camera off it — repoint the view in the Nx client and the desk follows on
 * the next cache expiry, no deploy, no code.
 *
 * A layout is MEMBERSHIP AND GEOMETRY, never a rendered picture — confirmed
 * against Nx's own v4 schema 2026-08-13: `/rest/v4/layouts` gives `items[]` with
 * a `resourceId` and cell coordinates, and the only image/media endpoints in the
 * whole surface are per-device. So we take the layout's FIRST item (by cell
 * position, top-left first) and pull that camera exactly like any other.
 *
 * FALLBACK CHAIN, so this works today and improves itself the moment the owner
 * creates the per-track layouts: `FT Holding <Track>` → `FT Holding` → the
 * camera that layout resolved to on 2026-08-13 (FT VIP Walkway South — frame
 * verified, the numbered pit spots are on the floor in shot). A board is never
 * left with no picture because a layout has not been made yet.
 */
const HOLDING_LAYOUT_PREFIX = "FT Holding";

/** Last-resort holding camera — what `FT Holding` held on 2026-08-13. Only
 *  reached if every layout lookup fails or returns nothing usable. */
const HOLDING_CAMERA_FALLBACK = "c1020e04-f54a-bc4a-dcc3-5691c62453d1";

/** Every camera this app can address BY NAME rather than through a screen's
 *  saved config. These are the ONLY cameras `/api/tv/camera?room=` and the
 *  live-ticket route can reach, so the shortcut can never be turned into a way
 *  to pull an arbitrary camera. */
export type FixedCameraKey = "blue" | "red" | "holding-red" | "holding-blue";

export function parseFixedCameraKey(key: string | null | undefined): FixedCameraKey | null {
  return key === "blue" || key === "red" || key === "holding-red" || key === "holding-blue"
    ? key
    : null;
}

/**
 * A FISHEYE VIEW, as Nx stores it on a layout item.
 *
 * The holding camera is a ceiling fisheye, and the layouts do not merely pick it
 * — they carry the aim (owner 2026-08-13: "I have the camera view saved in
 * them"). Red and Blue are the SAME device with different `dewarpingParams`, so
 * the view is the entire point of reading the layout at all.
 *
 * Angles are radians, straight off the layout; `panoFactor` is Nx's aspect
 * correction (1, 2 or 4).
 */
export interface DewarpView {
  xAngle: number;
  yAngle: number;
  fov: number;
  panoFactor: number;
}

export interface FixedCamera {
  deviceId: string;
  /** Absent for the plain rectilinear room cameras. */
  dewarp?: DewarpView;
}

/**
 * Resolve one of the fixed cameras.
 *
 * ASYNC BECAUSE HOLDING IS: the rooms answer from the constant above without
 * touching Nx, while a holding key reads the layout list (cached — see
 * holdingCamera). Callers await either way rather than branching on which kind
 * of camera they were asked for.
 */
export async function resolveFixedCamera(
  key: string | null | undefined,
): Promise<FixedCamera | null> {
  const parsed = parseFixedCameraKey(key);
  if (!parsed) return null;
  if (parsed === "blue" || parsed === "red") return { deviceId: BRIEFING_ROOM_CAMERAS[parsed] };
  return holdingCamera(parsed === "holding-red" ? "red" : "blue");
}

/** One layout as the picker needs it. */
interface NxLayout {
  id: string;
  name: string;
  items: Array<{ resourceId: string; left: number; top: number; dewarp?: DewarpView }>;
}

/**
 * The layout list, cached module-side. Layouts change when a human edits them in
 * the Nx client — minutes-to-months — so a five-minute window keeps a board
 * polling once a second from asking Nx about layouts once a second, while still
 * picking up a repoint well inside a shift.
 *
 * The cache holds FAILURES for a much shorter time, so an Nx blip costs one
 * short retry window rather than five minutes of fallback camera.
 */
const LAYOUT_TTL_MS = 5 * 60_000;
const LAYOUT_FAIL_TTL_MS = 20_000;
let layoutCache: { at: number; layouts: NxLayout[] | null } | null = null;

async function listLayouts(): Promise<NxLayout[] | null> {
  const now = Date.now();
  if (layoutCache) {
    const ttl = layoutCache.layouts ? LAYOUT_TTL_MS : LAYOUT_FAIL_TTL_MS;
    if (now - layoutCache.at < ttl) return layoutCache.layouts;
  }
  try {
    const token = await getToken();
    const res = await relayGet("/rest/v4/layouts", token);
    if (!res.ok) throw new Error(`nx layouts: ${res.status}`);
    // Nx GUIDs and names — no BMI-style long ids on this rail, so plain JSON
    // parsing is safe here (same reasoning as listCameras).
    const raw = (await res.json()) as Array<Record<string, unknown>>;
    const layouts: NxLayout[] = raw.map((l) => ({
      id: String(l.id ?? ""),
      name: String(l.name ?? ""),
      items: (Array.isArray(l.items) ? l.items : [])
        .map((i) => {
          const item = i as Record<string, unknown>;
          const d = (item.dewarpingParams ?? {}) as Record<string, unknown>;
          // Only a dewarp the layout actually ENABLED counts. A disabled block
          // still carries angles, and applying them would aim a rectilinear
          // camera at nothing.
          const dewarp =
            d.enabled === true
              ? {
                  xAngle: Number(d.xAngle) || 0,
                  yAngle: Number(d.yAngle) || 0,
                  fov: Number(d.fov) || 0,
                  panoFactor: Number(d.panoFactor) || 1,
                }
              : undefined;
          return {
            resourceId: String(item.resourceId ?? ""),
            left: Number(item.left) || 0,
            top: Number(item.top) || 0,
            ...(dewarp && dewarp.fov > 0 ? { dewarp } : {}),
          };
        })
        .filter((i) => i.resourceId),
    }));
    layoutCache = { at: now, layouts };
    return layouts;
  } catch {
    layoutCache = { at: now, layouts: null };
    return null;
  }
}

/**
 * The holding camera for one track.
 *
 * Names are matched case-insensitively and trimmed, because this is a string a
 * human types into the Nx client — "FT Holding Red", "ft holding red " and
 * "FT  Holding Red" must all be the layout we meant.
 */
async function holdingCamera(track: "red" | "blue"): Promise<FixedCamera> {
  const layouts = await listLayouts();
  if (!layouts) return { deviceId: HOLDING_CAMERA_FALLBACK };

  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
  const perTrack = norm(`${HOLDING_LAYOUT_PREFIX} ${track}`);
  const shared = norm(HOLDING_LAYOUT_PREFIX);

  // The per-track layout wins; the shared one is what exists until the owner
  // splits it. Never a partial match — "FT Holding Red" must not be found by a
  // search for "FT Holding" when both exist.
  const pick =
    layouts.find((l) => norm(l.name) === perTrack) ?? layouts.find((l) => norm(l.name) === shared);
  if (!pick) return { deviceId: HOLDING_CAMERA_FALLBACK };

  // Top-left first, so a multi-camera layout has a defined "main" tile rather
  // than whichever one Nx happened to serialise first.
  const first = [...pick.items].sort((a, b) => a.top - b.top || a.left - b.left)[0];
  if (!first) return { deviceId: HOLDING_CAMERA_FALLBACK };
  const dewarp = HOLDING_VIEW_PIN[track] ?? first.dewarp;
  return { deviceId: first.resourceId, ...(dewarp ? { dewarp } : {}) };
}

/**
 * A PINNED AIM THAT OUTRANKS THE LAYOUT — one track, and only because the Nx
 * client will not persist it (2026-08-13).
 *
 * The design reads the aim off the layout precisely so re-pointing a view is an
 * Nx edit rather than a deploy, and BLUE works exactly that way — it is absent
 * from this map and takes whatever the layout says.
 *
 * RED does not. Its saved item is `xAngle 2.9051, yAngle 0.3560, fov 0.9425`,
 * which frames the wall ABOVE the seats — the grid is off the bottom of the
 * picture. The owner re-aimed it correctly in the client and saved twice; the
 * server record did not move either time (verified against /rest/v4/layouts
 * after each save, and no private duplicate layout was created — still 13
 * layouts, same ids). Whatever the client is writing, the REST view of that
 * layout is not it, and the board can only read what REST reports.
 *
 * So the numbers below are the aim the owner actually wants, measured by
 * sweeping the fisheye and matching the frame they signed off: the red 1-15
 * grid filling the frame, the way Blue's view frames the white grid.
 *
 * DELETE THIS ENTRY the moment `FT Holding Red` reports a sane aim over REST —
 * the layout is meant to be the truth, and a pin that outlives its reason is a
 * view nobody can change without a deploy.
 */
const HOLDING_VIEW_PIN: Partial<Record<"red" | "blue", DewarpView>> = {
  red: { xAngle: -3.6, yAngle: 0.66, fov: 1.02, panoFactor: 1 },
};

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
 * Request a path on the server through the relay, following the relay's cross-host
 * 307 by hand so the bearer survives it (see the header note up top). Returns the
 * raw Response; callers decide what to do with a non-2xx.
 */
async function relayFetch(path: string, token: string, init?: RequestInit): Promise<Response> {
  const headers = {
    ...(init?.headers as Record<string, string>),
    Authorization: `Bearer ${token}`,
  };
  let url = `${relayBase()}${path}`;
  for (let hop = 0; hop < RELAY_HOP_LIMIT; hop++) {
    const res = await fetch(url, { ...init, headers, redirect: "manual", cache: "no-store" });
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

async function relayGet(path: string, token: string): Promise<Response> {
  return relayFetch(path, token);
}

/**
 * GET a relay path with a live bearer, retrying once on 401.
 *
 * EXPORTED so the non-frame readers (motion.server.ts) share ONE auth path
 * rather than each growing their own token cache. A second mint-and-cache would
 * double the login traffic and, worse, could hold a revoked token that this
 * module had already refreshed past.
 *
 * Returns the raw Response — callers decide what a non-2xx means for them.
 */
export async function nxRelayGet(path: string): Promise<Response> {
  let token = await getToken();
  let res = await relayGet(path, token);
  if (res.status === 401) {
    token = await getToken(true);
    res = await relayGet(path, token);
  }
  return res;
}

/**
 * POST JSON to a relay path — the ONE write this module allows.
 *
 * Everything else here reads. This exists for briefing bookmarks (markers on the
 * NVR's own timeline, see briefing/bookmarks.server.ts) and needs "Manage
 * bookmarks" on the Nx user, which a future view-only service account must be
 * granted explicitly or the writes 403 silently.
 *
 * NOT retried on a non-401 failure: a bookmark is best-effort evidence, and a
 * retry loop against the venue's NVR is a worse outcome than a missing marker.
 */
export async function nxRelayPost(path: string, body: unknown): Promise<Response> {
  const init: RequestInit = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
  let token = await getToken();
  let res = await relayFetch(path, token, init);
  if (res.status === 401) {
    token = await getToken(true);
    res = await relayFetch(path, token, init);
  }
  return res;
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
  opts?: { width?: number; height?: number; dewarp?: DewarpView },
): Promise<CameraFrame> {
  if (opts?.dewarp) return fetchDewarpedFrame(deviceId, opts.dewarp, opts);

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

/**
 * ONE DEWARPED FRAME, taken off the front of an MJPEG stream.
 *
 * WHY NOT `/image`: dewarping is a TRANSCODING option, and Nx only offers
 * transcoding on the media endpoints — probed against our own system's v4
 * schema 2026-08-13, `/devices/{id}/image` takes `crop` and `rotation` and
 * nothing else. A fisheye still therefore cannot be aimed; only video can. The
 * holding view IS an aim (see DewarpView), so a still of it has to come out of
 * a stream.
 *
 * AND WE STILL NEVER HOLD A STREAM OPEN. `media.mpjpeg` is a multipart series of
 * whole JPEGs: we read until the first frame's EOI marker, abort the request,
 * and return those bytes. One frame, connection dropped, function ends — the
 * same shape as every other call in this file, just sourced differently.
 * Measured ~0.9s live, against ~0.2s for a plain `/image` pull, which is why the
 * caller polls a dewarped preview more slowly.
 */
const JPEG_SOI = Buffer.from([0xff, 0xd8]);
const JPEG_EOI = Buffer.from([0xff, 0xd9]);
/** A frame that has not completed by here is a stream we should not keep
 *  reading — the caller will show its last good picture and try again. */
const MJPEG_FRAME_CAP_BYTES = 8 * 1024 * 1024;

async function fetchDewarpedFrame(
  deviceId: string,
  dewarp: DewarpView,
  opts?: { width?: number; height?: number },
): Promise<CameraFrame> {
  const w = clampSize(opts?.width);
  const h = clampSize(opts?.height);
  const params = new URLSearchParams({
    dewarping: "true",
    dewarpingXangle: String(dewarp.xAngle),
    dewarpingYangle: String(dewarp.yAngle),
    dewarpingFov: String(dewarp.fov),
    dewarpingPanofactor: String(dewarp.panoFactor),
  });
  // Nx wants a full WxH here — unlike `/image`, a bare width is not accepted.
  // The fisheye's dewarped output is 16:9, so a width alone implies its height.
  if (w) params.set("resolution", `${w}x${h || Math.round((w * 9) / 16)}`);

  const path = `/rest/v4/devices/${encodeURIComponent(deviceId)}/media.mpjpeg?${params}`;

  let token = await getToken();
  let res = await relayFetch(path, token);
  if (res.status === 401) {
    token = await getToken(true);
    res = await relayFetch(path, token);
  }
  if (!res.ok || !res.body) throw new Error(`nx dewarped frame ${deviceId}: ${res.status}`);

  const reader = res.body.getReader();
  let buf = Buffer.alloc(0);
  try {
    while (buf.length < MJPEG_FRAME_CAP_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      buf = Buffer.concat([buf, Buffer.from(value)]);
      // The multipart part headers sit in front of the first frame, so find the
      // JPEG by its own markers rather than parsing the boundary.
      const soi = buf.indexOf(JPEG_SOI);
      if (soi < 0) continue;
      const eoi = buf.indexOf(JPEG_EOI, soi + 2);
      if (eoi < 0) continue;
      const jpeg = buf.subarray(soi, eoi + 2);
      // Copy out of the pooled Buffer — a Node Buffer is a view on shared
      // memory, and handing that slice's .buffer to a Response would ship the
      // whole pool.
      return {
        body: jpeg.buffer.slice(jpeg.byteOffset, jpeg.byteOffset + jpeg.byteLength) as ArrayBuffer,
        contentType: "image/jpeg",
      };
    }
  } finally {
    // Whatever happened, stop the transcode — this is the line that keeps a
    // frame grab from becoming a held-open stream.
    await reader.cancel().catch(() => {});
  }
  throw new Error(`nx dewarped frame ${deviceId}: no complete frame`);
}

/* ── live video, played by the BROWSER ────────────────────────────────── */

/**
 * A LIVE STREAM THE PAGE PLAYS ITSELF, which is the only shape live video can
 * take here.
 *
 * Everything else in this file is one short request that returns one JPEG,
 * because a serverless function must never hold a stream open (see the header).
 * That rules out proxying video through us at ANY frame rate — so for a real live
 * picture the browser has to talk to the relay directly, and the page must not be
 * handed the bearer to do it.
 *
 * Nx's answer is a LOGIN TICKET: a short-lived credential that travels in the URL
 * and is accepted on media endpoints, so it can sit in a `<video src>` without a
 * header. PROBED LIVE 2026-08-12 against our own system, because none of this is
 * worth assuming:
 *
 *   • `POST /rest/v4/login/tickets` → `{ token, expiresInS: 599 }`             ✓
 *   • `media.mp4?_ticket=…` through the relay → 200, video/mp4, bytes flowing  ✓
 *   • the relay DOES answer CORS — it echoed our Origin back in
 *     Access-Control-Allow-Origin (older notes here said browser calls were
 *     blocked outright; they are not)                                          ✓
 *   • THE TICKET IS SINGLE-USE — a second request with the same ticket 401s.
 *     So one ticket per <video> load, and a fresh one for every retry.          ✓
 *   • 720p live ran ~8 KB/s, which is why the viewer can afford it at all.      ✓
 *
 * A leaked ticket is one stream of one briefing-room camera for at most ten
 * minutes, and only until it is used once. That is a far smaller thing to lose
 * than the bearer, which stays in this module — but it is not nothing, which is
 * why the route that mints these is admin-token gated rather than public like the
 * still proxy.
 */
export interface CameraLiveStream {
  /** Fully-formed, ticket-bearing URL for a <video> element. Single use. */
  url: string;
  /** Ticket lifetime in seconds, as Nx reported it. */
  expiresInS: number;
}

export async function cameraLiveStream(
  deviceId: string,
  opts?: { resolution?: "360p" | "480p" | "720p" | "1080p"; dewarp?: DewarpView },
): Promise<CameraLiveStream> {
  let token = await getToken();
  let res = await relayFetch("/rest/v4/login/tickets", token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  if (res.status === 401) {
    token = await getToken(true);
    res = await relayFetch("/rest/v4/login/tickets", token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
  }
  if (!res.ok) throw new Error(`nx ticket: ${res.status}`);

  // Nx GUIDs and a ticket string — no BMI-style long ids on this rail, so plain
  // JSON parsing is safe here.
  const json = (await res.json()) as { token?: string; expiresInS?: number };
  if (!json.token) throw new Error("nx ticket: no token in response");

  // No `positionMs` ⇒ LIVE. 720p by default: the viewer is full-screen, and at the
  // measured bitrate the resolution is not what costs anything.
  const params = new URLSearchParams({
    resolution: opts?.resolution ?? "720p",
    _ticket: json.token,
  });
  // THE SAVED AIM TRAVELS WITH THE STREAM. Live video is the one surface where
  // dewarping is free — it is a transcode option, and the transcode is already
  // happening. So the full-screen holding view is the layout's own view, moving,
  // rather than a raw fisheye the staff member has to re-interpret.
  if (opts?.dewarp) {
    params.set("dewarping", "true");
    params.set("dewarpingXangle", String(opts.dewarp.xAngle));
    params.set("dewarpingYangle", String(opts.dewarp.yAngle));
    params.set("dewarpingFov", String(opts.dewarp.fov));
    params.set("dewarpingPanofactor", String(opts.dewarp.panoFactor));
  }
  const url = `${relayBase()}/rest/v4/devices/${encodeURIComponent(deviceId)}/media.mp4?${params}`;
  return { url, expiresInS: Number(json.expiresInS) || 300 };
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
