import { notFound } from "next/navigation";
import { adminPoppins } from "~/components/features/admin-skin/font";
import ReservationsBoard from "~/components/features/reservations-admin/ReservationsBoard";
import { mintAdminApiToken } from "@/lib/admin-api-token";

/**
 * Admin: Bowling reservations board.
 *
 * Shows all bowling reservations for a selected date, filterable by center.
 * Displays guest info, status, amounts, QAMF IDs, and lane assignments.
 *
 * URL: /admin/{ADMIN_CAMERA_TOKEN}/reservations
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
      <ReservationsBoard token={apiToken} />
    </div>
  );
}
