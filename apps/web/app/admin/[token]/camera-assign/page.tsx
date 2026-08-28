import { notFound } from "next/navigation";
import CameraAssignClient from "./CameraAssignClient";
import { adminPoppins } from "~/components/features/admin-skin/font";
import { mintAdminApiToken } from "@/lib/admin-api-token";

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

  // The client sends this back as x-admin-token / ?token= for its
  // /api/admin/* calls, exactly where it always sent one — but it is now a
  // signed 8-hour credential, not the permanent ADMIN_CAMERA_TOKEN. The
  // static token never reaches a browser again.
  // (Pinned by scripts/check-admin-token-leak.mjs.)
  const apiToken = await mintAdminApiToken();

  // Build/deploy version. Vercel auto-populates VERCEL_GIT_COMMIT_SHA
  // on every deployment; we shorten to 7 chars (the conventional Git
  // short SHA) for a compact display string. Falls back to "dev" when
  // running locally without Vercel env.
  const sha = process.env.VERCEL_GIT_COMMIT_SHA || "";
  const version = sha ? sha.slice(0, 7) : "dev";

  return (
    <div className={adminPoppins.variable}>
      <CameraAssignClient token={apiToken} version={version} />
    </div>
  );
}
