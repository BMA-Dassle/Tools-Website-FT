import { notFound } from "next/navigation";
import AdminToolPage from "@/app/admin/_tools/daily-events-v2/AdminToolPage";

/**
 * v1: `/admin/{ADMIN_CAMERA_TOKEN}/daily-events-v2`.
 *
 * The static token in the path is the credential. Kept alongside the SSO route
 * at `/admin/daily-events-v2` (same component, no credential in the URL) per
 * the v2 cutover pattern; the middleware 307s this URL to the clean one.
 *
 * The token check below is belt-and-braces with the middleware's unified gate,
 * unchanged from before the split. `/admin/embed/daily-events-v2` — the
 * portal's HMAC iframe — is a different route and is untouched by any of this.
 */

export const dynamic = "force-dynamic";
export const revalidate = 0;

type Props = { params: Promise<{ token: string }> };

export default async function Page({ params }: Props) {
  const { token } = await params;
  const expected = process.env.ADMIN_CAMERA_TOKEN || "";
  if (!expected || token !== expected) notFound();

  return <AdminToolPage />;
}
