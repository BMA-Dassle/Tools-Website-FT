import { NextRequest, NextResponse } from "next/server";
import { getGoogleAccessToken } from "@/lib/google-auth";

/**
 * POST /api/seo/submit-sitemaps
 *
 * Notifies Google Search Console that our sitemaps have been updated, by
 * calling the Sitemaps API's PUT endpoint for each property:
 *
 *   PUT /webmasters/v3/sites/{siteUrl}/sitemaps/{feedpath}
 *
 * Both "submitting" a sitemap for the first time AND "re-submitting" after
 * updates use the same PUT call — Google re-crawls the sitemap and
 * discovers new URLs. This replaces the deprecated /ping?sitemap=... path
 * which Google retired in June 2023.
 *
 * The same POST also triggers our own sitemaps, so Google refreshes its
 * copy within minutes.
 *
 * Auth: shared secret header `x-dev-secret: ${PORTAL_FORWARD_SECRET}`.
 *
 * Setup required (one-time):
 *   1. Google Cloud Console → create service account for this project
 *   2. Enable "Google Search Console API" on the project
 *   3. Google Search Console → Settings → Users and permissions →
 *      add the service account email as Owner for each verified
 *      property (fasttraxent.com AND headpinz.com)
 *   4. Download the service-account JSON key, set env var:
 *        GOOGLE_SERVICE_ACCOUNT_KEY=<paste the entire JSON blob>
 *
 * Usage:
 *   curl -X POST https://fasttraxent.com/api/seo/submit-sitemaps \
 *        -H "x-dev-secret: $PORTAL_FORWARD_SECRET"
 *
 * Can also be called on a cron (e.g. daily) to keep Google's copy fresh.
 */

/**
 * Target domains we want to submit sitemaps for. The matching GSC property
 * might be registered as either a URL-prefix property or a Domain property —
 * we auto-detect by listing the service account's accessible properties
 * first, then picking the right format.
 */
const TARGETS = [
  { domain: "fasttraxent.com", sitemap: "https://fasttraxent.com/sitemap.xml" },
  { domain: "headpinz.com", sitemap: "https://headpinz.com/sitemap.xml" },
];

interface GscSite {
  siteUrl: string;
  permissionLevel: string;
}

/**
 * List all GSC properties the service account has access to, so we can
 * match the target domain to its registered property format.
 *
 * URL-prefix properties come back as `https://fasttraxent.com/`
 * Domain properties come back as `sc-domain:fasttraxent.com`
 */
async function listAccessibleSites(token: string): Promise<GscSite[]> {
  const resp = await fetch("https://www.googleapis.com/webmasters/v3/sites", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`sites.list failed: ${resp.status} ${errText.slice(0, 300)}`);
  }
  const data = (await resp.json()) as { siteEntry?: GscSite[] };
  return data.siteEntry || [];
}

/**
 * For a target domain, find the matching GSC property in the accessible
 * list. Tries Domain property first (broader coverage) then URL-prefix
 * variants.
 */
function resolveSiteUrl(domain: string, accessible: GscSite[]): string | null {
  const candidates = [
    `sc-domain:${domain}`,
    `https://${domain}/`,
    `http://${domain}/`,
    `https://www.${domain}/`,
    `http://www.${domain}/`,
  ];
  for (const cand of candidates) {
    const match = accessible.find((s) => s.siteUrl === cand);
    if (match) return match.siteUrl;
  }
  return null;
}

export async function POST(req: NextRequest) {
  const expected = process.env.PORTAL_FORWARD_SECRET || "";
  const got = req.headers.get("x-dev-secret") || "";
  if (!expected || got !== expected) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let token: string;
  try {
    token = await getGoogleAccessToken(["https://www.googleapis.com/auth/webmasters"]);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "auth error" },
      { status: 500 },
    );
  }

  // Discover which properties the service account can see. If it sees zero,
  // the account isn't authorized on any GSC property yet — surface that
  // clearly instead of just returning "403 forbidden" for each target.
  let accessible: GscSite[];
  try {
    accessible = await listAccessibleSites(token);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "sites.list error" },
      { status: 500 },
    );
  }

  if (accessible.length === 0) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Service account can't see any GSC properties. Add googlesearch@headpinz.iam.gserviceaccount.com as Owner in each property's Users and permissions.",
        accessible,
      },
      { status: 403 },
    );
  }

  const results = await Promise.all(
    TARGETS.map(async ({ domain, sitemap }) => {
      const siteUrl = resolveSiteUrl(domain, accessible);
      if (!siteUrl) {
        return {
          domain,
          sitemap,
          ok: false,
          status: 404,
          error: `No GSC property found for ${domain}. Accessible properties: ${accessible
            .map((s) => s.siteUrl)
            .join(", ")}`,
        };
      }
      const path = `/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/sitemaps/${encodeURIComponent(sitemap)}`;
      try {
        const resp = await fetch(`https://www.googleapis.com${path}`, {
          method: "PUT",
          headers: { Authorization: `Bearer ${token}` },
        });
        if (resp.ok) {
          return { domain, siteUrl, sitemap, ok: true, status: resp.status };
        }
        const errText = (await resp.text().catch(() => "")).slice(0, 500);
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
    }),
  );

  const anyFailure = results.some((r) => !r.ok);
  return NextResponse.json(
    { ok: !anyFailure, accessible: accessible.map((s) => s.siteUrl), results },
    { status: anyFailure ? 502 : 200 },
  );
}
