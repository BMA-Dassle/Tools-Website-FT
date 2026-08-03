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
 *   UNITS ARE TOKENS, AND THE UNIT IS THE COUNT — "100 Tokens", not "$10"
 *   (owner 2026-08-03: "needs to say 100 tokens not $10", "everything should be
 *   related to tokens"). Tokens are what a guest actually spends at a machine, so
 *   that is the number on their voucher, their pass and their receipt. Dollars
 *   still lead the MARKETING line on a deal page, where the point is the price;
 *   they do not appear on the instrument itself.
 *
 * Pure — safe to import from a client component.
 */

import { ATTRACTIONS } from "@/lib/attractions-data";
import type { VoucherItem } from "../data/vouchers-db";

/** Dollars of play on a Game Zone item, at the house 10¢/token rate. */
function tokenCount(item: Extract<VoucherItem, { kind: "gamezone" }>): number {
  return item.tokens + item.bonusTokens;
}

/** Dollars of play, at the house 10c/token rate. Marketing surfaces only. */
export function gameZoneDollars(item: Extract<VoucherItem, { kind: "gamezone" }>): number {
  return tokenCount(item) / 10;
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
    return `${tokenCount(item)} Tokens`;
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

/** Where a group of items is redeemed — drives the status word on each row. */
export type VoucherItemRoute = "gamezone" | "attraction" | "race";

export interface VoucherItemGroup {
  /** Guest-facing label WITHOUT a count — the row adds "N × ". */
  label: string;
  route: VoucherItemRoute;
  /** How many legs of this kind the voucher carries. */
  total: number;
  /** How many of those are already used. */
  spent: number;
  /** Item indexes, ascending — stable React key and a hook for audit. */
  indexes: number[];
  /**
   * True when the label already accounts for every leg, so a renderer must NOT
   * prefix "N × ". Token legs ADD UP: four 100-token legs are "400 Tokens", not
   * "4 × 100 Tokens" (owner 2026-08-03: "needs to read x4 laser tag + 400
   * tokens"). Admissions are the opposite — four laser legs are four separate
   * sessions and must stay countable.
   */
  summed: boolean;
}

/**
 * Collapse identical legs into one counted row.
 *
 * A 3-pack combined voucher carries twelve legs and rendered twelve rows, which
 * is the same complaint the KIOSK receipt already answered (owner screenshot
 * 2026-08-02: "combine line and do by qty plus or minus" — a 7-guest VIP voucher
 * was 14 rows). This mirrors `kiosk/code-entry/receipt-groups.ts`: group on the
 * label, keep first-appearance order, sort the indexes.
 *
 * Spent and unspent legs group SEPARATELY, exactly as the kiosk does with its
 * struck-through "already used" rows — merging them would have to invent a
 * combined status, and "4 of 6" is only meaningful when the reader can also see
 * the other 2 accounted for.
 *
 * Pure and list-only, so the rules are testable without a component.
 */
export function groupVoucherItems(
  items: readonly { index: number; item: VoucherItem; spent: boolean }[],
): VoucherItemGroup[] {
  const out: VoucherItemGroup[] = [];
  const byKey = new Map<string, VoucherItemGroup>();

  /** Running token totals per spent-state, so token legs can be summed. */
  const tokenTotals = new Map<string, number>();

  for (const entry of items) {
    const isTokens = entry.item.kind === "gamezone";
    const route: VoucherItemRoute = isTokens
      ? "gamezone"
      : entry.item.kind === "race"
        ? "race"
        : "attraction";
    const label = voucherItemDisplayLabel(entry.item);
    // Token legs collapse into ONE row per spent-state regardless of
    // denomination — a 100 and a 200 leg are 300 tokens, not two rows. Keying on
    // the label would split them. Admissions still key on label, because a laser
    // session and a gel session are genuinely different things.
    const key = isTokens
      ? `tokens|${entry.spent ? "spent" : "live"}`
      : `${label}|${route}|${entry.spent ? "spent" : "live"}`;

    if (isTokens && entry.item.kind === "gamezone") {
      const running = (tokenTotals.get(key) ?? 0) + entry.item.tokens + entry.item.bonusTokens;
      tokenTotals.set(key, running);
    }

    const existing = byKey.get(key);
    if (existing) {
      existing.total += 1;
      if (entry.spent) existing.spent += 1;
      existing.indexes.push(entry.index);
      if (isTokens) existing.label = `${tokenTotals.get(key)} Tokens`;
      continue;
    }
    const group: VoucherItemGroup = {
      label: isTokens ? `${tokenTotals.get(key)} Tokens` : label,
      route,
      total: 1,
      spent: entry.spent ? 1 : 0,
      indexes: [entry.index],
      summed: isTokens,
    };
    byKey.set(key, group);
    out.push(group);
  }

  for (const g of byKey.values()) g.indexes.sort((a, b) => a - b);
  return out;
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
