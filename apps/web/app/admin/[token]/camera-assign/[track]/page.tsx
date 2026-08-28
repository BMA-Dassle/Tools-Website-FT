import { notFound } from "next/navigation";
import AdminToolPage from "@/app/admin/_tools/camera-assign-track/AdminToolPage";

/**
 * v1: `/admin/{ADMIN_CAMERA_TOKEN}/camera-assign/{blue|red|mega}`.
 *
 * The static token in the path is the credential. Kept alongside the SSO route
 * at `/admin/camera-assign/{track}` (same component, no credential in the URL)
 * per the v2 cutover pattern. The token check below is belt-and-braces with the
 * middleware's unified gate, unchanged from before the split.
 */

export const dynamic = "force-dynamic";
export const revalidate = 0;

type Props = { params: Promise<{ token: string; track: string }> };

export default async function Page({ params }: Props) {
  const { token, track } = await params;
  const expected = process.env.ADMIN_CAMERA_TOKEN || "";
  if (!expected || token !== expected) notFound();

  return <AdminToolPage track={track} />;
}
