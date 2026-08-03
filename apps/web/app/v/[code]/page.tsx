import { notFound } from "next/navigation";
import QRCode from "qrcode";
import { getVoucherStatus } from "~/features/game-cards/service/native-voucher";
import { isNativeVoucherCode } from "~/features/game-cards/vouchers/codes";
import { voucherRedeemUrl } from "~/features/game-cards/service/voucher-mail";
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

  // QR rendered SERVER-side as a data URI. This page is the thing a guest holds
  // up to a kiosk scanner — it is the primary way the voucher gets redeemed, and
  // it was missing entirely, leaving them to type 11 characters on a kiosk
  // keyboard. Encodes the /v/{code} URL, not the bare code, so the one image
  // works for both a kiosk scanner (classify.ts pulls the code back out of a /v/
  // path) and another phone's camera. Server-side keeps the QR library off the
  // client bundle. `H` error correction because this gets scanned off a screen
  // under a bezel.
  const qrDataUri = await QRCode.toDataURL(voucherRedeemUrl(status.code), {
    errorCorrectionLevel: "H",
    margin: 1,
    width: 512,
  }).catch(() => null);

  return <VoucherRedeemView status={status} qrDataUri={qrDataUri} />;
}
