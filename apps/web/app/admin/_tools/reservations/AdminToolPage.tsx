import { adminPoppins } from "~/components/features/admin-skin/font";
import ReservationsBoard from "~/components/features/reservations-admin/ReservationsBoard";
import { mintAdminApiToken } from "@/lib/admin-api-token";

/**
 * Bowling reservations board — every reservation for a selected date,
 * filterable by center, with guest info, status, amounts, QAMF ids and lane
 * assignments.
 *
 * THE IMPLEMENTATION, ONCE. Two routes render this component and neither owns
 * it: `/admin/{token}/reservations` (v1 — the static token in the path, kept alive
 * for staff bookmarks, crons and the shell until PR B) and `/admin/reservations`
 * (v2 — a Microsoft SSO session, no credential in the URL at all). Splitting
 * them into two page implementations would guarantee they drift; one of the two
 * would get the next fix and nobody would notice which.
 *
 * The token it hands its client is a SIGNED 8-hour credential
 * (`mintAdminApiToken`), never `ADMIN_CAMERA_TOKEN` — the client sends it back
 * as `x-admin-token` / `?token=` exactly where it always sent one, and the
 * middleware accepts it for `/api/admin/*` only. Pinned by
 * scripts/check-admin-token-leak.mjs.
 */
export default async function AdminToolPage() {
  const apiToken = await mintAdminApiToken();

  return (
    <div className={adminPoppins.variable}>
      <ReservationsBoard token={apiToken} />
    </div>
  );
}
