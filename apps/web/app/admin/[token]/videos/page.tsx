import { notFound } from "next/navigation";
import VideoAdminClient from "./VideoAdminClient";

/**
 * Video resend admin.
 *
 * URL: /admin/{ADMIN_CAMERA_TOKEN}/videos
 *
 * Middleware gates on ADMIN_CAMERA_TOKEN (shared with the camera-assign
 * tool — same staff, same workflow). Server-side double-check below.
 */

export const dynamic = "force-dynamic";
export const revalidate = 0;

type Props = { params: Promise<{ token: string }> };

export default async function Page({ params }: Props) {
  const { token } = await params;
  const expected = process.env.ADMIN_CAMERA_TOKEN || "";
  if (!expected || token !== expected) notFound();

  return <VideoAdminClient token={token} />;
}
