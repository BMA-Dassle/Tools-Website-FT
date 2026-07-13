import { notFound } from "next/navigation";
import DailyEventsBoard from "~/components/features/daily-events/DailyEventsBoard";

/**
 * Daily Events admin — portal embed entry point.
 *
 * URL: /admin/embed/daily-events?ts=...&sig=...&location=332160&theme=light
 *
 * HMAC auth is validated in middleware.ts (ADMIN_EMBED_SECRET).
 * The static ADMIN_CAMERA_TOKEN never appears in the URL — it's read
 * from env server-side here and passed to the client component, which
 * uses it for API calls. `location`/`date`/`theme` are unsigned
 * initial-state hints (the page itself is already HMAC-gated).
 *
 * frame-ancestors is set in middleware to lock this page to the portal.
 */

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function Page() {
  const token = process.env.ADMIN_CAMERA_TOKEN || "";
  if (!token) notFound();

  return <DailyEventsBoard token={token} />;
}
