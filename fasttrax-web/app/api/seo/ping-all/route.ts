import { NextRequest, NextResponse } from "next/server";
import { getGoogleAccessToken } from "@/lib/google-auth";
import { submitSitemapUrls, type IndexNowResult } from "@/lib/indexnow";

/**
 * POST /api/seo/ping-all
 *
 * Single-call fanout that notifies every major search engine a site
 * update happened:
 *
 *   - Google    — via Search Console Sitemaps API (auto-detects Domain
 *                 vs URL-prefix property, same logic as /submit-sitemaps)
 *   - Bing      — via IndexNow (pushes every sitemap URL)
 *   - Yandex    — via IndexNow
 *   - Seznam    — via IndexNow
 *   - Naver     — via IndexNow
 *   - Yep       — via IndexNow
 *   - (any other IndexNow participant listed at indexnow.org)
 *
 * Covers essentially every search engine that will respect a ping —
 * DuckDuckGo uses Bing's index, so it's covered transitively. The big
 * holdouts are Baidu (China — private submission portal only) and
 * Apple Spotlight (no ping protocol).
 *
 * Auth: x-dev-secret = PORTAL_FORWARD_SECRET.
 *
 * Usage:
 *   curl -X POST https://fasttraxent.com/api/seo/ping-all \
 *        -H "x-dev-secret: $PORTAL_FORWARD_SECRET"
 *
 * Response:
 *   {
 *     "ok": true,
 *     "google":   { ok, accessible, results: [...] },
 *     "indexnow": { ok, results: [...] }
 *   }
 */

const DOMAINS = [
  { host: "fasttraxent.com", sitemap: "https://fasttraxent.com/sitemap.xml" },
  { host: "headpinz.com", sitemap: "https://headpinz.com/sitemap.xml" },
];

// ── Google side (mirrors /api/seo/submit-sitemaps) ──────────────────────────

interface GscSite {
  siteUrl: string;
  permissionLevel: string;
}

async function listGscSites(token: string): Promise<GscSite[]> {
  const resp = await fetch("https://www.googleapis.com/webmasters/v3/sites", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) return [];
  const data = (await resp.json()) as { siteEntry?: GscSite[] };
  return data.siteEntry || [];
}

function resolveGscSiteUrl(domain: string, accessible: GscSite[]): string | null {
  const candidates = [
    `sc-domain:${domain}`,
    `https://${domain}/`,
    `http://${domain}/`,
    `https://www.${domain}/`,
    `http://www.${domain}/`,
  ];
  for (const cand of candidates) {
    if (accessible.find((s) => s.siteUrl === cand)) return cand;
  }
  return null;
}

interface GoogleResult {
  domain: string;
  siteUrl?: string | null;
  sitemap: string;
  ok: boolean;
  status: number | null;
  error?: string;
}

async function submitToGoogle(
  token: string,
  accessible: GscSite[],
  domain: string,
  sitemap: string,
): Promise<GoogleResult> {
  const siteUrl = resolveGscSiteUrl(domain, accessible);
  if (!siteUrl) {
    return {
      domain,
      siteUrl: null,
      sitemap,
      ok: false,
      status: 404,
      error: `no GSC property accessible for ${domain}`,
    };
  }
  try {
    const path = `/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/sitemaps/${encodeURIComponent(sitemap)}`;
    const resp = await fetch(`https://www.googleapis.com${path}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (resp.ok) {
      return { domain, siteUrl, sitemap, ok: true, status: resp.status };
    }
    const errText = (await resp.text().catch(() => "")).slice(0, 400);
    return { domain, siteUrl, sitemap, ok: false, status: resp.status, error: errText };
  } catch (err) {
    return {
      domain,
      siteUrl,
      sitemap,
      ok: false,
      status: null,
      error: err instanceof Error ? err.message : "network error",
    };
  }
}

// ── Main handler ────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const expected = process.env.PORTAL_FORWARD_SECRET || "";
  const got = req.headers.get("x-dev-secret") || "";
  if (!expected || got !== expected) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Run Google + IndexNow in parallel — they're independent.
  const [googleBundle, indexnowResults] = await Promise.all([
    (async () => {
      try {
        const token = await getGoogleAccessToken([
          "https://www.googleapis.com/auth/webmasters",
        ]);
        const accessible = await listGscSites(token);
        const results = await Promise.all(
          DOMAINS.map(({ host, sitemap }) => submitToGoogle(token, accessible, host, sitemap)),
        );
        return {
          ok: !results.some((r) => !r.ok),
          accessible: accessible.map((s) => s.siteUrl),
          results,
        };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : "google auth error",
          results: [] as GoogleResult[],
        };
      }
    })(),
    Promise.all(
      DOMAINS.map(({ host, sitemap }): Promise<IndexNowResult> =>
        submitSitemapUrls(host, sitemap),
      ),
    ),
  ]);

  const indexnowOk = !indexnowResults.some((r) => !r.ok);
  const allOk = googleBundle.ok && indexnowOk;

  return NextResponse.json(
    {
      ok: allOk,
      google: googleBundle,
      indexnow: { ok: indexnowOk, results: indexnowResults },
    },
    { status: allOk ? 200 : 502 },
  );
}
