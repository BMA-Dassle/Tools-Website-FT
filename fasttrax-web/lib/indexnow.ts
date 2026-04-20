/**
 * IndexNow protocol — near-instant re-crawl notification for Bing,
 * Yandex, Seznam, Naver, Yep, and other participants (full list:
 * https://www.indexnow.org/searchengines.json). Google does NOT
 * participate — use lib/google-auth.ts + the GSC Sitemaps API for Google.
 *
 * How it works:
 *   1. Host a key file at {scheme}://{host}/{key}.txt containing just
 *      the key value (plaintext). This proves domain ownership.
 *   2. POST a JSON body to https://api.indexnow.org/IndexNow with the
 *      host, key, keyLocation, and a list of URLs to re-crawl.
 *   3. Participating engines fetch the URLs within minutes.
 *
 * Env var: INDEXNOW_KEY — 8-128 hex chars (we use a SHA-1-length 40-hex).
 *
 * The public key file is generated from the env var at build/start time
 * by `scripts/indexnow-write-key.ts` (optional) OR dropped manually into
 * `public/{INDEXNOW_KEY}.txt`. Either works.
 */

const INDEXNOW_API = "https://api.indexnow.org/IndexNow";

export interface IndexNowResult {
  host: string;
  key: string;
  urlCount: number;
  ok: boolean;
  status: number | null;
  error?: string;
}

/**
 * Submit a list of URLs to IndexNow for a given host. All URLs must
 * belong to that host. Returns status — 200 or 202 = accepted, 422 =
 * key validation failed, 403 = key file not found at keyLocation.
 */
export async function submitIndexNow(
  host: string,
  urls: string[],
  options?: { key?: string; keyLocation?: string },
): Promise<IndexNowResult> {
  const key = options?.key || process.env.INDEXNOW_KEY || "";
  if (!key) {
    return {
      host,
      key: "",
      urlCount: urls.length,
      ok: false,
      status: null,
      error: "INDEXNOW_KEY env var not set",
    };
  }
  if (urls.length === 0) {
    return { host, key, urlCount: 0, ok: true, status: null, error: "no urls (noop)" };
  }
  // IndexNow limit: 10,000 URLs per submission.
  const batch = urls.slice(0, 10_000);
  const keyLocation =
    options?.keyLocation || `https://${host}/${key}.txt`;

  try {
    const resp = await fetch(INDEXNOW_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Host: "api.indexnow.org",
      },
      body: JSON.stringify({
        host,
        key,
        keyLocation,
        urlList: batch,
      }),
    });
    if (resp.ok) {
      return { host, key, urlCount: batch.length, ok: true, status: resp.status };
    }
    const errText = (await resp.text().catch(() => "")).slice(0, 500);
    return {
      host,
      key,
      urlCount: batch.length,
      ok: false,
      status: resp.status,
      error: errText || interpretStatus(resp.status),
    };
  } catch (err) {
    return {
      host,
      key,
      urlCount: batch.length,
      ok: false,
      status: null,
      error: err instanceof Error ? err.message : "network error",
    };
  }
}

function interpretStatus(status: number): string {
  switch (status) {
    case 400: return "Bad request — malformed JSON or missing fields";
    case 403: return "Forbidden — key file not found at keyLocation (host the key at /{key}.txt)";
    case 422: return "Unprocessable — URLs don't match host OR key invalid";
    case 429: return "Rate limited — too many submissions";
    default: return `HTTP ${status}`;
  }
}

/**
 * Full-sitemap crawl — get every URL this domain serves and submit all
 * of them. Lighter alternative to Google's sitemap PUT since IndexNow
 * accepts explicit URL lists (no crawl budget consumed).
 */
export async function submitSitemapUrls(
  host: string,
  sitemapUrl: string,
  options?: { key?: string; keyLocation?: string },
): Promise<IndexNowResult> {
  try {
    const resp = await fetch(sitemapUrl);
    if (!resp.ok) {
      return {
        host,
        key: options?.key || process.env.INDEXNOW_KEY || "",
        urlCount: 0,
        ok: false,
        status: resp.status,
        error: `could not fetch sitemap: ${resp.status}`,
      };
    }
    const xml = await resp.text();
    // Cheap XML URL extractor — good enough for standard sitemap.xml.
    const urls = Array.from(xml.matchAll(/<loc>([^<]+)<\/loc>/g)).map((m) => m[1]);
    return submitIndexNow(host, urls, options);
  } catch (err) {
    return {
      host,
      key: options?.key || process.env.INDEXNOW_KEY || "",
      urlCount: 0,
      ok: false,
      status: null,
      error: err instanceof Error ? err.message : "sitemap fetch error",
    };
  }
}
