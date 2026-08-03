/**
 * GUEST-FACING labels for voucher items.
 *
 * Separate from `voucherItemLabel` (data/vouchers-db.ts) on purpose. That one is
 * the internal/kiosk label — lower-cased, slug-derived, and denominated in tokens
 * — and several kiosk surfaces plus their tests assert its exact output, so
 * changing it to read nicely would ripple through the receipt grouping. This is
 * the presentation layer on top.
 *
 * Two things it fixes for a guest reading their own voucher:
 *   CASING. "laser tag" became "Laser Tag" — these are product names, taken from
 *   the attraction catalog rather than de-hyphenated from a slug, so they match
 *   what the rest of the site calls them ("Gel Blasters", not "Gel blaster").
 *   UNITS. "100 bonus tokens" is our internal accounting; a buyer paid dollars
 *   and bought a "$10 Game Card". Tokens are an implementation detail of the
 *   Intercard rail, not something to put in front of someone.
 *
 * Pure — safe to import from a client component.
 */

import { ATTRACTIONS } from "@/lib/attractions-data";
import type { VoucherItem } from "../data/vouchers-db";

/** Dollars of play on a Game Zone item, at the house 10¢/token rate. */
function playDollars(item: Extract<VoucherItem, { kind: "gamezone" }>): number {
  return (item.tokens + item.bonusTokens) / 10;
}

/** Product name for an attraction slug, from the catalog (never the raw slug). */
function attractionName(slug: string): string {
  const known = ATTRACTIONS[slug]?.shortName;
  if (known) return known;
  // Unknown slug: title-case the slug rather than show "gel-blaster".
  return slug
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** What ONE voucher item is, as the holder should read it. */
export function voucherItemDisplayLabel(item: VoucherItem): string {
  if (item.kind === "gamezone") {
    if (item.bonusCashDollars > 0) return `$${item.bonusCashDollars} Bonus Cash`;
    return `$${playDollars(item)} Game Card`;
  }
  if (item.kind === "attraction") {
    const name = attractionName(item.slug);
    return item.qty > 1 ? `${item.qty} × ${name}` : name;
  }
  if (item.kind === "attraction-choice") {
    const name = item.slugs.map(attractionName).join(" or ");
    return item.qty > 1 ? `${item.qty} × ${name}` : name;
  }
  return item.qty > 1 ? `${item.qty} × Race` : "Race";
}

/** Long-form date in ET — the timezone every voucher expiry is expressed in. */
export function formatVoucherExpiry(expiresAt: string | null): string | null {
  if (!expiresAt) return null;
  return new Date(expiresAt).toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}
