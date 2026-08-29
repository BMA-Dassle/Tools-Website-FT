import { notFound } from "next/navigation";
import { adminPoppins } from "~/components/features/admin-skin/font";
import SalesAdminClient from "./SalesAdminClient";
import { mintAdminApiToken } from "@/lib/admin-api-token";

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
    (!!cameraToken && token === cameraToken) || (!!legacyToken && token === legacyToken);
  if (!tokenOk) notFound();

  // The client sends this back as x-admin-token / ?token= for its
  // /api/admin/* calls, exactly where it always sent one — but it is now a
  // signed 8-hour credential, not the permanent ADMIN_CAMERA_TOKEN. The
  // static token never reaches a browser again.
  // (Pinned by scripts/check-admin-token-leak.mjs.)
  const apiToken = await mintAdminApiToken();

  return (
    <div className={adminPoppins.variable}>
      <SalesAdminClient token={apiToken} />
    </div>
  );
}
