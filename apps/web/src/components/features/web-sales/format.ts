/**
 * Presentation helpers for the board. Pure, so they are testable in a node-only
 * vitest — see the note in `~/features/web-sales/types.ts` about why nothing
 * that matters is allowed to live inside a component here.
 */

import { PORTAL_DARK } from "~/components/features/admin-skin/theme";
import type { SaleTone, WebSaleRow } from "~/features/web-sales";

export const money = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

/** Every timestamp on an admin surface is Eastern — every center is in ET. */
export function whenLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", {
    timeZone: "America/New_York",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Full date+time, for the drawer and tooltips. */
export function whenLabelLong(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", { timeZone: "America/New_York" });
}

/**
 * One legend for the whole board.
 *
 * Colours are the portal palette, not per-source inventions: a reader should
 * never have to learn what amber means for deal packs versus game-card reloads.
 */
export const TONE_COLOR: Record<SaleTone, string> = {
  ok: "#22c55e",
  pending: "#60a5fa",
  warn: "#f59e0b",
  danger: "#ef4444",
  muted: PORTAL_DARK.muted,
};

/** Background wash for a status pill, at the same hue as its text. */
export const TONE_BG: Record<SaleTone, string> = {
  ok: "rgba(34,197,94,0.12)",
  pending: "rgba(96,165,250,0.12)",
  warn: "rgba(245,158,11,0.12)",
  danger: "rgba(239,68,68,0.12)",
  muted: "rgba(152,162,179,0.12)",
};

/** "Jacob Elliott" / the email when unnamed / "—" when we have neither. */
export function buyerLabel(row: WebSaleRow): string {
  return row.buyer.name || row.buyer.email || "—";
}

/**
 * Who the value actually goes to. Non-null only on a gift, so the board can show
 * "→ Dana" without every ordinary sale growing an empty column.
 */
export function recipientLabel(row: WebSaleRow): string | null {
  if (!row.buyer.recipientName && !row.buyer.recipientEmail) return null;
  return row.buyer.recipientName || row.buyer.recipientEmail;
}

/** Refund/void state as a short chip label, or null when nothing happened. */
export function refundChip(row: WebSaleRow): { label: string; tone: SaleTone } | null {
  switch (row.refund.kind) {
    case "none":
      return null;
    case "voided":
      return { label: "voided", tone: "muted" };
    case "partial":
      return { label: `−${money(row.refund.refundedCents)}`, tone: "warn" };
    case "full":
      return { label: `refunded ${money(row.refund.refundedCents)}`, tone: "muted" };
  }
}

/**
 * "Needs attention" is derived from the projected row, not from any source's
 * native status vocabulary — see the note on `toApiQuery` about why this is
 * filtered client-side rather than pushed into every adapter's SQL.
 */
export function isProblemRow(row: WebSaleRow): boolean {
  return row.status.problem !== null;
}

/** The actions a source actually implements, in a stable render order. */
export function visibleCapabilities(row: WebSaleRow, supported: readonly string[]) {
  return row.capabilities.filter((c) => supported.includes(c.action));
}
