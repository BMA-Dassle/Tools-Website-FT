import { notFound } from "next/navigation";
import AdminToolPage from "@/app/admin/_tools/reservations/AdminToolPage";

/**
 * v1: `/admin/{ADMIN_CAMERA_TOKEN}/reservations`.
 *
 * The static token in the path is the credential. Kept alongside the SSO route
 * at `/admin/reservations` (same component, no credential in the URL) per the v2
 * cutover pattern: ship v2 next to v1, let ops sign off, 308 v1 → v2, delete v1
 * in a third PR. PR B is that third PR.
 *
 * The token check below is belt-and-braces with the middleware's unified gate,
 * unchanged from before the split — a routing change must not quietly expose
 * this.
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
