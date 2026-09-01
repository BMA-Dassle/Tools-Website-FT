import { adminPoppins } from "~/components/features/admin-skin/font";
import DailyEventsBoardV2 from "~/components/features/daily-events-v2/DailyEventsBoardV2";
import { mintAdminApiToken } from "@/lib/admin-api-token";

/**
 * Daily Events v2 — the group-event day board. Owner-approved hybrid redesign
 * (2026-07-13): banded day sections, two-line rows, needs-attention sentences,
 * per-day money/risk summaries, a Day ⇄ Week (Wed–Tue) toggle.
 *
 * THE IMPLEMENTATION, ONCE. Two routes render this component and neither owns
 * it: `/admin/{token}/daily-events-v2` (v1 — the static token in the path) and
 * `/admin/daily-events-v2` (v2 — a Microsoft SSO session, no credential in the
 * URL at all).
 *
 * NOT the portal's `/admin/embed/daily-events-v2`, which is a separate route
 * behind its own HMAC gate and is unaffected by any of this.
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
      <DailyEventsBoardV2 token={apiToken} />
    </div>
  );
}
