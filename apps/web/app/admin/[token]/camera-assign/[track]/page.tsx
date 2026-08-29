import { notFound } from "next/navigation";
import CameraAssignClient from "../CameraAssignClient";
import { adminPoppins } from "~/components/features/admin-skin/font";
import { mintAdminApiToken } from "@/lib/admin-api-token";

/**
 * Track-scoped camera-assignment tool — one kiosk per track.
 *
 * URL: /admin/{ADMIN_CAMERA_TOKEN}/camera-assign/{blue|red|mega} — the ONLY
 * URL. Same board as the un-scoped page, narrowed to one Pandora resource so
 * different staff can work Blue, Red and Mega at the same time without stepping
 * on each other.
 *
 * NO SSO ROUTE, and this page is the clearest illustration of why: "one kiosk
 * per track" IS the reason. Three shared, standing-height devices, worked
 * between heats, are not three desks — see the sibling page and
 * `~/lib/constants/admin-tools` for the owner decision (2026-08-28).
 *
 * The token check below is belt-and-braces with the middleware's unified gate.
 */

export const dynamic = "force-dynamic";
export const revalidate = 0;

const VALID_TRACKS = ["blue", "red", "mega"] as const;

type Props = { params: Promise<{ token: string; track: string }> };

export default async function Page({ params }: Props) {
  const { token, track } = await params;
  const expected = process.env.ADMIN_CAMERA_TOKEN || "";
  if (!expected || token !== expected) notFound();

  // Signed 8-hour credential, never the static token. (Pinned by
  // scripts/check-admin-token-leak.mjs.)
  const apiToken = await mintAdminApiToken();

  const trackSlug = track.toLowerCase();
  if (!VALID_TRACKS.includes(trackSlug as (typeof VALID_TRACKS)[number])) notFound();

  return (
    <div className={adminPoppins.variable}>
      <CameraAssignClient token={apiToken} track={trackSlug} />
    </div>
  );
}
