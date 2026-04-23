import { notFound } from "next/navigation";
import CameraAssignClient from "./CameraAssignClient";

/**
 * Camera-assignment front-desk tool.
 *
 * URL: /admin/{ADMIN_CAMERA_TOKEN}/camera-assign
 *
 * Middleware gates on ADMIN_CAMERA_TOKEN (and optionally ADMIN_ALLOWED_IPS
 * when ADMIN_CAMERA_REQUIRE_IP=1 — off until staff finishes rollout).
 * Server-side double-check below is defense in depth.
 */

export const dynamic = "force-dynamic";
export const revalidate = 0;

type Props = { params: Promise<{ token: string }> };

export default async function Page({ params }: Props) {
  const { token } = await params;
  const expected = process.env.ADMIN_CAMERA_TOKEN || "";
  if (!expected || token !== expected) notFound();

  return <CameraAssignClient token={token} />;
}
