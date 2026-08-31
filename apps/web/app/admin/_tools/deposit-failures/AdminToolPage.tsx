import { adminPoppins } from "~/components/features/admin-skin/font";
import DepositFailuresClient from "@/app/admin/[token]/deposit-failures/DepositFailuresClient";
import { mintAdminApiToken } from "@/lib/admin-api-token";

/**
 * BMI deposit-failure retry queue — every row in `bmi_deposit_failures`, so
 * staff can see when a customer was charged but no credits landed (race packs)
 * or POV codes were issued without the matching BMI deduct (POV claims).
 * Actions: per-row retry, bulk backfill from `sales_log`.
 *
 * THE IMPLEMENTATION, ONCE. Two routes render this component and neither owns
 * it: `/admin/{token}/deposit-failures` (v1 — the static token in the path) and
 * `/admin/deposit-failures` (v2 — a Microsoft SSO session, no credential in the
 * URL at all). This board re-charges and re-credits real customers, which is
 * the reason both routes check a credential of their own on top of the gate.
 *
 * The token it hands its client is a SIGNED 8-hour credential
 * (`mintAdminApiToken`), never `ADMIN_CAMERA_TOKEN` — the client sends it back
 * as `x-admin-token` / `?token=` exactly where it always sent one, and the
 * middleware accepts it for `/api/admin/*` only. Pinned by
 * scripts/check-admin-token-leak.mjs.
 */
export default async function AdminToolPage() {
  const apiToken = await mintAdminApiToken();

  return (
    <div className={adminPoppins.variable}>
      <DepositFailuresClient token={apiToken} />
    </div>
  );
}
