import { notFound } from "next/navigation";
import DailyEventsBoard from "~/components/features/daily-events/DailyEventsBoard";

/**
 * Admin: Daily Events board.
 *
 * Faithful port of the employee portal's Daily Events page — group
 * functions / online reservations for a date + location, with payment
 * pills, waiver status bars, and the upcoming-group-functions weekly view.
 *
 * URL: /admin/{ADMIN_CAMERA_TOKEN}/daily-events
 */

export const dynamic = "force-dynamic";
export const revalidate = 0;

type Props = { params: Promise<{ token: string }> };

export default async function Page({ params }: Props) {
  const { token } = await params;
  const expected = process.env.ADMIN_CAMERA_TOKEN || "";
  if (!expected || token !== expected) notFound();

  return <DailyEventsBoard token={token} />;
}
