import { describe, expect, it } from "vitest";
import { fasttraxHoursFor } from "~/lib/constants/fasttrax-hours";

/**
 * MegaTrackTuesdayJsonLd advertises a DATED event (the next Mega Tuesday), so
 * its hours must come from THAT date, never from today.
 *
 * Shipped wrong on 2026-08-05: keyed off `etDateIso()` (today, 08-05, still the
 * 1 PM era) the schema published `startDate: 2026-08-11T13:00` for a Tuesday
 * that actually opens at 3 PM — the 08-10 switchover fell between the two. Google
 * would have been told the wrong opening time for the very next Mega day.
 *
 * This locks the rule that made it wrong: across an era boundary, "today" and
 * "the occurrence" disagree, and only the occurrence is correct.
 */
describe("Mega Tuesday event hours resolve from the OCCURRENCE date", () => {
  const TUESDAY = 2;
  // 2026-08-05 = Wed (1 PM era). Its next Tuesday is 2026-08-11 (3 PM era).
  const TODAY_BEFORE_SWITCHOVER = "2026-08-05";
  const NEXT_MEGA_TUESDAY = "2026-08-11";

  it("the two dates genuinely straddle the switchover (guards the premise)", () => {
    expect(fasttraxHoursFor(TUESDAY, TODAY_BEFORE_SWITCHOVER).openMinutes).toBe(13 * 60);
    expect(fasttraxHoursFor(TUESDAY, NEXT_MEGA_TUESDAY).openMinutes).toBe(15 * 60);
  });

  it("uses the occurrence's 3 PM open, not today's 1 PM", () => {
    const advertised = fasttraxHoursFor(TUESDAY, NEXT_MEGA_TUESDAY);
    expect(advertised.openMinutes).toBe(15 * 60);
    expect(advertised.openMinutes).not.toBe(
      fasttraxHoursFor(TUESDAY, TODAY_BEFORE_SWITCHOVER).openMinutes,
    );
  });

  it("close time is unaffected by the switchover", () => {
    expect(fasttraxHoursFor(TUESDAY, NEXT_MEGA_TUESDAY).closeMinutes).toBe(23 * 60);
  });
});
