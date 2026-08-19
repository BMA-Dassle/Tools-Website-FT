import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

/**
 * The rule this file exists to hold: EVERY KIOSK HEAT GRID SAYS WHICH CHECK-IN
 * ITS TIMES MEAN, AND WHEN THE GUEST ACTUALLY RACES.
 *
 * The treatment shipped on the single-race grid on 2026-08-17 and was invisible
 * on the package grid — Ultimate Qualifier, BOGO, every multi-race pack — for
 * two days, because the context that carried it lived inside RaceHeatPickerStep
 * and PackageHeatPicker could not import its own parent. Same kiosk, same
 * heats, same cards; a pack guest saw a bare "7:12 PM" and read it as a race
 * time (owner 2026-08-19: "on ultimate qualifier or bogo I do not [see it]").
 *
 * It is a wiring omission, not a logic bug, so no behavioural test would have
 * caught it — hence a source assertion. If a third grid appears, this test
 * fails until it is wired too, which is the only outcome that matters here.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

const GRIDS = ["RaceHeatPickerStep.tsx", "PackageHeatPicker.tsx"] as const;

function source(file: string): string {
  return readFileSync(join(HERE, file), "utf8");
}

describe.each(GRIDS)("%s — the kiosk karting treatment", (file) => {
  const src = source(file);

  it("reads the shared karting context rather than mounting its own poller", () => {
    // Shared on purpose: a hook per grid is a second /api/track-status poll
    // behind the same screen, and a hook per CARD would be twenty.
    expect(src).toContain("useKartingCheckIn");
    expect(src).not.toContain("useTrackStatus");
  });

  it("labels the big time as karting check-in", () => {
    expect(src).toContain("race.heat.kartingCheckIn");
  });

  it("shows the racing-by estimate on the card", () => {
    // Both halves matter: raceByAtMs is today's measured allowance, and the
    // "Est." in the catalog string is what keeps it from reading as a promise.
    expect(src).toContain("race.heat.racingBy");
    expect(src).toContain("raceByAtMs");
  });

  it("explains the times once above the grid", () => {
    expect(src).toContain("KartingCheckInBanner");
  });

  it("keeps all of it off web", () => {
    // The provider is mounted by the kiosk step variants only. A grid that
    // renders these unconditionally would stamp "Karting Check In" on a web
    // card and send a standard guest to the wrong floor.
    expect(src).toContain("kartingEnabled &&");
  });
});
