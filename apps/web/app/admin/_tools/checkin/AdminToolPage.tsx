import CheckInClient from "@/app/admin/[token]/checkin/CheckInClient";
import { adminPoppins } from "~/components/features/admin-skin/font";
import { mintAdminApiToken } from "@/lib/admin-api-token";
import type { AdminToolQuery } from "@/app/admin/_tools/query";

/**
 * The front-desk check-in station: scan a racer in, watch the session counts,
 * and (with `?board=1`) run the briefing rooms from the same screen.
 *
 * THE IMPLEMENTATION, ONCE. Rendered by both `/admin/{token}/checkin` (v1,
 * static token in the path) and `/admin/checkin` (v2, Microsoft SSO session).
 *
 * The token it hands its client is a SIGNED 8-hour credential, never
 * ADMIN_CAMERA_TOKEN — the client sends it back as `x-admin-token` / `?token=`
 * exactly where it always sent one. (Pinned by check-admin-token-leak.mjs.)
 */
export default async function AdminToolPage({ query }: { query: AdminToolQuery }) {
  const apiToken = await mintAdminApiToken();

  const sha = process.env.VERCEL_GIT_COMMIT_SHA || "";
  const version = sha ? sha.slice(0, 7) : "dev";

  /**
   * `?board=1` ADDS the briefing-room controls to this station.
   *
   * It is a flag on the check-in page, not a different page: the same staff
   * member checks racers in and sends the heat to a briefing room, and the
   * scanner, the session counts and the scan flash all stay exactly as they are.
   */
  const boardMode = query.board === "1";

  /**
   * `?loc=ft|hpfm|naples` scopes the session-counts strip to one building —
   * each desk bookmarks its own URL. View-only: scanning accepts every
   * payload regardless (licence codes and FT QRs carry no location).
   * No `?loc=` (or an unknown value) keeps the all-venues view.
   */
  const locFilter = typeof query.loc === "string" ? query.loc : undefined;

  return (
    <div className={adminPoppins.variable}>
      <CheckInClient
        token={apiToken}
        version={version}
        boardMode={boardMode}
        locFilter={locFilter}
      />
    </div>
  );
}
