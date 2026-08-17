/**
 * Kiosk bowling shoe catalog — the ONE kiosk-side copy of the shoe-size
 * vocabulary, shared by the booking wizard's KioskBowlingDetailsStep and the
 * check-in flow's bowler-details screen so the two can never drift.
 *
 * Values mirror the web confirmation editor (BowlingPlayersEditor /
 * BowlingCheckin): the stored label is the canonical `"Male 9"` / `"Female 8"`
 * / `"Toddler 10"` string the players API + KDS parser expect — the CATEGORY
 * word is data vocabulary, never guest-facing copy (that's the labelKey).
 */
import type { MessageKey } from "./i18n";

export const SHOE_SIZES: Record<string, string[]> = {
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

/** Family-friendly labels over the canonical stored values (translated at render). */
export const SHOE_CATEGORIES: Array<{ value: keyof typeof SHOE_SIZES; labelKey: MessageKey }> = [
  { value: "Toddler", labelKey: "bowlingDetails.cat.toddler" },
  { value: "Male", labelKey: "bowlingDetails.cat.mens" },
  { value: "Female", labelKey: "bowlingDetails.cat.womens" },
];

/** "Own shoes" sentinel — an explicit answer that isn't a rental size.
 *  Encoded as "" in players.shoeSize; reserve/save mappings normalize "" → null
 *  so Neon/QAMF only ever see a real size or nothing. */
export const OWN_SHOES = "";

/** Category part of a stored "Male 9" value ("" for own shoes / null / unknown). */
export function categoryOf(shoeSize: string | null): string | null {
  if (shoeSize === null) return null;
  if (shoeSize === OWN_SHOES) return OWN_SHOES;
  const cat = shoeSize.split(" ")[0];
  return cat in SHOE_SIZES ? cat : null;
}
