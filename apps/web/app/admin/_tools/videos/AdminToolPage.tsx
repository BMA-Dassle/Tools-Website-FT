import { adminPoppins } from "~/components/features/admin-skin/font";
import VideoAdminClient from "@/app/admin/[token]/videos/VideoAdminClient";
import { mintAdminApiToken } from "@/lib/admin-api-token";

/**
 * Video resend admin — the match log for every race video, with resend,
 * override-recipient and block controls.
 *
 * THE IMPLEMENTATION, ONCE. Two routes render this component and neither owns
 * it: `/admin/{token}/videos` (v1 — the static token in the path, kept alive for
 * staff bookmarks and the shell) and `/admin/videos` (v2 — a Microsoft SSO
 * session, no credential in the URL at all). Splitting them into two page
 * implementations would guarantee they drift; one of the two would get the next
 * fix and nobody would notice which.
 *
 * WHY THIS TOOL SIGNS IN (owner decision, 2026-08-28). It is a desk tool — a
 * guest at the counter says their video never arrived and somebody at a
 * keyboard finds it and re-sends it. The screen is a list of guest phone
 * numbers and email addresses, and the resend button mails a video link to any
 * address typed into it; the token URL made both of those forwardable.
 *
 * Note it does NOT follow camera-assign, which shares its ADMIN_CAMERA_TOKEN
 * and much of its subject matter but is worked trackside on shared kiosks
 * (`~/lib/constants/admin-tools`). Same cameras, different furniture, different
 * credential.
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
      <VideoAdminClient token={apiToken} />
    </div>
  );
}
