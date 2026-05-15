import { notFound } from "next/navigation";
import CameraAssignClient from "../CameraAssignClient";

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

  const trackSlug = track.toLowerCase();
  if (!VALID_TRACKS.includes(trackSlug as (typeof VALID_TRACKS)[number])) notFound();

  return <CameraAssignClient token={token} track={trackSlug} />;
}
