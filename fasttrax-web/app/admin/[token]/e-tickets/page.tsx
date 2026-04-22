import { notFound } from "next/navigation";
import { headers } from "next/headers";
import EticketAdminClient from "./EticketAdminClient";

/**
 * E-ticket admin page for front-desk staff.
 *
 * Guarded by middleware.ts (token in URL + IP allowlist). This page
 * double-checks on the server side too so if middleware is ever
 * bypassed, we fail closed. The client side then drives filter state +
 * resend actions via /api/admin/e-tickets/{list,resend}.
 *
 * URL shape: /admin/{ADMIN_ETICKETS_TOKEN}/e-tickets
 */

export const dynamic = "force-dynamic"; // never static — auth depends on request
export const revalidate = 0;

type Props = { params: Promise<{ token: string }> };

export default async function Page({ params }: Props) {
  const { token } = await params;

  // Server-side double-check (defense in depth). Middleware should've
  // already filtered, but if a future config change opens the gate we
  // don't want this page rendering to anyone.
  const expected = process.env.ADMIN_ETICKETS_TOKEN || "";
  if (!expected || token !== expected) notFound();

  const hdrs = await headers();
  const xff = hdrs.get("x-forwarded-for") || "";
  const ip = xff.split(",")[0]?.trim() || hdrs.get("x-real-ip") || "";
  const allowed = new Set(
    (process.env.ADMIN_ALLOWED_IPS || "").split(",").map((s) => s.trim()).filter(Boolean),
  );
  if (allowed.size > 0 && (!ip || !allowed.has(ip))) notFound();

  return <EticketAdminClient token={token} />;
}
