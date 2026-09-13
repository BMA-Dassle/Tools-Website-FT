/**
 * Read a raw-text fixture from `../fixtures`. Text in, text out — the caller
 * decides whether to `parseWithRawIds` it (Office / Pandora) or `JSON.parse`
 * it (everything without 17-digit ids). Never parse here.
 */

import { readFileSync } from "node:fs";

export function fixtureText(name: string): string {
  return readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8").trim();
}
