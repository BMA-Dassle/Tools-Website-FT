import { notFound } from "next/navigation";
import { adminPoppins } from "~/components/features/admin-skin/font";
import DailyEventsBoardV2 from "~/components/features/daily-events-v2/DailyEventsBoardV2";
import { mintAdminApiToken } from "@/lib/admin-api-token";

/**
 * Daily Events v2 — portal embed entry point.
 *
 * URL: /admin/embed/daily-events-v2?ts=...&sig=...&date=YYYY-MM-DD
 *        &location=332160&view=week&theme=light
 *
 * HMAC auth is validated in middleware.ts (ADMIN_EMBED_SECRET; ts+sig,
 * 15-min window). The static ADMIN_CAMERA_TOKEN never appears in the
 * URL — it's read from env server-side here and passed to the client
 * component, which uses it for API calls. `date`/`location`/`view`/
 * `theme` are unsigned initial-state hints (the page itself is already
 * HMAC-gated), and the portal keeps theme live via postMessage.
 *
 * Embedded chrome: the portal owns date/location context, so the date
 * nav, location pills, and the v1-board link are hidden (owner
 * 2026-07-13); Day⇄Week and the Cancelled toggle stay.
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
      <DailyEventsBoardV2 token={apiToken} embedded />
    </div>
  );
}
