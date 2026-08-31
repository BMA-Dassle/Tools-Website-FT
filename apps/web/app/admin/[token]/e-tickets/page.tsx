import { notFound } from "next/navigation";
import AdminToolPage from "@/app/admin/_tools/e-tickets/AdminToolPage";

/**
 * v1: `/admin/{ADMIN_CAMERA_TOKEN}/e-tickets`.
 *
 * The static token in the path is the credential. Kept alongside the SSO route
 * at `/admin/e-tickets` (same component, no credential in the URL) per the v2
 * cutover pattern: ship v2 next to v1, let ops sign off, 308 v1 → v2, delete v1
 * in a third PR. This route stays live until an explicit owner "pull it".
 *
 * The token check below is belt-and-braces with the middleware's unified gate,
 * unchanged from before the split — a routing change must not quietly expose
 * this.
 *
 * Legacy `ADMIN_ETICKETS_TOKEN` is still accepted server-side as a soft alias
 * during the bookmark-rotation window; middleware also 308-redirects legacy
 * URLs to the canonical token at request time. That alias is this route's
 * business alone — the SSO route has no token to alias.
 */

export const dynamic = "force-dynamic"; // never static — auth depends on request
export const revalidate = 0;

type Props = { params: Promise<{ token: string }> };

export default async function Page({ params }: Props) {
  const { token } = await params;

  // Server-side defense in depth. Token-only — no IP allowlist.
  const cameraToken = process.env.ADMIN_CAMERA_TOKEN || "";
  const legacyToken = process.env.ADMIN_ETICKETS_TOKEN || "";
  const tokenOk =
    (!!cameraToken && token === cameraToken) || (!!legacyToken && token === legacyToken);
  if (!tokenOk) notFound();

  return <AdminToolPage />;
}
