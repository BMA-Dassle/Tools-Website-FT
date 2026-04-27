import { notFound } from "next/navigation";
import SalesAdminClient from "./SalesAdminClient";

/**
 * Sales / web-reservations admin page.
 *
 * Guarded by middleware.ts (unified ADMIN_CAMERA_TOKEN). This page
 * double-checks server-side as defense-in-depth — same pattern as
 * the e-ticket and videos admin pages.
 *
 * URL shape: /admin/{ADMIN_CAMERA_TOKEN}/sales
 *
 * Powered by /api/admin/sales/list which reads sales:log:{date}
 * keyed entries. Every confirmed reservation since the deploy of
 * lib/sales-log.ts is captured.
 */

export const dynamic = "force-dynamic"; // never static — auth depends on request
export const revalidate = 0;

type Props = { params: Promise<{ token: string }> };

export default async function Page({ params }: Props) {
  const { token } = await params;
  const cameraToken = process.env.ADMIN_CAMERA_TOKEN || "";
  const legacyToken = process.env.ADMIN_ETICKETS_TOKEN || "";
  const tokenOk =
    (!!cameraToken && token === cameraToken) ||
    (!!legacyToken && token === legacyToken);
  if (!tokenOk) notFound();

  return <SalesAdminClient token={token} />;
}
