import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { signageEnabled, cameraMonitorEnabled } from "~/features/signage/flags";
import {
  cameraLiveStream,
  nxConfigured,
  resolveFixedCamera,
} from "~/features/signage/nx/camera.server";

/**
 * ONE live-stream URL for a briefing-room or holding-area camera, for the
 * check-in board's full-screen viewer.
 *
 * WHY A URL AND NOT A STREAM. Every other camera surface here is a still pulled
 * through /api/tv/camera, because a serverless function cannot hold a video stream
 * open — it would be killed at the duration cap and billed for the privilege. Live
 * video therefore has to be played by the BROWSER, straight from Nx's relay, and
 * this route exists only to hand it a credential that is safe to put in a URL: a
 * single-use Nx login ticket (see cameraLiveStream for the live probe behind it).
 *
 * ADMIN-GATED, unlike the still proxy. /api/tv/camera is deliberately public — a
 * TV player has no login, and what it leaks is one frame of a camera staff already
 * put on a wall. A live stream of a room full of guests is a different thing, so
 * this one sits behind ADMIN_CAMERA_TOKEN like the rest of /api/admin/*, with the
 * inline check repeated (same posture as /api/admin/briefing).
 *
 * ROOM, NEVER A DEVICE ID. The client names a room (or a holding area); the
 * server maps it to one of the allowlisted cameras. There is no way to point
 * this at anything else.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authed(req: NextRequest): boolean {
  const expected = process.env.ADMIN_CAMERA_TOKEN || "";
  if (!expected) return false;
  const token = req.nextUrl.searchParams.get("token") || req.headers.get("x-admin-token") || "";
  return token === expected;
}

export async function GET(req: NextRequest) {
  if (!authed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!signageEnabled() || !cameraMonitorEnabled()) {
    return NextResponse.json({ error: "camera monitor is switched off" }, { status: 404 });
  }
  if (!nxConfigured()) {
    // Distinct from "no such camera", so the viewer can fall back to stills
    // quietly rather than treating an unconfigured deploy as a failure.
    return NextResponse.json({ error: "nx bridge not configured" }, { status: 503 });
  }

  const camera = await resolveFixedCamera(req.nextUrl.searchParams.get("room"));
  if (!camera) {
    return NextResponse.json(
      { error: "room must be red, blue, holding-red or holding-blue" },
      { status: 400 },
    );
  }

  try {
    // The holding cameras carry their layout's saved aim — see DewarpView. Live
    // video is transcoded anyway, so the dewarp rides along for free and the
    // full-screen view matches the picture the panel was showing.
    const stream = await cameraLiveStream(camera.deviceId, { dewarp: camera.dewarp });
    return NextResponse.json(stream, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    // The viewer falls back to the still refresh, which is why this is a plain
    // 502 and not something the desk has to read.
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "nx unavailable" },
      { status: 502 },
    );
  }
}
