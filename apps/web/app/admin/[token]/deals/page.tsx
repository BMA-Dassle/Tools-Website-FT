import { notFound } from "next/navigation";
import { adminPoppins } from "~/components/features/admin-skin/font";
import DealsAdminClient from "./DealsAdminClient";
import { mintAdminApiToken } from "@/lib/admin-api-token";

/**
 * Admin: prepaid deal-pack sales.
 *
 * Token-gated by middleware (ADMIN_CAMERA_TOKEN); the page revalidates the param
 * and hands the token to the client for its API calls — same shape as the
 * discount-codes board.
 *
 * URL: /admin/{ADMIN_CAMERA_TOKEN}/deals
 */

export const dynamic = "force-dynamic";
export const revalidate = 0;

type Props = { params: Promise<{ token: string }> };

export default async function Page({ params }: Props) {
  const { token } = await params;
  const expected = process.env.ADMIN_CAMERA_TOKEN || "";
  if (!expected || token !== expected) notFound();

  // The client sends this back as x-admin-token / ?token= for its
  // /api/admin/* calls, exactly where it always sent one — but it is now a
  // signed 8-hour credential, not the permanent ADMIN_CAMERA_TOKEN. The
  // static token never reaches a browser again.
  // (Pinned by scripts/check-admin-token-leak.mjs.)
  const apiToken = await mintAdminApiToken();
  return (
    <div className={adminPoppins.variable}>
      <DealsAdminClient token={apiToken} />
    </div>
  );
}
