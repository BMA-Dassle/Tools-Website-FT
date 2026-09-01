import { adminPoppins } from "~/components/features/admin-skin/font";
import WebSalesBoard from "~/components/features/web-sales/WebSalesBoard";
import { mintAdminApiToken } from "@/lib/admin-api-token";
import type { AdminToolQuery } from "@/app/admin/_tools/query";

/**
 * Every non-reservation sale made on the website.
 *
 * THE IMPLEMENTATION, ONCE. Two routes render this component and neither owns
 * it: `/admin/{token}/web-sales` (v1 — the static token in the path) and
 * `/admin/web-sales` (v2 — a Microsoft SSO session, no credential in the URL
 * at all).
 *
 * `searchParams` is read HERE and passed down so the board's first paint
 * already matches the URL. Reading it in the client with `useSearchParams`
 * would force a Suspense boundary and a flash of the unfiltered default.
 *
 * The token it hands its client is a SIGNED 8-hour credential
 * (`mintAdminApiToken`), never `ADMIN_CAMERA_TOKEN` — the client sends it back
 * as `x-admin-token` / `?token=` exactly where it always sent one, and the
 * middleware accepts it for `/api/admin/*` only. Pinned by
 * scripts/check-admin-token-leak.mjs.
 */
export default async function AdminToolPage({ query }: { query: AdminToolQuery }) {
  const apiToken = await mintAdminApiToken();

  const initial = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    // A repeated param arrives as an array; the board's parser reads the comma
    // form, so join rather than dropping every value but the last.
    initial.set(key, Array.isArray(value) ? value.join(",") : value);
  }

  return (
    <div className={adminPoppins.variable}>
      <WebSalesBoard token={apiToken} initialSearch={initial.toString()} />
    </div>
  );
}
