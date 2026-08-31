import { adminPoppins } from "~/components/features/admin-skin/font";
import SignageAdminClient from "@/app/admin/[token]/signage/SignageAdminClient";
import { mintAdminApiToken } from "@/lib/admin-api-token";

/**
 * Lobby-TV screens — create a TV, say what it is for, tick what it shows, and
 * copy the player URL into the device. Adding or re-purposing a screen never
 * needs a deploy.
 *
 * THE IMPLEMENTATION, ONCE. Two routes render this component and neither owns
 * it: `/admin/{token}/signage` (v1 — the static token in the path) and
 * `/admin/signage` (v2 — a Microsoft SSO session, no credential in the URL).
 *
 * IT IS THE STAFF TOOL, NOT THE SCREEN. This lives on a laptop or a phone (a
 * wall-mounted TV has no input device), so it is desk work and it signs in —
 * unlike the boards it configures, which run on public `/tv/*` routes, and
 * unlike `pit` and `briefing`, which stay on the token for exactly that reason.
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
      <SignageAdminClient token={apiToken} />
    </div>
  );
}
