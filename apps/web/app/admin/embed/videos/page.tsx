import { notFound } from "next/navigation";
import { adminPoppins } from "~/components/features/admin-skin/font";
import VideoAdminClient from "../../[token]/videos/VideoAdminClient";
import { mintAdminApiToken } from "@/lib/admin-api-token";

/**
 * Video admin — portal embed entry point.
 *
 * URL: /admin/embed/videos?ts=...&sig=...
 *
 * HMAC auth is validated in middleware.ts (ADMIN_EMBED_SECRET).
 * The static ADMIN_CAMERA_TOKEN never appears in the URL — it's read
 * from env server-side here and passed to the client component, which
 * uses it for API calls.
 *
 * frame-ancestors is set in middleware to lock this page to the portal.
 */

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function Page() {
  const token = process.env.ADMIN_CAMERA_TOKEN || "";
  if (!token) notFound();

  // The client sends this back as x-admin-token / ?token= for its
  // /api/admin/* calls, exactly where it always sent one — but it is now a
  // signed 8-hour credential, not the permanent ADMIN_CAMERA_TOKEN. The
  // static token never reaches a browser again.
  // (Pinned by scripts/check-admin-token-leak.mjs.)
  const apiToken = await mintAdminApiToken();

  return (
    <div className={adminPoppins.variable}>
      <VideoAdminClient token={apiToken} embedded />
    </div>
  );
}
