import { notFound } from "next/navigation";
import redis from "@/lib/redis";
import type { GroupEventRsvp } from "@/app/api/group-event/rsvp/route";
import ChristmasRsvpsClient from "./ChristmasRsvpsClient";

/**
 * Admin: Christmas in July RSVP list (both venues) + booked race per guest.
 *
 * Token-gated by middleware (ADMIN_CAMERA_TOKEN) — same key as the other
 * front-desk admin tools. Reads the RSVP records straight from Redis.
 *
 * URL: /admin/{ADMIN_CAMERA_TOKEN}/christmas-in-july
 */

export const dynamic = "force-dynamic";
export const revalidate = 0;

const SLUG = "xmas-in-july";

type Props = { params: Promise<{ token: string }> };

export default async function Page({ params }: Props) {
  const { token } = await params;
  const expected = process.env.ADMIN_CAMERA_TOKEN || "";
  if (!expected || token !== expected) notFound();

  // Pull every RSVP for the event from Redis (index set → individual records).
  const emails = await redis.smembers(`groupevent:${SLUG}:rsvp-index`);
  const rows: GroupEventRsvp[] = [];
  for (const email of emails) {
    const data = await redis.get(`groupevent:${SLUG}:rsvp:${email}`);
    if (data) {
      try {
        rows.push(JSON.parse(data) as GroupEventRsvp);
      } catch {
        /* skip malformed */
      }
    }
  }
  // Newest first.
  rows.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));

  return <ChristmasRsvpsClient rows={rows} />;
}
