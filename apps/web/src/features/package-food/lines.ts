/**
 * Stored food lines ⇄ picks — pure, no fetching.
 *
 * `bowling_reservation_lines` has no note column, so a guest's food choices are
 * folded into the label at booking (reservation-lines.ts):
 *
 *     "Pizza Bowl Pizza — Bacon"                  one lane
 *     "Pizza Bowl Pizza — Lane 2: Bacon, Pepperoni"  multi-lane
 *
 * This module reads those labels back — into `rawItems` for the server gate
 * (no catalog needed) and into per-lane selections for the editor (matching
 * option NAMES against the live catalog groups), and names the extras line.
 * Our DB is the source of truth for what the guest chose; the Square order is
 * the downstream copy. Every surface that prefills a food picker goes through
 * here so they cannot read the same row differently.
 */
import type { FoodItem, LaneSelections } from "~/features/booking/service/food-config";

/** Label separator written by reservation-lines.ts. */
export const FOOD_LABEL_SEP = " — ";
const LANE_PREFIX_RE = /^Lane (\d+):\s*/;

/**
 * The ad-hoc Square line (and Neon row) carrying paid food extras. Named for
 * what it is rather than "Extra Pizza Topping", because Square now prices
 * individual options ($2 bacon, $1 onions) and the wings have +$2 drums — a
 * per-unit "$1 topping" line cannot express that. The legacy name is still
 * RECOGNISED (bookings made before 9/6 carry it) so their paid extras count
 * toward what the guest already paid.
 */
export const EXTRAS_LINE_NAME = "Food extras";
export const EXTRAS_LINE_RE = /extra\s+pizza\s+topping|^food\s+extras$/i;

/** Sum of extras already on an order/reservation, from its line items. */
export function extrasCentsFromLines(
  lines: readonly { name?: string; label?: string; quantity: number | string; unitCents: number }[],
): number {
  return lines
    .filter((l) => EXTRAS_LINE_RE.test(l.name ?? l.label ?? ""))
    .reduce((s, l) => s + l.unitCents * Number(l.quantity || 0), 0);
}

export interface ParsedFoodLine {
  /** The food item's label, e.g. "Pizza Bowl Pizza". */
  itemLabel: string;
  /** 0-based lane, or null when the label carried no lane prefix (one lane). */
  laneIndex: number | null;
  /** The picks as written, e.g. ["Bacon", "Pepperoni"]. Empty = no choice stored. */
  picks: string[];
  /** The note as stored (lane prefix included), "" when there was none. */
  note: string;
}

/** Split one stored label against the known food item labels. Null = not food. */
export function parseFoodLineLabel(
  label: string,
  itemLabels: readonly string[],
): ParsedFoodLine | null {
  // Longest label first so "Pizza Bowl Pizza Deluxe" is not read as "Pizza Bowl Pizza".
  const sorted = [...itemLabels].sort((a, b) => b.length - a.length);
  for (const itemLabel of sorted) {
    if (label === itemLabel) return { itemLabel, laneIndex: null, picks: [], note: "" };
    if (label.startsWith(itemLabel + FOOD_LABEL_SEP)) {
      const note = label.slice(itemLabel.length + FOOD_LABEL_SEP.length).trim();
      const lane = note.match(LANE_PREFIX_RE);
      const rest = lane ? note.slice(lane[0].length) : note;
      const picks = rest
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      return {
        itemLabel,
        laneIndex: lane ? Math.max(0, parseInt(lane[1], 10) - 1) : null,
        picks,
        note,
      };
    }
  }
  return null;
}

/** Is this stored line one of the package's food lines (or its extras row)? */
export function isFoodLine(label: string, itemLabels: readonly string[]): boolean {
  return EXTRAS_LINE_RE.test(label) || parseFoodLineLabel(label, itemLabels) !== null;
}

/**
 * Rebuild `rawItems` from stored lines — what the reserve rails would have
 * sent. Needs only the experience's item config, NOT the Square catalog, which
 * is what lets the check-in gate answer "is the food on this booking?" without
 * a Square round-trip. A stored quantity > 1 expands to that many lines.
 */
export function rawItemsFromStoredLines(
  items: readonly { label: string; squareCatalogObjectId?: string | null }[],
  lines: readonly { label: string; quantity: number }[],
): Array<{ catalogObjectId: string; name: string; note?: string }> {
  const byLabel = new Map(
    items.filter((i) => !!i.squareCatalogObjectId).map((i) => [i.label, i.squareCatalogObjectId!]),
  );
  const labels = [...byLabel.keys()];
  const out: Array<{ catalogObjectId: string; name: string; note?: string }> = [];
  for (const line of lines) {
    const parsed = parseFoodLineLabel(line.label, labels);
    if (!parsed) continue;
    const catalogObjectId = byLabel.get(parsed.itemLabel)!;
    for (let n = 0; n < Math.max(1, line.quantity); n++) {
      out.push({
        catalogObjectId,
        name: parsed.itemLabel,
        ...(parsed.note ? { note: parsed.note } : {}),
      });
    }
  }
  return out;
}

/**
 * Stored lines → per-lane selections against the LIVE groups, by option name.
 *
 * Names are matched case-insensitively within the item's own groups. When the
 * same name sits in two of an item's lists (the Pizza Bowl's "One included
 * Topping" and the paid "Pizza Toppings" both list Pepperoni), the pick lands
 * in the FIRST list that still has room — so "Pepperoni" prefills the included
 * pick and "Pepperoni, Bacon" prefills included Pepperoni + paid Bacon, which is
 * how the booking step would have produced that note. A name the catalog no
 * longer carries is dropped (the guest re-picks it), never guessed.
 */
export function selectionsFromStoredLines(args: {
  foodItems: readonly FoodItem[];
  lines: readonly { label: string; quantity: number }[];
  laneCount: number;
}): LaneSelections[] {
  const lanes = Math.max(1, args.laneCount);
  const selections: LaneSelections[] = Array.from({ length: lanes }, () => ({}));
  const labels = args.foodItems.map((f) => f.name);
  // Lines without a lane prefix fill lanes in order of appearance per item.
  const nextLaneByItem = new Map<string, number>();

  for (const line of args.lines) {
    const parsed = parseFoodLineLabel(line.label, labels);
    if (!parsed) continue;
    const food = args.foodItems.find((f) => f.name === parsed.itemLabel);
    if (!food) continue;
    for (let n = 0; n < Math.max(1, line.quantity); n++) {
      const lane =
        parsed.laneIndex ??
        (() => {
          const i = nextLaneByItem.get(food.name) ?? 0;
          nextLaneByItem.set(food.name, i + 1);
          return i;
        })();
      if (lane >= lanes) continue;
      const sel = selections[lane];
      for (const pick of parsed.picks) {
        const wanted = pick.toLowerCase();
        for (const group of food.groups) {
          const opt = group.options.find((o) => o.name.toLowerCase() === wanted);
          if (!opt) continue;
          const chosen = sel[group.id] ?? [];
          if (chosen.includes(opt.id)) break;
          const room =
            group.selectionType === "SINGLE"
              ? chosen.length === 0
              : group.maxSelected == null || chosen.length < group.maxSelected;
          if (!room) continue;
          sel[group.id] = [...chosen, opt.id];
          break;
        }
      }
    }
  }
  return selections;
}
