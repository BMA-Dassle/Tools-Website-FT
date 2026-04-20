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

const SITEMAPS = [
  { siteUrl: "https://fasttraxent.com/", sitemap: "https://fasttraxent.com/sitemap.xml" },
  { siteUrl: "https://headpinz.com/", sitemap: "https://headpinz.com/sitemap.xml" },
];

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

  const results = await Promise.all(
    SITEMAPS.map(async ({ siteUrl, sitemap }) => {
      const path = `/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/sitemaps/${encodeURIComponent(sitemap)}`;
      try {
        const resp = await fetch(`https://www.googleapis.com${path}`, {
          method: "PUT",
          headers: { Authorization: `Bearer ${token}` },
        });
        if (resp.ok) {
          return { siteUrl, sitemap, ok: true, status: resp.status };
        }
        const errText = (await resp.text().catch(() => "")).slice(0, 500);
        return { siteUrl, sitemap, ok: false, status: resp.status, error: errText };
      } catch (err) {
        return {
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
    { ok: !anyFailure, results },
    { status: anyFailure ? 502 : 200 },
  );
}
