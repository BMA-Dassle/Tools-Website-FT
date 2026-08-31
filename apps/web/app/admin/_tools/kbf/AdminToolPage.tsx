import { adminPoppins } from "~/components/features/admin-skin/font";
import KbfAdminClient from "@/app/admin/[token]/kbf/KbfAdminClient";
import { mintAdminApiToken } from "@/lib/admin-api-token";
import type { AdminToolQuery } from "@/app/admin/_tools/query";

/**
 * Kids Bowl Free — account lookup, bowler selection, Bowl Now / Book Lane.
 *
 * THE IMPLEMENTATION, ONCE. Two routes render this component and neither owns
 * it: `/admin/{token}/kbf` (v1 — the static token in the path) and `/admin/kbf`
 * (v2 — a Microsoft SSO session, no credential in the URL at all).
 *
 * `?center=` is read HERE and passed down, so the board's first paint is
 * already scoped to the desk's building rather than flashing the default.
 *
 * The token it hands its client is a SIGNED 8-hour credential
 * (`mintAdminApiToken`), never `ADMIN_CAMERA_TOKEN` — the client sends it back
 * as `x-admin-token` / `?token=` exactly where it always sent one, and the
 * middleware accepts it for `/api/admin/*` only. Pinned by
 * scripts/check-admin-token-leak.mjs.
 */
export default async function AdminToolPage({ query }: { query: AdminToolQuery }) {
  const apiToken = await mintAdminApiToken();

  const rawCenter = query.center;
  const initialCenterParam = Array.isArray(rawCenter) ? rawCenter[0] : rawCenter;

  return (
    <div className={adminPoppins.variable}>
      <KbfAdminClient token={apiToken} initialCenterParam={initialCenterParam ?? null} />
    </div>
  );
}
