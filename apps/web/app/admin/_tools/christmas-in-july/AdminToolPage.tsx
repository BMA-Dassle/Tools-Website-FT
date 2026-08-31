import redis from "@/lib/redis";
import type { GroupEventRsvp } from "@/app/api/group-event/rsvp/route";
import { adminPoppins } from "~/components/features/admin-skin/font";
import ChristmasRsvpsClient from "@/app/admin/[token]/christmas-in-july/ChristmasRsvpsClient";

/**
 * Christmas in July RSVP list (both venues) + the booked race per guest.
 *
 * THE IMPLEMENTATION, ONCE. Two routes render this component and neither owns
 * it: `/admin/{token}/christmas-in-july` (v1 — the static token in the path)
 * and `/admin/christmas-in-july` (v2 — a Microsoft SSO session, no credential
 * in the URL at all).
 *
 * Reads the RSVP records straight from Redis and hands the rows down. No
 * `mintAdminApiToken()`: the client renders server-fetched rows and calls no
 * `/api/admin/*` endpoint, so there is no credential to give it.
 */

const SLUG = "xmas-in-july";

export default async function AdminToolPage() {
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

  return (
    <div className={adminPoppins.variable}>
      <ChristmasRsvpsClient rows={rows} />
    </div>
  );
}
