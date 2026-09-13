import { describe, expect, it } from "vitest";
import type { QuoteLine, QuoteLineStatus } from "~/features/crm/bmi/contracts";
import {
  canForceLine,
  heatClass,
  lineErrorText,
  linesCaption,
  liveLines,
  parseHoldHint,
  parseLaneRange,
  projectLabel,
  quoteTotalCents,
  stampFor,
  statusChip,
  unwrittenCount,
} from "./model";

/**
 * The builder screen's pure helpers — every sentence a rep reads about a write.
 */

function line(patch: Partial<QuoteLine> = {}): QuoteLine {
  return {
    id: "1",
    leadId: "1",
    bmiProjectId: null,
    productId: "100",
    productName: "Race pack",
    nameOverride: null,
    quantity: 2,
    pricePerUnitCents: 2499,
    priceDate: "2026-10-17",
    resourceId: null,
    scheduleBlocks: [],
    bmiProjectProductId: null,
    bmiScheduleIds: [],
    status: "pending",
    writeError: null,
    officePrompt: null,
    actorEmail: "kelsea@headpinz.com",
    createdAt: "2026-09-13T12:00:00.000Z",
    updatedAt: "2026-09-13T12:00:00.000Z",
    ...patch,
  };
}

describe("totals", () => {
  it("sums quantity × price and ignores removed lines", () => {
    const lines = [
      line({ id: "1", quantity: 2, pricePerUnitCents: 2499 }),
      line({ id: "2", quantity: 1, pricePerUnitCents: 5000 }),
      line({ id: "3", quantity: 9, pricePerUnitCents: 9999, status: "removed" }),
    ];
    expect(quoteTotalCents(lines)).toBe(2 * 2499 + 5000);
    expect(liveLines(lines)).toHaveLength(2);
  });

  it("counts everything Office has not accepted", () => {
    expect(
      unwrittenCount([
        line({ id: "1", status: "written" }),
        line({ id: "2", status: "pending" }),
        line({ id: "3", status: "failed" }),
        line({ id: "4", status: "paused" }),
        line({ id: "5", status: "removed" }),
      ]),
    ).toBe(3);
  });

  it("captions the table without hiding a pending line", () => {
    expect(linesCaption([line({ status: "written" })])).toBe("1 line");
    expect(linesCaption([line({ id: "1", status: "written" }), line({ id: "2" })])).toBe(
      "2 lines · 1 not in BMI",
    );
  });
});

describe("what a line's state SAYS", () => {
  it("only `written` claims BMI has it", () => {
    const claims = (s: QuoteLineStatus) => statusChip(s).label;
    expect(claims("written")).toBe("In BMI");
    expect(claims("pending")).toBe("Not sent");
    expect(claims("failed")).toBe("Refused");
    expect(claims("paused")).toBe("Writes paused");
    expect(claims("removed")).toBe("Removed");
  });

  it("a refusal shows OFFICE'S own sentence, not ours", () => {
    const refused = line({
      status: "failed",
      writeError: "This heat is full — pick another.",
      officePrompt: {
        message: "Total persons (12) is higher than the capacity (0) in HP Arena.",
      },
    });
    expect(lineErrorText(refused)).toBe(
      "Total persons (12) is higher than the capacity (0) in HP Arena.",
    );
  });

  it("falls back to our own wording when Office gave none", () => {
    expect(lineErrorText(line({ status: "failed", writeError: "Office answered 500" }))).toBe(
      "Office answered 500",
    );
    expect(lineErrorText(line({ status: "failed" }))).toBe("Office refused this line.");
    expect(lineErrorText(line({ status: "written" }))).toBeNull();
  });

  it("Force appears only for a director, and only on a real refusal", () => {
    const refused = line({ status: "failed", officePrompt: { message: "full" } });
    expect(canForceLine(refused, true)).toBe(true);
    // A rep never sees it — overbooking is a director's call.
    expect(canForceLine(refused, false)).toBe(false);
    // Nor does a director, on a failure that is not a capacity refusal.
    expect(canForceLine(line({ status: "failed" }), true)).toBe(false);
    expect(canForceLine(line({ status: "pending" }), true)).toBe(false);
  });
});

describe("the availability hand-off", () => {
  it("parses the en-dash range `runLabel` actually emits", () => {
    expect(parseLaneRange("13–15")).toEqual([13, 14, 15]);
    expect(parseLaneRange("13-15")).toEqual([13, 14, 15]);
    expect(parseLaneRange("13")).toEqual([13]);
  });

  it("drops a mangled parameter rather than refusing to load", () => {
    expect(parseLaneRange("")).toEqual([]);
    expect(parseLaneRange("15-13")).toEqual([]);
    expect(parseLaneRange("nonsense")).toEqual([]);
    expect(parseLaneRange("1-999")).toEqual([]);
  });

  it("reads the whole hint availability sends", () => {
    expect(parseHoldHint({ lanes: "13–15", start: "1080", section: "Regular" })).toEqual({
      lanes: [13, 14, 15],
      start: 1080,
      section: "Regular",
    });
  });

  it("keeps a bad start out rather than landing the picker at midnight", () => {
    expect(parseHoldHint({ start: "9999" }).start).toBeNull();
    expect(parseHoldHint({ start: "-1" }).start).toBeNull();
    expect(parseHoldHint({}).start).toBeNull();
  });
});

describe("time", () => {
  it("builds the centre-local stamp with no offset and never a Date", () => {
    expect(stampFor("2026-10-17", 18 * 60)).toBe("2026-10-17T18:00:00");
    expect(stampFor("2026-10-17", 0)).toBe("2026-10-17T00:00:00");
    expect(stampFor("2026-10-17", 23 * 60 + 59)).toBe("2026-10-17T23:59:00");
  });

  it("clamps rather than rolling into the next day", () => {
    // An evening that quietly becomes tomorrow is the `bookedAt` bug.
    expect(stampFor("2026-10-17", 24 * 60)).toBe("2026-10-17T23:59:00");
    expect(stampFor("2026-10-17", -5)).toBe("2026-10-17T00:00:00");
  });
});

describe("labels", () => {
  it("heat colour follows free seats, not capacity", () => {
    expect(heatClass(0, 14)).toBe("full");
    expect(heatClass(3, 14)).toBe("low");
    expect(heatClass(10, 14)).toBe("ok");
    expect(heatClass(1, 1)).toBe("ok");
  });

  it("is honest when there is no project", () => {
    expect(projectLabel("H3311", "630")).toBe("H3311");
    expect(projectLabel(null, "630")).toBe("Project 630");
    expect(projectLabel(null, null)).toBe("Not in BMI yet");
  });
});
