import { adminPoppins } from "~/components/features/admin-skin/font";
import CameraAssignClient from "@/app/admin/[token]/camera-assign/CameraAssignClient";
import { mintAdminApiToken } from "@/lib/admin-api-token";

/**
 * Camera-assignment front-desk tool — pick the Pandora session a racer's
 * video belongs to.
 *
 * THE IMPLEMENTATION, ONCE. Two routes render this component and neither owns
 * it: `/admin/{token}/camera-assign` (v1 — the static token in the path, kept alive
 * for staff bookmarks, crons and the shell until PR B) and `/admin/camera-assign`
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

  const sha = process.env.VERCEL_GIT_COMMIT_SHA || "";
  const version = sha ? sha.slice(0, 7) : "dev";

  return (
    <div className={adminPoppins.variable}>
      <CameraAssignClient token={apiToken} version={version} />
    </div>
  );
}
