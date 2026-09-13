import { describe, expect, it } from "vitest";
import type { EventDayBand, EventRowView } from "~/features/crm/events/contracts";
import { bandMoney, bandSummary, bandTitle, eventMetaParts, rangeLabel, rowTint } from "./model";

/**
 * The board's strings and the row tint. Dates are CALENDAR text throughout: an
 * event on the 16th reads "Wed, Sep 16" whatever timezone the laptop is in.
 */

function row(over: Partial<EventRowView> = {}): EventRowView {
  return {
    projectId: "1",
    number: "H2879",
    title: "Ruiz birthday",
    personName: "Angela Ruiz",
    when: "2026-09-16T16:00:00",
    persons: 24,
    registered: 3,
    stateName: "Send Contract",
    stateId: "49130082",
    responsible: "Kelsea Kosco",
    centre: "HPFM",
    balance: 890,
    totalCents: 189000,
    collectedCents: 0,
    foodOut: { time: null, source: null, confidence: null, reasoning: null, updatedAt: null },
    lead: null,
    contract: null,
    pill: { kind: "none", label: "no contract", chip: null, gfStatus: null },
    cancelled: false,
    ...over,
  };
}

function band(over: Partial<EventDayBand> = {}): EventDayBand {
  return {
    date: "2026-09-16",
    isToday: false,
    events: [],
    persons: 0,
    totalCents: 0,
    collectedCents: 0,
    error: null,
    ...over,
  };
}

describe("bandTitle", () => {
  it("weekday, month and day — with the prototype's Today suffix", () => {
    expect(bandTitle(band())).toBe("Wed, Sep 16");
    expect(bandTitle(band({ isToday: true }))).toBe("Wed, Sep 16 — Today");
    expect(bandTitle(band({ date: "2026-01-01" }))).toBe("Thu, Jan 1");
  });
});

describe("rangeLabel", () => {
  it("the week strip's header, and a single day for the day view", () => {
    expect(rangeLabel(["2026-09-16", "2026-09-22"])).toBe("Wed Sep 16 – Tue Sep 22");
    expect(rangeLabel(["2026-09-16"])).toBe("Wed Sep 16");
    expect(rangeLabel([])).toBe("");
  });
});

describe("bandSummary / bandMoney", () => {
  it("counts events and persons, pluralised", () => {
    expect(bandSummary(band())).toBe("no group events");
    expect(bandSummary(band({ events: [row()] }))).toBe("1 event · 24 persons");
    expect(bandSummary(band({ events: [row(), row({ projectId: "2", persons: 1 })] }))).toBe(
      "2 events · 25 persons",
    );
  });

  it("a day BMI could not be read says so rather than 'no group events'", () => {
    expect(bandSummary(band({ error: "Office 503" }))).toBe("BMI could not be read for this day");
  });

  it("collected over booked", () => {
    expect(bandMoney(band({ collectedCents: 100375, totalCents: 189000 }))).toBe("$1,004 / $1,890");
  });
});

describe("eventMetaParts", () => {
  it("time, registration, the rep and the food-out line when there is one", () => {
    expect(
      eventMetaParts(
        row({
          lead: {
            publicId: "L-1",
            id: "1",
            status: "contract",
            repName: "Kelsea Kosco",
            repSlug: "kelsea",
            guestPhone: null,
          },
          foodOut: {
            time: "4:45 PM",
            source: "manual",
            confidence: null,
            reasoning: null,
            updatedAt: null,
          },
        }),
      ),
    ).toEqual(["4:00 PM", "3/24 registered", "Kelsea Kosco", "Food out 4:45 PM"]);
  });

  it("falls back to BMI's responsible when there is no lead, and omits an unknown food out", () => {
    expect(eventMetaParts(row())).toEqual(["4:00 PM", "3/24 registered", "Kelsea Kosco"]);
    expect(eventMetaParts(row({ registered: null }))).toContain("0/24 registered");
  });
});

describe("rowTint", () => {
  const unsigned = {
    kind: "unsigned" as const,
    label: "UNSIGNED",
    chip: "warn" as const,
    gfStatus: null,
  };
  const contract = {
    shortId: "7Hx2Qk",
    status: "contract_sent" as const,
    totalCents: 189000,
    taxCents: 0,
    depositDueCents: 100375,
    balanceCents: 100375,
    collectedCents: 0,
    depositPaidAt: null,
    signedAt: null,
    sentAt: null,
    balancePaidAt: null,
    dayofOrderId: null,
    giftCardGan: null,
    postPaid: false,
  };

  it("a contract still out is amber", () => {
    expect(rowTint(row({ pill: unsigned, contract }), "2026-09-12")).toBe("urg-warn");
  });

  it("a past event left unpaid is red — that beats amber", () => {
    const past = row({ pill: unsigned, contract, when: "2026-09-01T16:00:00" });
    expect(rowTint(past, "2026-09-12")).toBe("urg-crit");
  });

  it("an ordinary upcoming row is untinted", () => {
    expect(rowTint(row(), "2026-09-12")).toBe("");
  });
});
