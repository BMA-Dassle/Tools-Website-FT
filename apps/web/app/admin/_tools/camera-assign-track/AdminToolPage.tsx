import { notFound } from "next/navigation";
import CameraAssignClient from "@/app/admin/[token]/camera-assign/CameraAssignClient";
import { adminPoppins } from "~/components/features/admin-skin/font";
import { mintAdminApiToken } from "@/lib/admin-api-token";

/**
 * Track-scoped camera-assignment tool — one kiosk per track.
 *
 * Same board as `/camera-assign`, just scoped to one Pandora resource so
 * different staff can work Blue, Red and Mega at the same time without stepping
 * on each other.
 *
 * THE IMPLEMENTATION, ONCE. Rendered by both
 * `/admin/{token}/camera-assign/{track}` (v1) and `/admin/camera-assign/{track}`
 * (v2, Microsoft SSO session). The directory is `_tools/camera-assign-track`
 * rather than nested under `_tools/camera-assign` so the shared modules stay a
 * flat, greppable list of one directory per ROUTE.
 *
 * The token it hands its client is a SIGNED 8-hour credential, never
 * ADMIN_CAMERA_TOKEN. (Pinned by scripts/check-admin-token-leak.mjs.)
 */

const VALID_TRACKS = ["blue", "red", "mega"] as const;

export default async function AdminToolPage({ track }: { track: string }) {
  const apiToken = await mintAdminApiToken();

  const trackSlug = track.toLowerCase();
  if (!VALID_TRACKS.includes(trackSlug as (typeof VALID_TRACKS)[number])) notFound();

  return (
    <div className={adminPoppins.variable}>
      <CameraAssignClient token={apiToken} track={trackSlug} />
    </div>
  );
}
