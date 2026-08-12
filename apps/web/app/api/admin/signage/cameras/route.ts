import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { listCameras, nxConfigured } from "~/features/signage/nx/camera.server";

/**
 * The camera list, for the picker on the Lobby TVs admin page.
 *
 * Token-gated on ADMIN_CAMERA_TOKEN — the same gate as the rest of /api/admin/
 * signage. Returns camera ids + names + area only; no stream tokens, no
 * credentials. Separate route from the main signage one so the (occasionally
 * slow) call out to Nx never sits in front of the fast screen-list load.
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
  if (!nxConfigured()) {
    // Not an error the admin can fix from here — say so plainly so the picker can
    // show "camera bridge not configured" instead of an empty dropdown.
    return NextResponse.json({ cameras: [], configured: false });
  }
  try {
    const cameras = await listCameras();
    return NextResponse.json(
      { cameras, configured: true },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : "camera list failed",
        cameras: [],
        configured: true,
      },
      { status: 502 },
    );
  }
}
