import { describe, expect, it } from "vitest";
import {
  addDaysYmd,
  bookableDateRange,
  isKbfBookableDate,
  isKbfOffered,
  KBF_OFFSEASON_PATH,
  KBF_PROGRAM_END_YMD,
  KBF_PROGRAM_START_YMD,
} from "./kbf-schedule";

/**
 * The season gate that decides whether Kids Bowl Free is shown at all.
 *
 * Every anchor below is DERIVED from KBF_PROGRAM_START_YMD /
 * KBF_PROGRAM_END_YMD rather than hardcoded, because reopening the program is
 * meant to be "edit those two constants and nothing else". Hardcoded dates
 * would turn that one-line act into a test failure and tempt someone to weaken
 * the assertion instead of trusting it.
 */

/** ~11am ET on the given day — far from any midnight/DST boundary. */
function noonEtOn(ymd: string): Date {
  return new Date(`${ymd}T15:00:00Z`);
}

describe("isKbfOffered", () => {
  it("is true on the program's opening day", () => {
    expect(isKbfOffered(noonEtOn(KBF_PROGRAM_START_YMD))).toBe(true);
  });

  it("is true on the last day of the program", () => {
    expect(isKbfOffered(noonEtOn(KBF_PROGRAM_END_YMD))).toBe(true);
  });

  it("is FALSE the day after the program ends — the whole point of the gate", () => {
    expect(isKbfOffered(noonEtOn(addDaysYmd(KBF_PROGRAM_END_YMD, 1)))).toBe(false);
  });

  it("stays false deep into the off-season", () => {
    expect(isKbfOffered(noonEtOn(addDaysYmd(KBF_PROGRAM_END_YMD, 120)))).toBe(false);
  });

  it("is false well before the program opens", () => {
    // A year out is outside the booking horizon by any measure.
    expect(isKbfOffered(noonEtOn(addDaysYmd(KBF_PROGRAM_START_YMD, -365)))).toBe(false);
  });

  it("comes back on its own once the first date is inside the booking horizon", () => {
    // Pre-season the tile returns exactly when a parent could actually pick a
    // date — the day the horizon first reaches KBF_PROGRAM_START_YMD.
    expect(isKbfOffered(noonEtOn(addDaysYmd(KBF_PROGRAM_START_YMD, -1)))).toBe(true);
  });

  it("agrees with bookableDateRange — one source of truth, not two", () => {
    for (const offset of [-400, -30, 0, 30, 1, 200]) {
      const when = noonEtOn(addDaysYmd(KBF_PROGRAM_START_YMD, offset));
      expect(isKbfOffered(when), `offset ${offset}`).toBe(bookableDateRange(when).length > 0);
    }
  });

  it("never claims to be offered when the last in-window date has passed", () => {
    // Belt and braces: if it says "offered", a bookable date must exist.
    const when = noonEtOn(addDaysYmd(KBF_PROGRAM_END_YMD, -3));
    expect(isKbfOffered(when)).toBe(true);
    expect(bookableDateRange(when).every((d) => isKbfBookableDate(d, when))).toBe(true);
  });
});

describe("KBF_OFFSEASON_PATH", () => {
  it("points at a route that resolves on BOTH brand hosts", () => {
    // The bare /kids-bowl-free only exists on headpinz.com (middleware's /hp
    // rewrite is host-gated), and /book/kbf/v2 redirects here from the
    // FastTrax side too — so the target must carry the /hp prefix.
    expect(KBF_OFFSEASON_PATH).toBe("/hp/kids-bowl-free");
  });
});
