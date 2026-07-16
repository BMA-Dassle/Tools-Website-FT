/** Card number → digits only, leading zeros dropped (the printed number often
 *  shows them but they aren't part of the Intercard account). Kept as a string. */
export function normalizeCard(raw: string): string {
  return raw.replace(/\D/g, "").replace(/^0+/, "");
}
