import { notFound } from "next/navigation";
import DiscountCodesClient from "./DiscountCodesClient";

/**
 * Admin: Discount-code management.
 *
 * Token-gated by middleware (ADMIN_CAMERA_TOKEN). The page just unwraps the
 * route param and hands the (already-validated) token to the client so it can
 * authenticate its API calls.
 *
 * URL: /admin/{ADMIN_CAMERA_TOKEN}/discount-codes
 */

export const dynamic = "force-dynamic";
export const revalidate = 0;

type Props = { params: Promise<{ token: string }> };

export default async function Page({ params }: Props) {
  const { token } = await params;
  const expected = process.env.ADMIN_CAMERA_TOKEN || "";
  if (!expected || token !== expected) notFound();
  return <DiscountCodesClient token={token} />;
}
