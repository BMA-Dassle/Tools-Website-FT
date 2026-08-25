import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

/**
 * The rule this file exists to hold: A SELL SURFACE READS A CATALOG ACCESSOR,
 * NEVER THE RAW `RACE_PACKS` ARRAY.
 *
 * `RACE_PACKS` is the whole catalog, tier-priced and limited-time SKUs included.
 * The three accessors in service/race-pack-kiosk.ts each hand back the subset
 * ONE surface may sell — `webPackSkus` and `kioskPackSkus` the standing six,
 * `packSkusForRaceDate` the standing six plus whatever promo is live for that
 * race date. Reach past them to the array and a surface silently offers SKUs it
 * has no way to hold to their restrictions.
 *
 * Not hypothetical — it happened twice, with the same two BOGO SKUs (adult
 * $20.99 / junior $15.99, told apart only by price):
 *  - the KIOSK attract screen, live 2026-08-13: a junior tapping the adult tile
 *    was CHARGED $20.99, tapping their own dead-ended at prepare. Routed through
 *    `kioskPackSkus`.
 *  - the WEB page `/book/race-pack/v2`, found 2026-08-25: same raw array, so it
 *    showed BOGO tiles EVERY day — ignoring even the promo's Wednesday rule —
 *    and its review step never asks a racer's category at all. Routed through
 *    `webPackSkus`.
 *
 * The web page has the least margin for it: that rail charges the tile's own
 * price straight through /api/square/pay and grants `raceCount` credits, with no
 * `resolveKioskPacks` step to fail closed behind the UI. There the accessor IS
 * the enforcement point.
 *
 * It is a wiring omission, not a logic bug — the array is a legitimate export
 * and every price in it is correct — so no behavioural test on the accessors
 * catches it. That is the whole point of the source assertions: the accessor
 * tests in service/bogo-sale.test.ts passed the entire time the web page was
 * rendering the array next door.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "../../..");

const read = (p: string): string => readFileSync(p, "utf8");

/**
 * Lines that are not comments. Line-based on purpose: stripping `/* … *\/`
 * across a whole file can swallow real code when a string literal contains the
 * terminator, and a FALSE NEGATIVE here is the one failure this guard must not
 * have. Every prose mention of the array in this repo sits on a line opening
 * with `*`, `//` or `{/*`.
 */
function codeLines(source: string): string {
  return source
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\/\*|\*|\{\/\*)/.test(line))
    .join("\n");
}

const usesRawArray = (source: string): boolean => /\bRACE_PACKS\b/.test(codeLines(source));

/**
 * Every component that renders buyable pack tiles, and the accessor each one is
 * required to source them from. The accessor differs BY SURFACE and the choice
 * is load-bearing, so it is pinned per file rather than "imports something":
 * the web page must not day-filter (it books no race and its credits never
 * expire), the walk-up screen must (its first credit covers today's race), and
 * only the in-booking surfaces carry a tier, so only they may sell a promo.
 *
 * RacePackPicker.tsx is deliberately absent — it takes its `skus` as a prop from
 * the two in-booking surfaces below, so it has no catalog of its own to get
 * wrong. The tree sweep at the bottom is what covers it.
 */
const SELL_SURFACES = [
  // Standing six, never day-filtered — v1 /book/race-packs parity.
  ["RacePackFlow.tsx", join(SRC, "components/features/booking/RacePackFlow.tsx"), "webPackSkus"],
  // Standing six, day-filtered on the wall clock.
  [
    "KioskRacePackFlow.tsx",
    join(SRC, "features/kiosk/components/KioskRacePackFlow.tsx"),
    "kioskPackSkus",
  ],
  // In-booking: tier-aware, so these MAY carry a live promo.
  ["CartView.tsx", join(SRC, "components/features/booking/CartView.tsx"), "packSkusForRaceDate"],
  [
    "RacePackTeaser.tsx",
    join(SRC, "components/features/booking/steps/race/RacePackTeaser.tsx"),
    "packSkusForRaceDate",
  ],
  [
    "RacePayModeStep.tsx",
    join(SRC, "components/features/booking/steps/race/RacePayModeStep.tsx"),
    "packSkusForRaceDate",
  ],
] as const;

describe("a sell surface reads a catalog accessor, never the raw array", () => {
  for (const [label, path, accessor] of SELL_SURFACES) {
    it(`${label} sources its tiles from ${accessor}`, () => {
      expect(codeLines(read(path))).toContain(accessor);
    });

    it(`${label} does not reach past it to RACE_PACKS`, () => {
      expect(usesRawArray(read(path))).toBe(false);
    });
  }
});

/** Every .ts/.tsx under src/, tests excluded. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, out);
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe("the raw array is read in exactly two places", () => {
  /**
   * `data/packs.ts` declares it and looks a slug up in it; `service/
   * race-pack-kiosk.ts` is the only module allowed to slice it. Everything else
   * goes through an accessor.
   *
   * This is the durable half of the guard, and the half that would have caught
   * the 2026-08-25 web page: the per-file list above only covers surfaces
   * somebody remembered to add. If this fails, the new consumer is either a
   * FOURTH accessor inside race-pack-kiosk.ts (fine — nothing to add here) or a
   * surface that should be calling one (not fine).
   */
  it("data/packs.ts and service/race-pack-kiosk.ts, and nothing else", () => {
    const consumers = sourceFiles(SRC)
      .filter((path) => usesRawArray(read(path)))
      .map((path) => relative(SRC, path).replace(/\\/g, "/"))
      .sort();

    expect(consumers).toEqual([
      "features/booking/data/packs.ts",
      "features/booking/service/race-pack-kiosk.ts",
    ]);
  });
});
