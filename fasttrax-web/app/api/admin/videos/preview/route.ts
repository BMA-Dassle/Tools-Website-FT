import { NextRequest, NextResponse } from "next/server";
import { getJwt, invalidateJwt } from "@/lib/vt3";

/**
 * GET /api/admin/videos/preview?code=XXXXX
 *
 * Returns the signed Cloudflare R2 URL for a video's sample (or full
 * MP4 if the video is activated). The R2 URL is directly playable in
 * an HTML5 <video> element and expires 24h after issue, which is plenty
 * of window for the admin UI's modal.
 *
 * The VT3 control panel has two endpoints per video:
 *   /videos/{code}/sample — short preview MP4 (always available once
 *                            sampleUploadTime is set)
 *   /videos/{code}/url    — full MP4 (only after uploadTime is set /
 *                            the video is activated/purchased)
 *
 * We try /url first (better for activated videos) and fall back to
 * /sample if /url 400s with "Video is not uploaded".
 *
 * Auth: middleware gates /api/admin/videos/* on ADMIN_CAMERA_TOKEN.
 */

const VT3_HOST = "https://sys.vt3.io";

async function fetchPreview(code: string, jwt: string, endpoint: "sample" | "url") {
  return fetch(`${VT3_HOST}/videos/${encodeURIComponent(code)}/${endpoint}`, {
    method: "GET",
    headers: {
      authorization: `Bearer ${jwt}`,
      "x-cp-ui": "mui",
      "x-cp-ver": "v2.48.2",
      // Mirror the browser's CORS preflight context so any
      // origin-based checks on the VT3 side don't trip.
      origin: "https://control-panel.vt3.io",
      referer: "https://control-panel.vt3.io/",
    },
    cache: "no-store",
  });
}

export async function GET(req: NextRequest) {
  try {
    const code = (new URL(req.url).searchParams.get("code") || "").trim();
    if (!/^[A-Za-z0-9]{4,16}$/.test(code)) {
      return NextResponse.json({ error: "Invalid code" }, { status: 400 });
    }

    let jwt = await getJwt();

    // 1. Try the full-video URL first.
    let res = await fetchPreview(code, jwt, "url");
    let kind: "url" | "sample" = "url";

    // 2. Not activated yet → fall back to the sample.
    if (res.status === 400) {
      res = await fetchPreview(code, jwt, "sample");
      kind = "sample";
    }

    // 3. Auth expired → refresh JWT and retry the whole flow once.
    if (res.status === 401 || res.status === 403) {
      await invalidateJwt();
      jwt = await getJwt();
      res = await fetchPreview(code, jwt, "url");
      kind = "url";
      if (res.status === 400) {
        res = await fetchPreview(code, jwt, "sample");
        kind = "sample";
      }
    }

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      return NextResponse.json(
        { error: `vt3 ${kind} returned ${res.status}: ${txt.slice(0, 200)}` },
        { status: 502 },
      );
    }

    const data = await res.json();
    const mp4 = data?.url;
    if (!mp4 || typeof mp4 !== "string") {
      return NextResponse.json({ error: "vt3 response missing url" }, { status: 502 });
    }

    return NextResponse.json(
      { ok: true, code, kind, url: mp4 },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    console.error("[admin/videos/preview]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "preview failed" },
      { status: 500 },
    );
  }
}
