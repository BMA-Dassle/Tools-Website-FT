import { notFound } from "next/navigation";
import DepositFailuresClient from "./DepositFailuresClient";

/**
 * Admin: BMI deposit failure retry queue.
 *
 * Surfaces every row in `bmi_deposit_failures` so staff can see when
 * a customer was charged but no credits landed (race packs) or POV
 * codes were issued without the matching BMI deduct (POV claims).
 *
 * Actions: per-row retry, bulk backfill from sales_log.
 *
 * URL shape: /admin/{ADMIN_CAMERA_TOKEN}/deposit-failures
 */

export const dynamic = "force-dynamic";
export const revalidate = 0;

type Props = { params: Promise<{ token: string }> };

export default async function Page({ params }: Props) {
  const { token } = await params;
  const cameraToken = process.env.ADMIN_CAMERA_TOKEN || "";
  const legacyToken = process.env.ADMIN_ETICKETS_TOKEN || "";
  const tokenOk =
    (!!cameraToken && token === cameraToken) ||
    (!!legacyToken && token === legacyToken);
  if (!tokenOk) notFound();

  return <DepositFailuresClient token={token} />;
}
