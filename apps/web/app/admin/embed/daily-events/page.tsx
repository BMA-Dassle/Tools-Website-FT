import { notFound } from "next/navigation";
import { adminPoppins } from "~/components/features/admin-skin/font";
import DailyEventsBoardV2 from "~/components/features/daily-events-v2/DailyEventsBoardV2";

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

  return (
    <div className={adminPoppins.variable}>
      <DailyEventsBoardV2 token={token} embedded />
    </div>
  );
}
