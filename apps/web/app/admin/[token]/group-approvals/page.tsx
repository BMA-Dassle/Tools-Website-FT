import { notFound } from "next/navigation";
import AdminToolPage from "@/app/admin/_tools/group-approvals/AdminToolPage";

/**
 * v1: `/admin/{ADMIN_CAMERA_TOKEN}/group-approvals`.
 *
 * The static token in the path is the credential. Kept alongside the SSO route
 * at `/admin/group-approvals` (same component, no credential in the URL) per
 * the v2 cutover pattern; the middleware 307s this URL to the clean one.
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
