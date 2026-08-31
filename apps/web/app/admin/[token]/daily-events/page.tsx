import { notFound } from "next/navigation";
import AdminToolPage from "@/app/admin/_tools/daily-events/AdminToolPage";
import type { AdminToolQueryPromise } from "@/app/admin/_tools/query";

/**
 * v1: `/admin/{ADMIN_CAMERA_TOKEN}/daily-events` — the v1 → v2 redirect shim.
 *
 * The static token in the path is the credential. Kept alongside the SSO route
 * at `/admin/daily-events` (same shim, no credential in the URL) per the v2
 * cutover pattern; the middleware 307s this URL to the clean one, so what
 * lands here is a client that does not follow redirects, or the kill switch.
 *
 * The token check below is belt-and-braces with the middleware's unified gate,
 * unchanged from before the split. The redirect TARGET has never carried the
 * token and still does not — see the shared module.
 */

export const dynamic = "force-dynamic";

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
