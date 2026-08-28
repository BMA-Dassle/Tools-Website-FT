import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { listCameras, nxConfigured } from "~/features/signage/nx/camera.server";
import { isAdminApiRequest } from "@/lib/admin-request-auth";

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

/**
 * Defense in depth behind the middleware gate — see lib/admin-request-auth.
 * Accepts the static ADMIN_CAMERA_TOKEN (crons, scripts), a signed
 * short-lived token (what staff browsers now hold), or the SSO shell's
 * proxy key. Async because signature checks are Web Crypto.
 */
async function authed(req: NextRequest): Promise<boolean> {
  return isAdminApiRequest(req);
}

export async function GET(req: NextRequest) {
  if (!(await authed(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
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
