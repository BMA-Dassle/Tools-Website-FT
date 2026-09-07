/**
 * Package food on a booked reservation (Pizza Bowl pizza + pitcher, NFL
 * game-day items): read it back, gate the lane on it, edit it.
 *
 * Client-safe exports only here. Server code imports "./service" directly.
 */
export {
  EXTRAS_LINE_NAME,
  EXTRAS_LINE_RE,
  extrasCentsFromLines,
  isFoodLine,
  parseFoodLineLabel,
  rawItemsFromStoredLines,
  selectionsFromStoredLines,
} from "./lines";
export type { ReservationFoodState, FoodEditResult } from "./service";
