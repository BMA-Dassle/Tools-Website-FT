import { notFound } from "next/navigation";
import { adminPoppins } from "~/components/features/admin-skin/font";
import DealsAdminClient from "./DealsAdminClient";

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
  return (
    <div className={adminPoppins.variable}>
      <DealsAdminClient token={token} />
    </div>
  );
}
