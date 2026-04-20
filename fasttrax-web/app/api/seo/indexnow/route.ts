import { NextRequest, NextResponse } from "next/server";
import { submitSitemapUrls, type IndexNowResult } from "@/lib/indexnow";

/**
 * POST /api/seo/indexnow
 *
 * Submits every URL from both sitemaps to IndexNow, which pushes them
 * to Bing, Yandex, Seznam, Naver, Yep, and any other participating
 * search engines (see https://www.indexnow.org/searchengines.json).
 *
 * Auth: x-dev-secret = PORTAL_FORWARD_SECRET.
 * Requires env var: INDEXNOW_KEY (8-128 hex chars).
 * Requires public file: public/{INDEXNOW_KEY}.txt containing just the key
 * — served automatically on both domains because middleware's root-
 * metadata bypass lets root-level .txt files through.
 *
 * Response shape:
 *   { ok, results: [{ host, urlCount, ok, status, error? }, ...] }
 */

const DOMAINS = [
  { host: "fasttraxent.com", sitemap: "https://fasttraxent.com/sitemap.xml" },
  { host: "headpinz.com", sitemap: "https://headpinz.com/sitemap.xml" },
];

export async function POST(req: NextRequest) {
  const expected = process.env.PORTAL_FORWARD_SECRET || "";
  const got = req.headers.get("x-dev-secret") || "";
  if (!expected || got !== expected) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const results: IndexNowResult[] = await Promise.all(
    DOMAINS.map(({ host, sitemap }) => submitSitemapUrls(host, sitemap)),
  );

  const anyFailure = results.some((r) => !r.ok);
  return NextResponse.json(
    { ok: !anyFailure, results },
    { status: anyFailure ? 502 : 200 },
  );
}
