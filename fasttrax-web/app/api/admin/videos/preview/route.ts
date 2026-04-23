import { NextRequest, NextResponse } from "next/server";

/**
 * GET /api/admin/videos/preview?code=XXXXX
 *
 * Returns a signed Cloudflare R2 URL for a video (either the full MP4
 * if the video has been activated, else the sample). The R2 URL is
 * directly playable in an HTML5 <video> element and expires 24h after
 * issue.
 *
 * Uses vt3.io's PUBLIC video-check endpoint — `/videos/code/{code}/check`
 * — the same one `https://vt3.io/?code=...` (the customer-facing video
 * page) uses. It takes no auth, just the right Origin/Referer
 * (`https://vt3.io`), and returns a JSON body with both the full-video
 * URL (if uploaded) and a sample URL (always present once the cube has
 * streamed anything).
 *
 * We previously tried the authenticated admin endpoint
 * `/videos/{code}/sample`, which returns 403 to any server-side caller
 * regardless of bearer auth — a TLS-fingerprint WAF rule blocks
 * non-browser clients. The public /check endpoint has no such rule,
 * so this is both simpler and more robust.
 *
 * Auth: middleware gates /api/admin/videos/* on ADMIN_CAMERA_TOKEN.
 */

const VT3_HOST = "https://sys.vt3.io";

interface Vt3CheckResponse {
  video?: {
    code: string;
    fileName?: string;
    duration?: number;
    camera?: number;
    locked?: boolean;
    uploadTime?: string | null;
    sampleUploadTime?: string | null;
    /** Full-length MP4 signed URL. Present once the cube finishes
     *  uploading the full video (post-activation). */
    url?: string | null;
    /** Sample/preview MP4 wrapper. Populated once the cube streams the
     *  first chunk, so available for PENDING_ACTIVATION videos too. */
    sample?: { url?: string | null } | null;
  };
}

export async function GET(req: NextRequest) {
  try {
    const code = (new URL(req.url).searchParams.get("code") || "").trim();
    if (!/^[A-Za-z0-9]{4,16}$/.test(code)) {
      return NextResponse.json({ error: "Invalid code" }, { status: 400 });
    }

    const res = await fetch(`${VT3_HOST}/videos/code/${encodeURIComponent(code)}/check`, {
      method: "GET",
      headers: {
        accept: "application/json, text/plain, */*",
        "accept-language": "en-US,en;q=0.9",
        origin: "https://vt3.io",
        referer: "https://vt3.io/",
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
      },
      cache: "no-store",
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      return NextResponse.json(
        { error: `vt3 check returned ${res.status}: ${txt.slice(0, 200)}` },
        { status: 502 },
      );
    }

    const data = (await res.json()) as Vt3CheckResponse;
    const vid: NonNullable<Vt3CheckResponse["video"]> = data.video || ({} as NonNullable<Vt3CheckResponse["video"]>);
    // Prefer the full-length URL when present; most videos beyond
    // PENDING_ACTIVATION will have this. Fall back to the sample for
    // locked / pre-upload videos.
    const fullUrl = vid.url ?? null;
    const sampleUrl = (vid.sample && vid.sample.url) || null;
    const mp4 = fullUrl || sampleUrl;

    if (!mp4) {
      return NextResponse.json(
        { error: "vt3 /check returned no playable URL for this code" },
        { status: 502 },
      );
    }

    return NextResponse.json(
      {
        ok: true,
        code,
        kind: fullUrl ? ("url" as const) : ("sample" as const),
        url: mp4,
        locked: vid.locked,
        uploadTime: vid.uploadTime,
      },
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
