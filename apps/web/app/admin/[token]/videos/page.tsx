import { notFound } from "next/navigation";
import AdminToolPage from "@/app/admin/_tools/videos/AdminToolPage";

/**
 * v1: `/admin/{ADMIN_CAMERA_TOKEN}/videos`.
 *
 * The static token in the path is the credential. Kept alongside the SSO route
 * at `/admin/videos` (same component, no credential in the URL) per the v2
 * cutover pattern. This route stays live until an explicit owner "pull it".
 *
 * The token check below is belt-and-braces with the middleware's unified gate,
 * unchanged from before the split.
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
