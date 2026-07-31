/**
 * V2 combo voucher minted WITH a kiosk booking — the client-side handoff
 * between checkout and the kiosk confirmation screen (pov-confirmation's
 * sibling, same read-once stash pattern).
 *
 * unified-reserve mints the voucher server-side (idempotent per billId) and
 * returns `comboVoucher` on the reserve result; checkout stashes it here and
 * the confirmation screen shows the code. Pure display — the durable copies
 * are the guest email (code + QR) and the vouchers registry row.
 */

export const KIOSK_VIP_VOUCHER_CONFIRM_KEY = "kiosk:vip-voucher:confirm";

export interface VipVoucherConfirmation {
  code: string;
  expiresAt: string | null;
}

export function stashVipVoucherConfirmation(voucher: unknown): void {
  if (!voucher || typeof voucher !== "object") return;
  const code = (voucher as { code?: unknown }).code;
  if (typeof code !== "string" || !code) return;
  const expiresAt = (voucher as { expiresAt?: unknown }).expiresAt;
  try {
    sessionStorage.setItem(
      KIOSK_VIP_VOUCHER_CONFIRM_KEY,
      JSON.stringify({ code, expiresAt: typeof expiresAt === "string" ? expiresAt : null }),
    );
  } catch {
    /* storage unavailable — the email still carries code + QR */
  }
}

export function readVipVoucherConfirmation(): VipVoucherConfirmation | null {
  try {
    const raw = sessionStorage.getItem(KIOSK_VIP_VOUCHER_CONFIRM_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as VipVoucherConfirmation;
    if (!parsed || typeof parsed.code !== "string" || !parsed.code) return null;
    return { code: parsed.code, expiresAt: parsed.expiresAt ?? null };
  } catch {
    return null;
  }
}

export function clearVipVoucherConfirmation(): void {
  try {
    sessionStorage.removeItem(KIOSK_VIP_VOUCHER_CONFIRM_KEY);
  } catch {
    /* nothing to clear */
  }
}
