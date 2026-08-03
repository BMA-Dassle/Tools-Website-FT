/**
 * Ultimate VIP Experience site popup — SERVER shell.
 *
 * EVERY guest-facing fact here is derived from the combo registry: the price,
 * the duration, the itinerary, the voucher inclusions and their terms. Nothing
 * is hand-typed. That is deliberate — the v1 pack ($65/$75, no vouchers) and
 * the v2 pack ($79/$99 + Game Zone / Laser Tag OR Gel Blaster / Shuffly
 * vouchers) swap behind `NEXT_PUBLIC_COMBO_RACE_BOWL_V2_ENABLED`, and an ad
 * with a stale price on it is a promise the checkout will not honour.
 *
 * Reads the registry on the server (it pulls in the Square catalog map and
 * race pricing) and hands the client a small serializable snapshot, so none of
 * that reaches the browser bundle.
 *
 * ON by default (owner call, 2026-08-02). Kill switch: set
 * `NEXT_PUBLIC_VIP_POPUP=false` in Vercel and redeploy — the value is
 * build-baked, so changing it in the dashboard alone does nothing.
 *
 * @see VipExperiencePopupClient for the trigger rules and the markup.
 */

import {
  comboStartHoursLabel,
  enabledCombos,
  type ComboLeg,
  type ComboSpecial,
} from "~/features/combos/combo-specials";
import { isProductPaused } from "~/features/maintenance";

import {
  VipExperiencePopupClient,
  type VipPopupContent,
  type VipPopupStop,
} from "./VipExperiencePopupClient";

/** Default ON — only an explicit "false" turns it off. */
function vipPopupEnabled(): boolean {
  return process.env.NEXT_PUBLIC_VIP_POPUP !== "false";
}

/** Whole dollars when the price is round, cents when it isn't. */
function money(cents: number): string {
  return cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;
}

/** "1.5 Hrs" / "1 Hr" — no trailing ".0". */
function hours(minutes: number): string {
  const h = minutes / 60;
  return `${Number.isInteger(h) ? h : h.toFixed(1)} ${h === 1 ? "Hr" : "Hrs"}`;
}

/**
 * One itinerary leg → one rail stop. Race legs are FastTrax, lanes are
 * HeadPinz — that split IS the ad's headline, so it is derived from the leg
 * rather than written down twice. Attraction legs return null: the wizard
 * cannot assemble them today and the pricing gate rejects them, so an ad must
 * not imply they are scheduled.
 */
function legToStop(leg: ComboLeg): VipPopupStop | null {
  if (leg.kind === "race") {
    const starter = leg.tier === "starter";
    return {
      name: `${leg.tier.charAt(0).toUpperCase()}${leg.tier.slice(1)} Race`,
      // Say what the leg is FOR. The Starter gates the second race, and that is
      // the one thing a guest actually needs to know before booking.
      note: starter ? "Qualify for race two" : "Beat your Starter time",
      venue: "FastTrax",
      accent: "track",
    };
  }
  if (leg.kind === "bowling") {
    return {
      name: `${hours(leg.durationMinutes)} ${leg.vip ? "VIP " : ""}Bowling`,
      note: leg.vip ? "Semi-private VIP suite" : "Your own lane",
      venue: "HeadPinz",
      accent: "lanes",
    };
  }
  return null;
}

/**
 * The premium Fort Myers combo currently on sale. `enabledCombos()` already
 * resolves the v1/v2 flag pair, so whichever pack ops has live is the one the
 * ad sells.
 */
function liveCombo(): ComboSpecial | null {
  return enabledCombos().find((c) => c.premium && c.center === "fort-myers") ?? null;
}

export function VipExperiencePopup() {
  if (!vipPopupEnabled()) return null;

  const combo = liveCombo();
  if (!combo) return null;

  // VENDOR OUTAGE (maintenance mode): self-hide while a vendor the pack needs is
  // down. This is an unsolicited popup that interrupts the whole site to sell one
  // product — pitching it when its "Book the VIP Experience" button can only
  // reach an outage notice is worse than showing nothing (owner 2026-08-03: "we
  // have popup modal for VIP that might need to temp be off while system outage
  // on bmi"). No new flag: it reads the SAME registry the cards and kiosk tiles
  // read, keyed by the wire id "race-bowl" for any race-bowl* pack, so it comes
  // back on its own the moment the outage clears.
  if (isProductPaused(combo.id.startsWith("race-bowl") ? "race-bowl" : combo.id)) return null;

  const stops = combo.components.map(legToStop).filter((s): s is VipPopupStop => s !== null);
  // The creative is built around a two-venue itinerary. Anything else would
  // render a card that does not match its own headline.
  if (stops.length !== combo.components.length || stops.length < 2) return null;
  if (!stops.some((s) => s.venue === "FastTrax") || !stops.some((s) => s.venue === "HeadPinz")) {
    return null;
  }

  const content: VipPopupContent = {
    name: combo.name,
    durationLabel: (combo.durationLabel ?? "").replace(/^≈\s*/, ""),
    weekdayPrice: money(combo.price.weekday),
    weekendPrice: money(combo.price.weekend),
    minHeadcount: combo.minHeadcount ?? 1,
    startHoursLabel: comboStartHoursLabel(combo),
    href: `/book/combo/${combo.id}/v2`,
    stops,
    // Verbatim from the registry, terms included. These are redeem-later
    // vouchers with real limits ("when available", "not transferable"), NOT
    // walk-up extras — the note ships with the items or neither ships.
    voucher: combo.voucherIncludes
      ? {
          title: combo.voucherIncludes.title ?? "Plus vouchers to your favorite attractions",
          items: combo.voucherIncludes.items,
          note: combo.voucherIncludes.note,
        }
      : null,
  };

  return <VipExperiencePopupClient content={content} />;
}
