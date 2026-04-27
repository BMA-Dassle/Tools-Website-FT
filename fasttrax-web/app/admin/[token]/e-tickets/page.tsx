import { notFound } from "next/navigation";
import EticketAdminClient from "./EticketAdminClient";

/**
 * E-ticket admin page for front-desk staff.
 *
 * Guarded by middleware.ts (unified ADMIN_CAMERA_TOKEN). This page
 * double-checks server-side so if middleware is ever bypassed, we
 * fail closed. The client side then drives filter state + resend
 * actions via /api/admin/e-tickets/{list,resend}.
 *
 * URL shape: /admin/{ADMIN_CAMERA_TOKEN}/e-tickets
 *
 * Legacy ADMIN_ETICKETS_TOKEN is also accepted server-side as a soft
 * alias during the bookmark-rotation window. Middleware also
 * 308-redirects legacy URLs to the canonical token at request time.
 */

export const dynamic = "force-dynamic"; // never static — auth depends on request
export const revalidate = 0;

type Props = { params: Promise<{ token: string }> };

export default async function Page({ params }: Props) {
  const { token } = await params;

  // Server-side defense in depth. Token-only — no IP allowlist.
  const cameraToken = process.env.ADMIN_CAMERA_TOKEN || "";
  const legacyToken = process.env.ADMIN_ETICKETS_TOKEN || "";
  const tokenOk =
    (!!cameraToken && token === cameraToken) ||
    (!!legacyToken && token === legacyToken);
  if (!tokenOk) notFound();

  return <EticketAdminClient token={token} />;
}
