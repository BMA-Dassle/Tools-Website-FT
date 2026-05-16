import { notFound } from "next/navigation";
import ReservationsClient from "./ReservationsClient";

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

  return <ReservationsClient token={token} />;
}
