import { notFound } from "next/navigation";
import CameraAssignClient from "../CameraAssignClient";
import { adminPoppins } from "~/components/features/admin-skin/font";
import { mintAdminApiToken } from "@/lib/admin-api-token";

/**
 * Track-scoped camera-assignment tool — one kiosk per track.
 *
 * URL: /admin/{ADMIN_CAMERA_TOKEN}/camera-assign/{blue|red|mega}
 *
 * Same middleware gate as the no-track variant (…/camera-assign), just
 * scopes the session-picker to one Pandora resource so different staff
 * can work different tracks at the same time without stepping on each
 * other.
 */

export const dynamic = "force-dynamic";
export const revalidate = 0;

const VALID_TRACKS = ["blue", "red", "mega"] as const;

type Props = { params: Promise<{ token: string; track: string }> };

export default async function Page({ params }: Props) {
  const { token, track } = await params;
  const expected = process.env.ADMIN_CAMERA_TOKEN || "";
  if (!expected || token !== expected) notFound();

  // The client sends this back as x-admin-token / ?token= for its
  // /api/admin/* calls, exactly where it always sent one — but it is now a
  // signed 8-hour credential, not the permanent ADMIN_CAMERA_TOKEN. The
  // static token never reaches a browser again.
  // (Pinned by scripts/check-admin-token-leak.mjs.)
  const apiToken = await mintAdminApiToken();

  const trackSlug = track.toLowerCase();
  if (!VALID_TRACKS.includes(trackSlug as (typeof VALID_TRACKS)[number])) notFound();

  return (
    <div className={adminPoppins.variable}>
      <CameraAssignClient token={apiToken} track={trackSlug} />
    </div>
  );
}
