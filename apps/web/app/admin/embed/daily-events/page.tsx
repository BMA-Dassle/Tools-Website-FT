import { notFound } from "next/navigation";
import { adminPoppins } from "~/components/features/admin-skin/font";
import DailyEventsBoardV2 from "~/components/features/daily-events-v2/DailyEventsBoardV2";
import { mintAdminApiToken } from "@/lib/admin-api-token";

/**
 * Daily Events - portal embed entry point (SAME URL as the old v1 embed;
 * v1 is deleted, this now serves the v2 board so the portal iframe keeps
 * working without a portal-side change).
 *
 * URL: /admin/embed/daily-events?ts=...&sig=...&date=...&location=...
 * HMAC auth in middleware.ts (ADMIN_EMBED_SECRET); ADMIN_CAMERA_TOKEN
 * stays server-side. Initial-state hints via query params; live control
 * via postMessage "daily-events-control"; state/height flow back via
 * "daily-events-state" / "daily-events-resize".
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
      <DailyEventsBoardV2 token={apiToken} embedded />
    </div>
  );
}
