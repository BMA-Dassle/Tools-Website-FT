import { notFound } from "next/navigation";
import DailyEventsBoardV2 from "~/components/features/daily-events-v2/DailyEventsBoardV2";

/**
 * Admin: Daily Events v2 — owner-approved hybrid redesign (2026-07-13),
 * deployed ALONGSIDE v1 per the v2 cutover safety pattern (ops signs off
 * before any redirect; /daily-events stays untouched).
 *
 * Keeps v1's bones: banded day sections, two-line rows, PaymentCell.
 * Adds: needs-attention sentences, per-day money/risk summaries in the
 * band, a Day ⇄ Week (Wed–Tue) toggle replacing the week tabs, and
 * Bahnschrift type. Same feature layer + detail modal as v1.
 *
 * URL: /admin/{ADMIN_CAMERA_TOKEN}/daily-events-v2
 */

export const dynamic = "force-dynamic";
export const revalidate = 0;

type Props = { params: Promise<{ token: string }> };

export default async function Page({ params }: Props) {
  const { token } = await params;
  const expected = process.env.ADMIN_CAMERA_TOKEN || "";
  if (!expected || token !== expected) notFound();

  return <DailyEventsBoardV2 token={token} />;
}
