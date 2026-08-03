import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { getVoucherStatus } from "~/features/game-cards/service/native-voucher";
import { getVoucher, listVoucherBatch } from "~/features/game-cards/data/vouchers-db";
import { isNativeVoucherCode } from "~/features/game-cards/vouchers/codes";
import { voucherQrDataUri } from "~/features/game-cards/service/voucher-mail";
import { getDealPurchaseByBatchId } from "~/features/deals/data/deal-purchases-db";
import { walletPlatformFromUserAgent } from "~/features/game-cards/wallet/platform";
import { VoucherRedeemView } from "./VoucherRedeemView";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Guest voucher landing — THE one voucher page.
 *
 * It is the link in every email and SMS, the payload every QR encodes, the target
 * the kiosk classifier resolves, and now the post-purchase confirmation too. There
 * was briefly a separate `/deals/thanks` doing the same job with a long query
 * string; it duplicated the QR, the code, the contents and the instructions for no
 * gain (owner 2026-08-03: "why do we need both these?"). Folding it in here means
 * one implementation, a short shareable URL, and — because this page serves EVERY
 * native voucher — the better instructions now help VIP combo grants and comps too,
 * not just deal packs.
 *
 * Brand-neutral on purpose: a voucher can go to a HeadPinz or a FastTrax guest and
 * the same URL has to work on either domain, which is why `/v/` is in middleware's
 * shared-route list. (Miss that and every HeadPinz recipient 404s.)
 *
 * The page renders what's LEFT, per item — a multi-item voucher stays partly
 * redeemable, so "used" is never a whole-voucher statement.
 *
 * Deliberately no auth. The code IS the bearer instrument, exactly like a printed
 * one, and the redeem route is rate-limited per IP.
 */
export default async function VoucherPage({
  params,
  searchParams,
}: {
  params: Promise<{ code: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { code } = await params;
  if (!isNativeVoucherCode(code)) notFound();

  const status = await getVoucherStatus(code);
  if (!status) notFound();

  const sp = await searchParams;
  /** `?bought=1` — arrived straight from checkout, so lead with the receipt tone. */
  const justBought = (Array.isArray(sp.bought) ? sp.bought[0] : sp.bought) === "1";

  const qrDataUri = await voucherQrDataUri(status.code);

  /**
   * Which wallet this device actually has, resolved on the SERVER.
   *
   * Server-side because the alternative — detecting in the browser — renders both
   * buttons and then removes one, which is a visible flicker on the exact screen
   * a guest reaches straight after paying. `dynamic = "force-dynamic"` above means
   * there is no cached HTML to get this wrong for the next visitor.
   *
   * `null` on desktop and anything unrecognised, which shows BOTH buttons — see
   * wallet/platform.ts for why guessing there would be worse.
   */
  const walletPlatform = walletPlatformFromUserAgent((await headers()).get("user-agent"));

  /**
   * Sibling codes from the SAME purchase, when there are any.
   *
   * Gated on a `deal_purchases` row, NOT merely on a shared `batch_id`. A batch
   * also groups an admin comp mint — one batch can be 500 codes for 500 different
   * people — so listing siblings off the batch alone would hand whoever holds one
   * code everybody else's bearer instruments. A purchase row proves the batch was
   * bought by ONE buyer, which is the only case where the rest are theirs.
   *
   * Every lookup is best-effort: this is decoration, and it must never take the
   * page down.
   */
  let siblingCodes: string[] = [];
  try {
    const row = await getVoucher(status.code);
    if (row?.batchId) {
      const purchase = await getDealPurchaseByBatchId(row.batchId);
      if (purchase) {
        siblingCodes = (await listVoucherBatch(row.batchId))
          .filter((v) => v.code !== status.code && !v.voidedAt)
          .map((v) => v.code);
      }
    }
  } catch (err) {
    console.error("[voucher] sibling lookup failed (non-fatal):", err);
  }

  return (
    <VoucherRedeemView
      status={status}
      qrDataUri={qrDataUri}
      justBought={justBought}
      siblingCodes={siblingCodes}
      walletPlatform={walletPlatform}
    />
  );
}
