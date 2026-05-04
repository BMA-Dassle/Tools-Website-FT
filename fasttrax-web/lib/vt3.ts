import redis from "@/lib/redis";

/**
 * Thin client for the Voxtelesys VT3 / Viewpoint control-panel API.
 *
 * Used by the video-match cron to detect when a camera comes back from
 * a race (a new /videos record appears on control-panel.vt3.io) and
 * pair it to the racer whose NFC tag we bound to that camera via the
 * camera-assign admin tool.
 *
 * Auth is username+password → JWT (no cookies). JWT lives 7 days; we
 * cache in Redis with a 6-day TTL so we rarely hit /auth/local.
 *
 * Customer-facing URLs are `https://vt3.io/?code={video.code}`.
 */

const VT3_HOST = "https://sys.vt3.io";
const JWT_REDIS_KEY = "vt3:jwt";
const JWT_CACHE_TTL = 60 * 60 * 24 * 6; // 6 days (token exp is 7d)

export interface Vt3Video {
  id: number;
  code: string;            // 10-char share code → customer URL
  status: string;          // PENDING_ACTIVATION, READY, …
  camera: number;
  locked: boolean;
  disabled: boolean;
  size: string;
  duration: number;        // seconds
  purchaseType: string | null;
  created_at: string;      // ISO UTC — when the on-kart capture happened
  updated_at: string;
  site: { id: number; name: string; uid: string };
  system: { id: number; username: string; name: string }; // `name` is the kart/camera number, e.g. "913"
  customer: { id: number; email?: string } | null;
  thumbnailUrl?: string;
  sampleUploadTime: string | null;
  uploadTime: string | null;
  /** First / last time ANY viewer loaded the video page or media-centre
   *  tile. VT3 populates these as racers open the vt3.io share link. */
  firstImpressionAt?: string | null;
  lastImpressionAt?: string | null;
  /** True once someone has hit the video-page (vt3.io/?code=X) or the
   *  media-centre grid view. Either one means the racer clicked through. */
  hasVideoPageImpression?: boolean;
  hasMediaCentreImpression?: boolean;
  /** Set when the video has been "unlocked" (paid out of the purchase
   *  flow). Presence is the purchased signal; absence = still locked. */
  unlockTime?: string | null;
}

async function login(): Promise<string> {
  const user = process.env.VT3_USERNAME;
  const pass = process.env.VT3_PASSWORD;
  if (!user || !pass) throw new Error("VT3_USERNAME / VT3_PASSWORD not set");

  const res = await fetch(`${VT3_HOST}/auth/local`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-cp-ui": "mui", "x-cp-ver": "v2.48.2" },
    body: JSON.stringify({ identifier: user, password: pass }),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`vt3 login failed: ${res.status} ${await res.text().catch(() => "")}`);
  const json = await res.json();
  const jwt = json?.jwt;
  if (!jwt || typeof jwt !== "string") throw new Error("vt3 login returned no jwt");
  await redis.set(JWT_REDIS_KEY, jwt, "EX", JWT_CACHE_TTL);
  return jwt;
}

/**
 * Get a valid JWT — cached in Redis, re-fetched if missing.
 * Does NOT validate expiry since our cache TTL is shorter than the
 * token's exp, but if a 401 comes back from a downstream call the
 * caller can invoke `invalidateJwt()` + retry.
 */
export async function getJwt(): Promise<string> {
  const cached = await redis.get(JWT_REDIS_KEY);
  if (cached) return cached;
  return login();
}

export async function invalidateJwt(): Promise<void> {
  await redis.del(JWT_REDIS_KEY);
}

/**
 * Fetch the latest N videos for one site, newest-first.
 *
 * Returns the raw VT3 records. Caller is responsible for dedup
 * (last-seen-id tracking) and for deciding which are worth matching.
 */
export async function listRecentVideos(opts: {
  siteId: number;
  limit?: number;
}): Promise<Vt3Video[]> {
  const { siteId, limit = 50 } = opts;

  const fetchOnce = async (jwt: string) => {
    return fetch(`${VT3_HOST}/videos`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${jwt}`,
        "x-cp-ui": "mui",
        "x-cp-ver": "v2.48.2",
      },
      body: JSON.stringify({ _start: 0, _limit: limit, _sort: "id:desc", site_in: [siteId] }),
      cache: "no-store",
    });
  };

  let jwt = await getJwt();
  let res = await fetchOnce(jwt);
  if (res.status === 401 || res.status === 403) {
    // JWT may have been invalidated server-side; try once more with a fresh one.
    await invalidateJwt();
    jwt = await login();
    res = await fetchOnce(jwt);
  }
  if (!res.ok) throw new Error(`vt3 listVideos failed: ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error("vt3 listVideos returned non-array");
  return data as Vt3Video[];
}

/**
 * Small helper that wraps the auth+retry pattern around a single fetch
 * closure. Keeps `setVideoDisabled` / `linkCustomerEmail` short.
 */
async function authedFetch(
  doFetch: (jwt: string) => Promise<Response>,
  errLabel: string,
): Promise<Response> {
  let jwt = await getJwt();
  let res = await doFetch(jwt);
  if (res.status === 401 || res.status === 403) {
    await invalidateJwt();
    jwt = await login();
    res = await doFetch(jwt);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${errLabel} failed: ${res.status} ${body.slice(0, 200)}`);
  }
  return res;
}

/**
 * Flip VT3's `disabled` flag on a video. When `disabled: true`, the
 * customer-facing `https://vt3.io/?code={code}` URL stops playing the
 * video — used by our block flow so a blocked racer can't watch a
 * video we've already SMS/emailed (or that they've stumbled into via
 * their vt3.io account).
 *
 * Endpoint verified via HAR capture from control-panel.vt3.io:
 *   PUT /videos/by-code/{code}  body: {"disabled": bool}
 */
export async function setVideoDisabled(code: string, disabled: boolean): Promise<void> {
  await authedFetch(
    (jwt) =>
      fetch(`${VT3_HOST}/videos/by-code/${encodeURIComponent(code)}`, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${jwt}`,
          "x-cp-ui": "mui",
          "x-cp-ver": "v2.48.2",
        },
        body: JSON.stringify({ disabled }),
        cache: "no-store",
      }),
    `vt3 setVideoDisabled(${code}, ${disabled})`,
  );
}

/**
 * Link a customer email to a VT3 video so the video shows up under the
 * customer's vt3.io account profile ("My Videos") and VT3's own
 * purchase-confirmation emails reach that address.
 *
 * Endpoint verified via HAR:
 *   POST /videos/{code}/customer  body: {"email": "..."}
 *
 * Returns `true` when the network call actually ran and succeeded;
 * `false` when the feature is disabled via env (see below). Callers
 * should gate their `vt3CustomerLinked` tracking on the return value
 * so records don't get marked "linked" during a disabled window —
 * otherwise they'd never retry after the feature is flipped back on.
 *
 * DISABLED by default via env gate — staff reported the VT3 customer
 * link was "doing weird things" so this is a no-op unless
 * `VT3_LINK_CUSTOMER_ENABLED=1` is set in Vercel env. Set the env var
 * and redeploy to re-enable.
 */
export async function linkCustomerEmail(code: string, email: string): Promise<boolean> {
  if (process.env.VT3_LINK_CUSTOMER_ENABLED !== "1") {
    return false;
  }
  await authedFetch(
    (jwt) =>
      fetch(`${VT3_HOST}/videos/${encodeURIComponent(code)}/customer`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${jwt}`,
          "x-cp-ui": "mui",
          "x-cp-ver": "v2.48.2",
        },
        body: JSON.stringify({ email }),
        cache: "no-store",
      }),
    `vt3 linkCustomerEmail(${code})`,
  );
  return true;
}

/**
 * One row from VT3's POV / Viewpoint unlock-code registry. Returned by
 * `POST /unlock-codes` (paginated, mirrors the videos endpoint shape).
 *
 *   status === "ACTIVE" — code printed/issued, not yet redeemed
 *   status === "USED"   — customer entered the code on vt3.io and got a video
 *   redeemedAt          — null when ACTIVE, ISO when USED
 *   video               — null when ACTIVE, 10-char videoCode when USED
 *
 * Codes are masked client-side in the control-panel UI but the API
 * returns the full plaintext code to authenticated server-side callers.
 *
 * `revokedAt` / `revokedBy` / `revokedReason` populate when staff
 * manually revokes a code via the control panel — those count as
 * neither active nor redeemed for our breakage math.
 */
export interface Vt3UnlockCode {
  uid: string;
  batchId: string;
  code: string;            // full plaintext (server-side returns unmasked)
  createdAt: string;
  status: "ACTIVE" | "USED" | string;
  createdBy?: { id: number; email?: string; name?: string };
  system: { id: number; name: string } | null;
  printedAt: string | null;
  video: string | null;    // 10-char videoCode when status === "USED"
  revokedAt: string | null;
  revokedBy: { id: number; email?: string; name?: string } | null;
  revokedReason: string | null;
  site: { id: number; name: string; uid?: string };
  redeemedAt: string | null;
}

/**
 * Drain the `/unlock-codes` registry. The endpoint is JWT-scoped to
 * the sites the user account can see — for our service account that
 * means FastTrax (site 992) only, so we don't pass `site_in`.
 *
 * Body shape verified via HAR capture from control-panel.vt3.io:
 *   POST /unlock-codes  body: {_start, _limit}
 *
 * Earlier draft also passed `_sort` and `site_in` like the videos
 * endpoint; both got rejected with 400. Keeping the body minimal —
 * matches the working capture exactly. Filters by site happen
 * post-fetch (we discard rows whose `site.id !== siteId`).
 *
 * Default page size is 100 — VT3's UI uses 15 but the service
 * appears to accept larger pages and 100 keeps round-trip count low
 * for the few-thousand-code volume we run at. `maxRows` caps total
 * iterations so a runaway pagination can't burn Lambda budget.
 *
 * Auth + retry pattern matches `listRecentVideos`. On 4xx/5xx the
 * response body is captured into the thrown error so callers can
 * see what VT3 actually rejected.
 */
export async function listAllUnlockCodes(opts: {
  siteId: number;
  pageSize?: number;
  maxRows?: number;
}): Promise<Vt3UnlockCode[]> {
  const { siteId, pageSize = 100, maxRows = 5000 } = opts;
  const out: Vt3UnlockCode[] = [];
  let start = 0;

  const fetchPage = async (jwt: string) =>
    fetch(`${VT3_HOST}/unlock-codes`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${jwt}`,
        "x-cp-ui": "mui",
        "x-cp-ver": "v2.48.2",
      },
      body: JSON.stringify({ _start: start, _limit: pageSize }),
      cache: "no-store",
    });

  while (out.length < maxRows) {
    let jwt = await getJwt();
    let res = await fetchPage(jwt);
    if (res.status === 401 || res.status === 403) {
      await invalidateJwt();
      jwt = await login();
      res = await fetchPage(jwt);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `vt3 listAllUnlockCodes failed at start=${start}: ${res.status} ${body.slice(0, 300)}`,
      );
    }
    const page = (await res.json()) as Vt3UnlockCode[];
    if (!Array.isArray(page) || page.length === 0) break;
    // Defensive site filter — JWT should already scope to the right
    // site, but if a service-account ever gains multi-site access
    // we don't want HeadPinz codes leaking into a FastTrax report.
    for (const c of page) {
      if (!c.site || c.site.id === siteId) out.push(c);
    }
    if (page.length < pageSize) break;
    start += pageSize;
  }
  return out;
}
