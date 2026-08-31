import { notFound } from "next/navigation";
import AdminToolPage from "@/app/admin/_tools/sales/AdminToolPage";

/**
 * v1: `/admin/{ADMIN_CAMERA_TOKEN}/sales`.
 *
 * The static token in the path is the credential. Kept alongside the SSO route
 * at `/admin/sales` (same component, no credential in the URL) per the v2
 * cutover pattern; the middleware 307s this URL to the clean one.
 *
 * Legacy `ADMIN_ETICKETS_TOKEN` is still accepted server-side as a soft alias
 * during the bookmark-rotation window, unchanged from before the split. That
 * alias is this route's business alone — the SSO route has no token to alias.
 */

export const dynamic = "force-dynamic"; // never static — auth depends on request
export const revalidate = 0;

type Props = { params: Promise<{ token: string }> };

export default async function Page({ params }: Props) {
  const { token } = await params;
  const cameraToken = process.env.ADMIN_CAMERA_TOKEN || "";
  const legacyToken = process.env.ADMIN_ETICKETS_TOKEN || "";
  const tokenOk =
    (!!cameraToken && token === cameraToken) || (!!legacyToken && token === legacyToken);
  if (!tokenOk) notFound();

  return <AdminToolPage />;
}
