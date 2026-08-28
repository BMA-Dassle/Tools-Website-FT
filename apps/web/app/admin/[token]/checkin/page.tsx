import { notFound } from "next/navigation";
import AdminToolPage from "@/app/admin/_tools/checkin/AdminToolPage";
import type { AdminToolQueryPromise } from "@/app/admin/_tools/query";

/**
 * v1: `/admin/{ADMIN_CAMERA_TOKEN}/checkin`.
 *
 * The static token in the path is the credential. Kept alongside the SSO route
 * at `/admin/checkin` (same component, no credential in the URL) per the v2
 * cutover pattern. The token check below is belt-and-braces with the
 * middleware's unified gate, unchanged from before the split.
 */

export const dynamic = "force-dynamic";
export const revalidate = 0;

type Props = {
  params: Promise<{ token: string }>;
  searchParams: AdminToolQueryPromise;
};

export default async function Page({ params, searchParams }: Props) {
  const { token } = await params;
  const expected = process.env.ADMIN_CAMERA_TOKEN || "";
  if (!expected || token !== expected) notFound();

  return <AdminToolPage query={await searchParams} />;
}
