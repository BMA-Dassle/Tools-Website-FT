import { notFound } from "next/navigation";
import { getVoucherStatus } from "~/features/game-cards/service/native-voucher";
import { isNativeVoucherCode } from "~/features/game-cards/vouchers/codes";
import { VoucherRedeemView } from "./VoucherRedeemView";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Guest voucher landing — the link in the email/SMS we send.
 *
 * Brand-neutral on purpose: a voucher can go to a HeadPinz or a FastTrax guest
 * and the same URL has to work on either domain, which is why `/v/` is in
 * middleware's shared-route list. (Miss that and every HeadPinz recipient 404s.)
 *
 * The page renders what's LEFT on the voucher, per item — a multi-item voucher
 * stays partly redeemable, so "used" is never a whole-voucher statement. The
 * redemption itself credits a card the guest already holds; there's no dispenser
 * on a phone, so anyone without a card is pointed at a kiosk instead.
 *
 * Deliberately no auth. The code IS the bearer instrument, exactly like the
 * printed one, and the redeem route is rate-limited per IP.
 */
export default async function VoucherPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  if (!isNativeVoucherCode(code)) notFound();

  const status = await getVoucherStatus(code);
  if (!status) notFound();

  return <VoucherRedeemView status={status} />;
}
