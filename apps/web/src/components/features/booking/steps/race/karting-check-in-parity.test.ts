import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

/**
 * The rule this file exists to hold: EVERY KIOSK SURFACE THAT SHOWS A RACE SLOT
 * TIME SAYS WHICH CHECK-IN IT MEANS, AND WHEN THE GUEST ACTUALLY RACES.
 *
 * The treatment shipped on the single-race grid on 2026-08-17 and reached
 * nothing else, because the context carrying it lived inside RaceHeatPickerStep
 * and no sibling could import it. Two days later the packages (Ultimate
 * Qualifier, BOGO, Rookie Pack) and the VIP combo were still printing a bare
 * "7:12 PM" off the same BMI session slots — the exact defect the label exists
 * to prevent, shown to the guests with the MOST to plan around (owner
 * 2026-08-19: "on ultimate qualifier or bogo I do not [see it]").
 *
 * It is a wiring omission, not a logic bug: nothing computes a wrong value, the
 * copy is simply absent, so no behavioural test would catch it. Hence source
 * assertions. If a fifth surface appears, this fails until it is wired too.
 *
 * TWO TIERS, because the surfaces genuinely differ:
 *  - PICKER GRIDS carry the whole treatment, banner included. The banner is
 *    where "not your race time · allow up to N min" is actually explained.
 *  - LABELLED SURFACES carry the label + the estimate but not the banner. The
 *    combo's anchor can be the BOWLING leg (the reorder fallback runs races
 *    first), so a blanket "be at the Karting Desk by the time you pick" would
 *    be wrong on some cards; the Race Info hub is a browse board with its own
 *    live status band above it.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "../../../../..");

const read = (p: string): string => readFileSync(p, "utf8");

/** Full treatment: label + estimate + the banner that explains them. */
const PICKER_GRIDS = ["RaceHeatPickerStep.tsx", "PackageHeatPicker.tsx"] as const;

/** Label + estimate, no banner — see the note above. */
const LABELLED_SURFACES = [
  ["ComboSteps.tsx", join(SRC, "components/features/booking/steps/combo/ComboSteps.tsx")],
  ["UpcomingRaces.tsx", join(SRC, "features/kiosk/components/race-info/UpcomingRaces.tsx")],
] as const;

describe.each(PICKER_GRIDS)("%s — the full kiosk karting treatment", (file) => {
  const src = read(join(HERE, file));

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

describe.each(LABELLED_SURFACES)("%s — labelled race times", (_name, path) => {
  const src = read(path);

  it("labels the time as karting check-in", () => {
    expect(src).toContain("race.heat.kartingCheckIn");
  });

  it("shows the racing-by estimate", () => {
    expect(src).toContain("race.heat.racingBy");
    expect(src).toContain("raceByAtMs");
  });
});

describe("ComboSteps.tsx — the leg-kind guard", () => {
  const src = read(join(SRC, "components/features/booking/steps/combo/ComboSteps.tsx"));

  it("only labels RACE legs, never the bowling lane", () => {
    // The reorder fallback ("races first · lane after") can anchor the visit on
    // the bowling leg. A karting estimate over a lane time is worse than the
    // bare time it replaced — it sends the guest to the wrong desk.
    expect(src).toContain("isAnchorRace");
    expect(src).toContain('leg.kind === "race"');
  });

  it("keeps it off web", () => {
    expect(src).toContain("kartingEnabled &&");
    expect(src).toContain("useKartingCheckIn");
  });
});

describe("the kiosk registry", () => {
  const src = read(join(SRC, "features/kiosk/state/registry.ts"));

  it("mounts the karting provider on every step that shows a slot time", () => {
    // combo-start is the one that was missed: a combo REPLACES the heat pickers
    // with its own grid, so swapping only the heat-picker steps left it bare.
    expect(src).toContain("withKartingCheckIn");
    expect(src).toContain('"combo-start"');
    expect(src).toContain("RaceHeatPickerStepAdultKiosk");
    expect(src).toContain("RaceHeatPickerStepJuniorKiosk");
  });
});
