/**
 * Display constants for the admin reservations board.
 * Extracted verbatim from app/admin/[token]/reservations/ReservationsClient.tsx.
 */
import type { ShoeCategory } from "./types";

/** Short display labels for the day-of-order `source` tag (the raw values are
 *  verbose, e.g. "race-dayof-pay-fallback-timepassed" overflowed the column). */
export const DAYOF_SOURCE_LABELS: Record<string, string> = {
  webhook: "WEBHOOK",
  "race-dayof-pay": "AUTO",
  "race-dayof-pay-fallback-timepassed": "AUTO·PAST",
};

export const CENTERS: Record<string, string> = {
  TXBSQN0FEKQ11: "Fort Myers",
  PPTR5G2N0QXF7: "Naples",
  // FastTrax has no bowling (HeadPinz-only), but it IS a group-function center,
  // so the page shows its group events when scoped here.
  LAB52GY480CJF: "FastTrax",
};

/** URL-friendly slugs → center codes for ?center= param (drives the portal embed,
 *  e.g. /admin/embed/bowling?center=fasttrax). */
export const CENTER_SLUGS: Record<string, string> = {
  fm: "TXBSQN0FEKQ11",
  "fort-myers": "TXBSQN0FEKQ11",
  naples: "PPTR5G2N0QXF7",
  ft: "LAB52GY480CJF",
  fasttrax: "LAB52GY480CJF",
  "fast-trax": "LAB52GY480CJF",
};

/** Center codes stored as slugs (combos store session.center, e.g. "fort-myers"). */
export const CENTER_LABELS_BY_SLUG: Record<string, string> = {
  "fort-myers": "Fort Myers",
  naples: "Naples",
  fasttrax: "FastTrax",
};

export const STATUS_COLORS: Record<string, string> = {
  confirmed: "#22c55e",
  confirm_pending: "#f59e0b",
  confirm_failed: "#ef4444",
  arrived: "#3b82f6",
  completed: "#6b7280",
  cancelled: "#ef4444",
};

export const STATUS_LABELS: Record<string, string> = {
  confirmed: "Confirmed",
  confirm_pending: "Pending",
  confirm_failed: "Failed",
  arrived: "Arrived",
  completed: "Completed",
  cancelled: "Cancelled",
};

export const SOURCE_LABELS: Record<string, string> = {
  web: "Web",
  kiosk: "Kiosk",
  conqueror: "Conq",
  admin: "Admin",
};

export const SOURCE_COLORS: Record<string, string> = {
  web: "#22c55e",
  kiosk: "#f59e0b",
  conqueror: "#ec4899",
  admin: "#8b5cf6",
};

export const KIND_BADGE: Record<
  string,
  { label: string; color: string; bg: string; border: string }
> = {
  kbf: {
    label: "KBF",
    color: "#a855f7",
    bg: "rgba(168,85,247,0.15)",
    border: "rgba(168,85,247,0.3)",
  },
  open: {
    label: "Open",
    color: "#3b82f6",
    bg: "rgba(59,130,246,0.15)",
    border: "rgba(59,130,246,0.3)",
  },
  race: {
    label: "Race",
    color: "#22c55e",
    bg: "rgba(34,197,94,0.15)",
    border: "rgba(34,197,94,0.3)",
  },
  attraction: {
    label: "Attr",
    color: "#f59e0b",
    bg: "rgba(245,158,11,0.15)",
    border: "rgba(245,158,11,0.3)",
  },
  // Gold treatment for the Ultimate VIP combo — matches the combo accentColor.
  vip: {
    label: "VIP",
    color: "#d4af37",
    bg: "rgba(212,175,55,0.18)",
    border: "rgba(212,175,55,0.45)",
  },
  // NeoVerse violet — the v3 Experience step's VIP accent, so the board reads
  // the same colour the guest saw when they booked.
  nfl: {
    label: "NFL",
    color: "#a78bfa",
    bg: "rgba(167,139,250,0.18)",
    border: "rgba(167,139,250,0.45)",
  },
};

export const KIND_FULL_LABELS: Record<string, string> = {
  kbf: "Kids Bowl Free",
  open: "Open Bowling",
  race: "Karting",
  attraction: "Attraction",
};

export const SHOE_SIZES: Record<ShoeCategory, string[]> = {
  Toddler: ["6", "7", "8", "9", "10", "11", "12", "13"],
  Male: [
    "1",
    "1.5",
    "2",
    "2.5",
    "3",
    "3.5",
    "4",
    "4.5",
    "5",
    "5.5",
    "6",
    "6.5",
    "7",
    "7.5",
    "8",
    "8.5",
    "9",
    "9.5",
    "10",
    "10.5",
    "11",
    "11.5",
    "12",
    "12.5",
    "13",
    "13.5",
    "14",
    "14.5",
    "15",
  ],
  Female: [
    "1",
    "1.5",
    "2",
    "2.5",
    "3",
    "3.5",
    "4",
    "4.5",
    "5",
    "5.5",
    "6",
    "6.5",
    "7",
    "7.5",
    "8",
    "8.5",
    "9",
    "9.5",
    "10",
    "10.5",
    "11",
    "11.5",
    "12",
  ],
};

export const SHOE_CATEGORY_LABELS: Record<ShoeCategory, string> = {
  Toddler: "Toddler",
  Male: "Men",
  Female: "Women",
};

/** Food items that should be displayed on the admin board */
export const FOOD_RE = /pizza\s+bowl\s+pizza|pizza\s+bowl\s+soda|chips.+salsa/i;
