/**
 * Combo voucher grant — SERVER-ONLY (touches the voucher registry; keep out of
 * features/combos/index.ts so client bundles never pull it).
 *
 * A combo with a `voucherGrant` mints ONE native voucher (HPW code) per
 * booking, after the deposit captures: perGuest items × racer count +
 * perBooking items, expiring `expiresMonthsFromVisit` after the VISIT date
 * (owner 2026-07-31: "vouchers are good for 1 year from race date. Not
 * transferable.").
 *
 * IDEMPOTENCY IS THE BILL, not the reserve key: `vouchers.bill_id` carries a
 * partial UNIQUE index, so a reserve retry, the recovery sweep, and a manual
 * re-mint all converge on the SAME code. A lost insert race re-selects the
 * winner instead of minting a duplicate.
 *
 * FAILURE POSTURE: the caller (unified-reserve post-capture seam) soft-fails —
 * a mint hiccup must never fail a captured booking. `sweepMissingComboVouchers`
 * is the durable recovery: any recent combo booking whose combo grants a
 * voucher but has no vouchers row gets minted + the guest gets the make-good
 * email (the confirmation email has long since gone out without a code).
 */

import { sql, isDbConfigured } from "@ft/db";
import { getVoucherByBillId, type VoucherItem } from "~/features/game-cards/data/vouchers-db";
import {
  mintBookingVoucherIfNeeded,
  type BookingVoucher,
} from "~/features/game-cards/service/native-voucher";
import { sendVoucherToGuest } from "~/features/game-cards/service/voucher-mail";
import { getComboSpecial, type ComboSpecial } from "./combo-specials";

export type ComboVoucherMintResult = BookingVoucher;

/** The full item list one booking's voucher carries. Pure — unit-tested. */
export function comboVoucherItems(combo: ComboSpecial, racerCount: number): VoucherItem[] {
  const grant = combo.voucherGrant;
  if (!grant) return [];
  const n = Math.max(1, Math.floor(racerCount));
  const perGuest: VoucherItem[] = [];
  for (let i = 0; i < n; i++) perGuest.push(...grant.perGuest);
  return [...perGuest, ...grant.perBooking];
}

/**
 * expires_at = end of the visit day + N months, pinned to EST (-05:00). Pure —
 * unit-tested. A fixed offset over a real TZ lib is deliberate: in summer the
 * voucher dies at 00:59 EDT the next morning instead of 23:59, and an hour of
 * slack in the GUEST's favour beats a timezone dependency here.
 */
export function comboVoucherExpiry(visitDateYmd: string, months: number): string {
  const base = new Date(`${visitDateYmd}T23:59:59-05:00`);
  if (Number.isNaN(base.getTime())) throw new Error(`bad visit date: ${visitDateYmd}`);
  base.setUTCMonth(base.getUTCMonth() + Math.max(0, Math.floor(months)));
  return base.toISOString();
}

/**
 * Mint the booking's voucher if it doesn't exist yet; return the live one
 * either way. Null only when the combo grants nothing. Thin adapter over the
 * UNIVERSAL `mintBookingVoucherIfNeeded` (game-cards) — future non-combo
 * booking grants call that rail directly with their own item lists.
 */
export async function mintComboVoucherIfNeeded(args: {
  combo: ComboSpecial;
  /** BMI billId — a STRING (17-digit ids exceed float-safe range). */
  billId: string;
  racerCount: number;
  /** Visit (race) date, YYYY-MM-DD — the expiry clock starts here. */
  visitDateYmd: string;
  contact?: { email?: string; name?: string };
}): Promise<ComboVoucherMintResult | null> {
  const grant = args.combo.voucherGrant;
  if (!grant) return null;
  return mintBookingVoucherIfNeeded({
    billId: args.billId,
    items: comboVoucherItems(args.combo, args.racerCount),
    expiresAt: comboVoucherExpiry(args.visitDateYmd, grant.expiresMonthsFromVisit),
    issuedSource: "booking-combo",
    issuedTo:
      args.contact?.email || args.contact?.name
        ? {
            ...(args.contact.email ? { email: args.contact.email } : {}),
            ...(args.contact.name ? { name: args.contact.name } : {}),
          }
        : null,
    batchLabel: `${args.combo.id} ${args.billId}`,
  });
}

export interface ComboVoucherSweepSummary {
  candidates: number;
  minted: number;
  emailed: number;
  skippedNoGrant: number;
  errors: number;
}

/**
 * Recovery sweep: recent combo bookings whose combo grants a voucher but whose
 * bill has no vouchers row → mint + email the guest the code (make-good; the
 * booking-time confirmation email already went out without it). Idempotent by
 * construction — the bill_id lookup inside mintComboVoucherIfNeeded means a
 * re-run mints nothing new.
 */
export async function sweepMissingComboVouchers(args: {
  sinceDays: number;
  dryRun: boolean;
}): Promise<ComboVoucherSweepSummary> {
  const summary: ComboVoucherSweepSummary = {
    candidates: 0,
    minted: 0,
    emailed: 0,
    skippedNoGrant: 0,
    errors: 0,
  };
  if (!isDbConfigured()) return summary;
  const q = sql();
  // One row per bill: the race leg carries the heats (racer identities + the
  // visit date); guest contact comes from whichever leg recorded it. event_at
  // mirrors listVipComboReservations' derivation.
  const rows = (await q`
    SELECT
      bmi_bill_id,
      max(combo_special_id) AS combo_special_id,
      max(guest_name) AS guest_name,
      max(guest_email) AS guest_email,
      min(
        COALESCE(
          (SELECT min(t.e->>'heatId') FROM jsonb_array_elements(CASE WHEN jsonb_typeof(booking_metadata->'heats')='array' THEN booking_metadata->'heats' ELSE '[]'::jsonb END) AS t(e)),
          to_char(booked_at AT TIME ZONE 'America/New_York','YYYY-MM-DD"T"HH24:MI:SS')
        )
      ) AS event_at,
      -- Distinct racers on the race leg: each racer has one heat PER RACE LEG,
      -- so distinct assignedTo (always present; bmiPersonId can be null for
      -- yet-unregistered racers) = the party's racer count.
      max(
        (SELECT count(DISTINCT t.e->>'assignedTo') FROM jsonb_array_elements(CASE WHEN jsonb_typeof(booking_metadata->'heats')='array' THEN booking_metadata->'heats' ELSE '[]'::jsonb END) AS t(e))
      ) AS racer_count
    FROM bowling_reservations
    WHERE combo_special_id IS NOT NULL
      AND bmi_bill_id IS NOT NULL
      AND status <> 'cancelled'
      AND inserted_at > NOW() - make_interval(days => ${args.sinceDays})
    GROUP BY bmi_bill_id
  `) as Array<Record<string, unknown>>;

  for (const r of rows) {
    const billId = r.bmi_bill_id != null ? String(r.bmi_bill_id) : null;
    const comboId = r.combo_special_id != null ? String(r.combo_special_id) : null;
    if (!billId || !comboId) continue;
    const combo = getComboSpecial(comboId);
    if (!combo?.voucherGrant) {
      summary.skippedNoGrant++;
      continue;
    }
    try {
      const existing = await getVoucherByBillId(billId);
      if (existing) continue; // healthy — the reserve-time mint landed
      summary.candidates++;
      if (args.dryRun) continue;

      const visitDateYmd = String(r.event_at ?? "").slice(0, 10);
      const racerCount = Math.max(1, Number(r.racer_count ?? 0) || 1);
      const email = r.guest_email ? String(r.guest_email) : undefined;
      const name = r.guest_name ? String(r.guest_name) : undefined;
      const minted = await mintComboVoucherIfNeeded({
        combo,
        billId,
        racerCount,
        visitDateYmd,
        contact: { email, name },
      });
      if (!minted) continue;
      summary.minted++;
      console.warn(
        `[combo-voucher] sweep minted ${minted.code} for bill ${billId} (${comboId}, ${racerCount} racers)`,
      );
      if (email) {
        const sent = await sendVoucherToGuest({
          code: minted.code,
          items: minted.items,
          email,
          name,
          expiresAt: minted.expiresAt,
        });
        if (sent.emailOk) summary.emailed++;
      }
    } catch (err) {
      summary.errors++;
      console.error(
        `[combo-voucher] sweep failed for bill ${billId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return summary;
}
