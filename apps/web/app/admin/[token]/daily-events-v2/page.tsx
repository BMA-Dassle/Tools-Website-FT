import { notFound } from "next/navigation";
import { adminPoppins } from "~/components/features/admin-skin/font";
import DailyEventsBoardV2 from "~/components/features/daily-events-v2/DailyEventsBoardV2";
import { mintAdminApiToken } from "@/lib/admin-api-token";

/**
 * Admin: Daily Events v2 — owner-approved hybrid redesign (2026-07-13),
 * deployed ALONGSIDE v1 per the v2 cutover safety pattern (ops signs off
 * before any redirect; /daily-events stays untouched).
 *
 * Keeps v1's bones: banded day sections, two-line rows, PaymentCell.
 * Adds: needs-attention sentences, per-day money/risk summaries in the
 * band, a Day ⇄ Week (Wed–Tue) toggle replacing the week tabs — all
 * skinned with the employee portal's design system (navy/blue, Poppins).
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

  // The client sends this back as x-admin-token / ?token= for its
  // /api/admin/* calls, exactly where it always sent one — but it is now a
  // signed 8-hour credential, not the permanent ADMIN_CAMERA_TOKEN. The
  // static token never reaches a browser again.
  // (Pinned by scripts/check-admin-token-leak.mjs.)
  const apiToken = await mintAdminApiToken();

  return (
    <div className={adminPoppins.variable}>
      <DailyEventsBoardV2 token={apiToken} />
    </div>
  );
}
