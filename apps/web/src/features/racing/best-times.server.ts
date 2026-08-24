import "server-only";

/**
 * SMS-Timing "best times" (Hall of Fame) — the one place that talks to the
 * upstream and holds its access token.
 *
 * Lifted out of app/api/besttimes/route.ts (2026-08-17) when the signage
 * top-times wall needed the same data server-side. That route is a BROWSER
 * proxy: the kiosk Race Info hub and /leaderboards are client components and
 * cannot hold a token, so they go through it. A server resolver calling its own
 * HTTP route to reach an upstream it could call directly would pay a second
 * round trip and lose the token cache to a cold lambda, so it calls this
 * instead — and the route now delegates here, keeping ONE implementation of the
 * token renewal rather than two that can drift.
 *
 * The catalog of which rscId/scgId means which track+tier+class lives in
 * ~/lib/constants/race-records, shared with both client screens.
 */

const ENCRYPTED_KEY = "U2FsdGVkX18rw9HVQvtJrdeGZNAVakzC08J8Ij8PZNI%3D";
const API_HOST = "modules-api22.sms-timing.com";
const CLIENT_KEY = "headpinzftmyers";

/** Tokens outlive this comfortably; the hour is a freshness margin, not the
 *  real expiry — a 401 mid-request is handled by retrying once below. */
const TOKEN_TTL_MS = 60 * 60 * 1000;

let cachedToken: string | null = null;
let tokenExpiry = 0;

async function getToken(): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

  const res = await fetch(
    `https://backend.sms-timing.com/api/connectioninfo/encrypted?message=${ENCRYPTED_KEY}&locationType=3&type=modules`,
    { cache: "no-store" },
  );
  if (!res.ok) throw new Error(`Token refresh failed: ${res.status}`);
  const data = await res.json();
  cachedToken = data.AccessToken as string;
  tokenExpiry = Date.now() + TOKEN_TTL_MS;
  return cachedToken;
}

export interface BestTimesQuery {
  rscId: string;
  scgId: string;
  /** Center-local "YYYY-M-D HH:mm:ss" — build it with `recordsStartDate`. */
  startDate: string;
  maxResult?: string;
  endpoint?: string;
}

/**
 * Raw upstream response, passed through untouched.
 *
 * Deliberately `unknown`: the proxy route hands the browser whatever the
 * upstream said, and narrowing here would make this module the place that has
 * to know every endpoint's shape. Callers that want records use
 * `fetchBestTimeRecords` below.
 */
export async function fetchBestTimes(q: BestTimesQuery): Promise<unknown> {
  const token = await getToken();
  const params = new URLSearchParams({
    locale: "en-US",
    rscId: q.rscId,
    scgId: q.scgId,
    startDate: q.startDate,
    endDate: "",
    maxResult: q.maxResult ?? "10",
    accessToken: token,
  });

  const endpoint = q.endpoint ?? "records";
  const url = () => `https://${API_HOST}/api/besttimes/${endpoint}/${CLIENT_KEY}?${params}`;

  const res = await fetch(url(), { cache: "no-store" });
  if (res.status !== 401) return res.json();

  // Token expired mid-request — drop it, renew, and retry exactly once. A
  // second 401 is a real failure and is allowed to surface.
  cachedToken = null;
  tokenExpiry = 0;
  params.set("accessToken", await getToken());
  const retry = await fetch(url(), { cache: "no-store" });
  return retry.json();
}

/** One row of the hall of fame, as the upstream sends it. Mirrors
 *  `BestTimeRecord` in ~/lib/constants/race-records. */
export interface BestTimeRow {
  position: number;
  participant: string;
  score: string;
  date: string;
}

/**
 * The `records` array for one category, already narrowed.
 *
 * Returns [] rather than throwing on a shape we do not recognise: every caller
 * is a wall or a kiosk panel whose honest answer to "no records" is an empty
 * table, and neither has an error state worth reaching for here.
 */
export async function fetchBestTimeRecords(q: BestTimesQuery): Promise<BestTimeRow[]> {
  const data = (await fetchBestTimes(q)) as { records?: unknown };
  if (!data || !Array.isArray(data.records)) return [];
  return data.records.filter(
    (r): r is BestTimeRow =>
      !!r && typeof r === "object" && typeof (r as BestTimeRow).participant === "string",
  );
}
