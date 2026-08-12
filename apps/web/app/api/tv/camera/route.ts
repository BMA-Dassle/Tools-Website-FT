import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { signageEnabled, cameraMonitorEnabled } from "~/features/signage/flags";
import { loadSignageScreen } from "~/features/signage/data/signage-screens-db";
import { resolveScreenConfig } from "~/features/signage/defaults";
import { parseScreenKey, type SignageVenue } from "~/features/signage/constants";
import {
  fetchCameraFrame,
  nxConfigured,
  briefingRoomCameraId,
} from "~/features/signage/nx/camera.server";

/**
 * ONE still frame for a camera-monitor board.
 *
 * The board asks about once a second (SceneCameraMonitor). Deliberately NOT a
 * held-open stream: this runs on serverless, where a long-lived proxy is a
 * function killed at its duration cap. Each call returns one JPEG and ends.
 *
 * ALLOWLIST, NOT ARBITRARY CAMERA IDS. Two addressing modes, both constrained:
 *   - `?screen=FT:5` — the camera is read from that screen's saved config
 *     server-side (what an admin put on the board), never from the client.
 *   - `?room=blue|red` — resolves to one of the two fixed briefing-room cameras
 *     (BRIEFING_ROOM_CAMERAS), for the check-in board's in-room panel. No other
 *     camera is reachable this way.
 * Either way a client can only ever reach a camera someone deliberately wired up.
 *
 * PUBLIC, like /api/tv/feed: a TV player has no login. What leaks is one frame of
 * a camera staff already chose to put on a wall, never the Nx token (which stays
 * in camera.server.ts) and never a way to enumerate cameras.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A frame is fresh enough to share for ~1s: many boards / a board's own retries
 *  on the SAME camera collapse to one upstream pull. Keyed by device + size. */
const FRAME_TTL_MS = 900;
const frameCache = new Map<string, { at: number; body: ArrayBuffer; contentType: string }>();

/**
 * Which camera a screen shows, cached briefly so a board polling every second
 * does not read Neon every second. A config change (admin repoints the camera)
 * takes effect within this window — the same order as the TV's own poll cadence,
 * so it never feels stale. `null` caches "provisioned but no camera", so a
 * misconfigured board does not hammer Neon either.
 */
const SCREEN_TTL_MS = 15_000;
const screenCache = new Map<string, { at: number; deviceId: string | null }>();

async function resolveDeviceId(screenId: string): Promise<string | null> {
  const now = Date.now();
  const hit = screenCache.get(screenId);
  if (hit && now - hit.at < SCREEN_TTL_MS) return hit.deviceId;
  const screen = await loadSignageScreen(screenId);
  const deviceId = screen
    ? (resolveScreenConfig(screen.config, screen.venue as SignageVenue).cameraMonitor?.deviceId ??
      null)
    : null;
  screenCache.set(screenId, { at: now, deviceId });
  return deviceId;
}

export async function GET(req: NextRequest) {
  if (!signageEnabled() || !cameraMonitorEnabled()) {
    return new NextResponse(null, { status: 404 });
  }

  const screenId = req.nextUrl.searchParams.get("screen");
  const roomParam = req.nextUrl.searchParams.get("room");
  if (!screenId && !roomParam) {
    return new NextResponse(null, { status: 400 });
  }
  if (screenId && !parseScreenKey(screenId)) {
    return new NextResponse(null, { status: 400 });
  }
  if (!nxConfigured()) {
    // Bridge not set up on this deploy — a distinct code from "no camera" so the
    // board can tell "connecting" from "misconfigured" if it ever wants to.
    return new NextResponse(null, { status: 503 });
  }

  // Screen mode resolves through the saved config (cached); room mode maps to a
  // fixed briefing camera. Both refuse anything they do not recognise.
  const deviceId = screenId ? await resolveDeviceId(screenId) : briefingRoomCameraId(roomParam);
  if (!deviceId) return new NextResponse(null, { status: 404 });

  const w = numParam(req.nextUrl.searchParams.get("w"));
  const h = numParam(req.nextUrl.searchParams.get("h"));
  const key = `${deviceId}@${w ?? 0}x${h ?? 0}`;

  const now = Date.now();
  const hit = frameCache.get(key);
  if (hit && now - hit.at < FRAME_TTL_MS) {
    return frameResponse(hit.body, hit.contentType);
  }

  try {
    const frame = await fetchCameraFrame(deviceId, { width: w, height: h });
    frameCache.set(key, { at: now, body: frame.body, contentType: frame.contentType });
    // Cheap unbounded-growth guard — a handful of boards, a couple of sizes.
    if (frameCache.size > 64) {
      for (const k of frameCache.keys()) {
        frameCache.delete(k);
        if (frameCache.size <= 32) break;
      }
    }
    return frameResponse(frame.body, frame.contentType);
  } catch {
    // A slightly stale last-good frame beats a broken-image icon on a wall.
    if (hit) return frameResponse(hit.body, hit.contentType);
    return new NextResponse(null, { status: 502 });
  }
}

function frameResponse(body: ArrayBuffer, contentType: string): NextResponse {
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      // The board cache-busts with ?t=; never let a proxy or browser pin a frame.
      "Cache-Control": "no-store, max-age=0",
    },
  });
}

function numParam(v: string | null): number | undefined {
  if (!v) return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
