"use client";

/**
 * The ONE shape for every utility box on the category chooser's bottom rows:
 * the "not booking" side doors (check-in, race grid, waiver), the coupon/voucher
 * chip, the applied-code banner, and the language switcher.
 *
 * Why this exists rather than four hand-rolled buttons: they were four hand-
 * rolled buttons, and they drifted. Same height but a 1.5px border at three
 * different alphas, three type sizes, two radii, and two separate flex rows
 * whose columns could never line up — so they read as unrelated controls
 * (owner 2026-07-28: "buttons still don't look exactly the same or aligned").
 *
 * Sharing the CLASS STRING, not just the dimensions, is the point: a tile in
 * another file (KioskVoucherSummary, LanguageSwitcher) styles itself from
 * UTIL_TILE_CLASS, so nothing can quietly diverge again. Only the accent color
 * differs, applied inline.
 *
 * Alignment comes from the CALLER laying these out in a single grid with fixed
 * columns — not from two flex rows, which is what stopped the columns lining up.
 */
import type { ReactNode } from "react";

/** Height/radius/border/type shared by every utility tile. Accent is inline. */
export const UTIL_TILE_CLASS =
  "k-display k-tap flex h-[100px] w-full min-w-0 items-center justify-center gap-[12px] " +
  "rounded-[20px] border-[1.5px] bg-[rgba(7,16,39,0.55)] px-[16px] text-center " +
  "text-[24px] uppercase leading-tight tracking-[0.06em] backdrop-blur-[10px]";

/** Border alpha applied to every tile's accent, so none looks brighter than
 *  its neighbours. Hex suffix = ~55% opacity. */
export const UTIL_TILE_BORDER_ALPHA = "8c";

export function UtilityTile({
  icon,
  label,
  /** Accent hex (#rrggbb) — drives the border and the text. */
  color,
  onClick,
}: {
  icon?: ReactNode;
  label: string;
  color: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{ borderColor: `${color}${UTIL_TILE_BORDER_ALPHA}`, color }}
      className={UTIL_TILE_CLASS}
    >
      {icon}
      <span className="min-w-0 truncate">{label}</span>
    </button>
  );
}
