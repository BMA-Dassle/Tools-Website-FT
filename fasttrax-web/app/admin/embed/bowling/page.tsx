import { notFound } from "next/navigation";
import ReservationsClient from "../../[token]/reservations/ReservationsClient";

/**
 * Bowling admin — portal embed entry point.
 *
 * URL: /admin/embed/bowling?ts=...&sig=...
 *
 * HMAC auth is validated in middleware.ts (BOWLING_EMBED_SECRET).
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

  return <ReservationsClient token={token} />;
}
