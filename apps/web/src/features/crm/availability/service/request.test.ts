import { describe, expect, it } from "vitest";
import type { AvailabilityLead } from "../contracts";
import {
  DEFAULT_CENTRE,
  DEFAULT_DURATION_MIN,
  DEFAULT_GUESTS,
  DEFAULT_START_MIN,
  resolveRequest,
  snapToSlot,
} from "./request";

const LEAD: AvailabilityLead = {
  publicId: "L-1042",
  title: "Lee Health",
  centre: "HPN",
  eventDate: "2026-10-17",
  eventTime: "18:00:00",
  guests: 60,
  statusId: "quote",
};

const TODAY = "2026-09-13";

describe("snapToSlot", () => {
  it("snaps DOWN to the half hour the request bar can show", () => {
    expect(snapToSlot(18 * 60)).toBe(1080);
    // 6:15 is a 6:00 block as far as the front desk is concerned; rounding UP
    // would answer a question nobody asked and skip the half hour they wanted.
    expect(snapToSlot(18 * 60 + 15)).toBe(1080);
    expect(snapToSlot(18 * 60 + 29)).toBe(1080);
    expect(snapToSlot(18 * 60 + 30)).toBe(1110);
    expect(snapToSlot(-5)).toBe(0);
  });
});

describe("resolveRequest", () => {
  it("falls back to sensible defaults with neither a lead nor a query", () => {
    expect(resolveRequest({}, null, TODAY)).toEqual({
      centre: DEFAULT_CENTRE,
      date: TODAY,
      start: DEFAULT_START_MIN,
      dur: DEFAULT_DURATION_MIN,
      guests: DEFAULT_GUESTS,
      // "Wherever it fits" is the default; a section is a live choice on a call.
      section: null,
    });
  });

  it("reads the lead's own centre, date, time and guest count", () => {
    expect(resolveRequest({}, LEAD, TODAY)).toEqual({
      centre: "HPN",
      date: "2026-10-17",
      start: 18 * 60,
      dur: DEFAULT_DURATION_MIN,
      guests: 60,
      section: null,
    });
  });

  it("lets the URL beat the lead, because the link is the saved view", () => {
    // A planner who drags the start to 7 PM and sends the link must have their
    // colleague see 7 PM, not the lead's original 6.
    expect(
      resolveRequest({ start: 19 * 60, dur: 180, guests: 90, centre: "HPFM" }, LEAD, TODAY),
    ).toEqual({
      centre: "HPFM",
      date: "2026-10-17",
      start: 19 * 60,
      dur: 180,
      guests: 90,
      section: null,
    });
  });

  /**
   * Owner, 2026-09-14: "Need to be able to select what type of lanes they
   * want." The verdict prefers a non-VIP section so the premium lanes stay
   * sellable — right as a default, wrong when somebody is selling VIP.
   */
  it("carries a chosen lane section, and treats blank as 'anywhere'", () => {
    expect(resolveRequest({ section: "VIP" }, null, TODAY).section).toBe("VIP");
    expect(resolveRequest({ section: "  Old Time Lanes  " }, null, TODAY).section).toBe(
      "Old Time Lanes",
    );
    // An empty or whitespace-only value is the same as not asking.
    expect(resolveRequest({ section: "   " }, null, TODAY).section).toBeNull();
    expect(resolveRequest({ section: "" }, null, TODAY).section).toBeNull();
  });

  it("never takes a section from the LEAD — it is a decision, not a property", () => {
    expect(resolveRequest({}, LEAD, TODAY).section).toBeNull();
  });

  it("handles a lead with no time on it", () => {
    expect(resolveRequest({}, { ...LEAD, eventTime: null }, TODAY).start).toBe(DEFAULT_START_MIN);
  });
});
