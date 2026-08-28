import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { isBriefingAssetKey, type BriefingAssetKey } from "~/features/signage/briefing/types";
import { isAdminApiRequest } from "@/lib/admin-request-auth";

/**
 * Client-upload tokens for briefing videos.
 *
 * WHY A TOKEN ROUTE AND NOT A NORMAL UPLOAD. A serverless request body is capped
 * at 4.5 MB on Vercel, and a briefing film is hundreds of megabytes — so the
 * bytes cannot come through our own function at all. Instead the browser asks
 * this route for a short-lived, tightly-scoped token and streams the file
 * straight to the blob store. The only thing we handle is the permission.
 *
 * `onUploadCompleted` IS DELIBERATELY NOT LOAD-BEARING. Vercel calls it from its
 * own infrastructure, which carries no admin token — and every /api/admin/* path
 * is gated in middleware, so that callback would be 404'd before it arrived. (It
 * also never fires against localhost, so it could not be developed against
 * either.) The manifest row is therefore written by a confirm-POST from the same
 * authenticated admin page that started the upload — see
 * /api/admin/briefing `save-asset`.
 *
 * Auth: middleware already gates this path on ADMIN_CAMERA_TOKEN. The inline
 * check is belt-and-suspenders, matching /api/admin/signage — this route hands
 * out write credentials to a bucket, so it is the last place to rely on a single
 * gate.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 1.5 GB. Comfortably above a long 4K briefing film and far below the store's
 *  5 TB ceiling — a cap exists so a mis-picked file cannot quietly upload a
 *  disk image. */
const MAX_VIDEO_BYTES = 1_500 * 1_024 * 1_024;
/** Posters are a graphic, not a film. */
const MAX_IMAGE_BYTES = 25 * 1_024 * 1_024;

/**
 * Both accepted, because the briefing films are edited and handed over as .mov
 * (owner 2026-08-11).
 *
 * .MOV IS A CONTAINER, NOT A CODEC, and that is the whole subtlety. QuickTime and
 * MP4 are both ISO base-media derivatives, so a .mov holding H.264/AAC plays in
 * Edge exactly like an .mp4 — but the same extension can hold ProRes (never
 * playable in a browser) or HEVC (needs a paid Microsoft extension the players do
 * not have). Master exports out of an editor are very often one of those two.
 *
 * So the extension is NOT the gate. The real gate is the browser-side decode
 * probe the admin page runs before the upload starts — see readVideoMeta in
 * BriefingAssetManager. That runs in the same engine as the players, so if it can
 * decode a frame, the wall can too. This list only has to be permissive enough to
 * let a genuine .mov through.
 */
const VIDEO_TYPES = ["video/mp4", "video/quicktime"];
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];
/** The welcome-back jingle. A jingle, not a podcast — the cap says so. */
const AUDIO_TYPES = ["audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/mp4"];
const MAX_AUDIO_BYTES = 25 * 1_024 * 1_024;

/**
 * Defense in depth behind the middleware gate — see lib/admin-request-auth.
 * Accepts the static ADMIN_CAMERA_TOKEN (crons, scripts), a signed
 * short-lived token (what staff browsers now hold), or the SSO shell's
 * proxy key. Async because signature checks are Web Crypto.
 */
async function authed(req: NextRequest): Promise<boolean> {
  return isAdminApiRequest(req);
}

export async function POST(req: NextRequest) {
  if (!(await authed(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: HandleUploadBody;
  try {
    body = (await req.json()) as HandleUploadBody;
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  try {
    const result = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        // The client says which slot it is filling; that decides the size cap and
        // the content types. An unknown slot is refused outright rather than
        // defaulting to the permissive one.
        const key = parseAssetKey(clientPayload);
        if (!key) throw new Error("unknown asset key");
        if (!pathname.startsWith("briefing/")) throw new Error("bad pathname");

        const isVideo = key.startsWith("briefing-video:");
        const isAudio = key === "welcome-back-audio" || key === "welcome-back-linger-audio";
        return {
          allowedContentTypes: isVideo ? VIDEO_TYPES : isAudio ? AUDIO_TYPES : IMAGE_TYPES,
          maximumSizeInBytes: isVideo
            ? MAX_VIDEO_BYTES
            : isAudio
              ? MAX_AUDIO_BYTES
              : MAX_IMAGE_BYTES,
          // A NEW URL PER UPLOAD is the whole cache-invalidation strategy: the
          // players compare URLs to decide whether they already hold a file, so
          // an overwrite-in-place would leave every screen playing the old film
          // from its cache forever.
          addRandomSuffix: true,
          // Long cache life is safe precisely because the URL is unique.
          cacheControlMaxAge: 31 * 24 * 60 * 60,
          tokenPayload: key,
        };
      },
      onUploadCompleted: async () => {
        // Unreachable in this deployment — see the header. Present because the
        // SDK's types expect it, and logging is all it may ever do.
      },
    });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "upload failed" },
      { status: 400 },
    );
  }
}

function parseAssetKey(clientPayload: string | null): BriefingAssetKey | null {
  if (!clientPayload) return null;
  // Sent as a bare string rather than JSON — one field, and a parse step here
  // would be another failure mode between a staff member and an upload.
  return isBriefingAssetKey(clientPayload) ? clientPayload : null;
}
