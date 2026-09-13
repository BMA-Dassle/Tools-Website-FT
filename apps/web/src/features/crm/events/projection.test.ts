import { describe, expect, it } from "vitest";
import type { EventFoodOut, EventLeadLink } from "./contracts";
import {
  bandTotals,
  contractView,
  dayRange,
  eventPill,
  isCancelledState,
  isPastUnpaid,
  mergeEventRows,
  stepDate,
  type BoardQuote,
  type BoardReservation,
} from "./projection";

/**
 * The board merge — BMI truth plus the contract's money pill
 * (`crm-events.js:246`, in its order and with its words).
 */

function quote(over: Partial<BoardQuote> = {}): BoardQuote {
  return {
    bmi_reservation_id: "58454076",
    contract_short_id: "7Hx2Qk",
    status: "contract_sent",
    total_cents: 189000,
    tax_cents: 11750,
    deposit_due_cents: 100375,
    balance_cents: 100375,
    collected_cents: 0,
    deposit_paid_at: null,
    contract_signed_at: null,
    contract_sent_at: "2026-09-10T13:06:00.000Z",
    balance_paid_at: null,
    square_dayof_order_id: null,
    square_gift_card_gan: null,
    ...over,
  };
}

function reservation(over: Partial<BoardReservation> = {}): BoardReservation {
  return {
    id: "58454076",
    number: "H2879",
    name: "Ruiz birthday",
    personName: "Angela Ruiz",
    persons: 24,
    when: "2026-09-19T16:00:00",
    state: "Send Contract",
    stateId: "49130082",
    responsible: "Kelsea Kosco",
    balance: 890,
    registeredPersons: 3,
    kind: "Group function",
    ...over,
  };
}

describe("eventPill — the ladder, in the prototype's order", () => {
  it("no contract at all", () => {
    expect(eventPill(null)).toEqual({
      kind: "none",
      label: "no contract",
      chip: null,
      gfStatus: null,
    });
  });

  it("PAID: nothing outstanding and money collected", () => {
    const c = contractView(quote({ balance_cents: 0, collected_cents: 189000 }));
    expect(eventPill(c)).toMatchObject({ kind: "paid", label: "PAID", chip: "won" });
  });

  it("a zero balance with NOTHING collected is not PAID — a post-paid event has both", () => {
    const c = contractView(
      quote({ balance_cents: 0, collected_cents: 0, deposit_due_cents: 0, status: "pending" }),
    );
    expect(eventPill(c).kind).not.toBe("paid");
    expect(eventPill(c)).toMatchObject({ kind: "gf", label: "Pending" });
    expect(c.postPaid).toBe(true);
  });

  it("DEPOSIT: signed and the deposit is in, balance still owed", () => {
    const c = contractView(
      quote({ status: "deposit_paid", deposit_paid_at: "2026-09-11T14:00:00.000Z" }),
    );
    expect(eventPill(c)).toMatchObject({ kind: "deposit", label: "DEPOSIT", chip: "won" });
  });

  it("UNSIGNED: out with the guest and nothing paid", () => {
    expect(eventPill(contractView(quote()))).toMatchObject({
      kind: "unsigned",
      label: "UNSIGNED",
      chip: "warn",
    });
  });

  it("anything else falls back to the GF chip — and balance_charged is 'Balance funded'", () => {
    const c = contractView(quote({ status: "balance_charged", balance_cents: 0 }));
    // balance 0 but nothing collected on this fixture, so the ladder reaches the chip.
    expect(eventPill(c)).toMatchObject({
      kind: "gf",
      label: "Balance funded",
      chip: "won",
      gfStatus: "balance_charged",
    });
    expect(eventPill(contractView(quote({ status: "resign_required" }))).label).toBe(
      "Re-sign required",
    );
  });

  it("an unknown status from the DB degrades to 'pending' rather than throwing", () => {
    expect(contractView(quote({ status: "something_new" })).status).toBe("pending");
  });
});

describe("mergeEventRows", () => {
  const foodOut: EventFoodOut = {
    time: "4:45 PM",
    source: "manual",
    confidence: "high",
    reasoning: null,
    updatedAt: "2026-09-12T12:00:00.000Z",
  };
  const lead: EventLeadLink = {
    publicId: "L-1048",
    id: "1048",
    status: "contract",
    repName: "Kelsea Kosco",
    repSlug: "kelsea",
    guestPhone: "+12395551234",
  };

  const base = {
    centre: "HPFM" as const,
    quotesByProjectId: new Map([["58454076", quote()]]),
    leadsByProjectId: new Map([["58454076", lead]]),
    foodOutByProjectId: new Map([["58454076", foodOut]]),
    includeCancelled: false,
  };

  it("layers contract, lead and food out onto the BMI row", () => {
    const [row] = mergeEventRows({ ...base, reservations: [reservation()] });
    expect(row.projectId).toBe("58454076");
    expect(row.number).toBe("H2879");
    expect(row.registered).toBe(3);
    expect(row.persons).toBe(24);
    expect(row.contract?.shortId).toBe("7Hx2Qk");
    expect(row.lead?.publicId).toBe("L-1048");
    expect(row.foodOut.time).toBe("4:45 PM");
    expect(row.pill.label).toBe("UNSIGNED");
    expect(row.totalCents).toBe(189000);
  });

  it("an event with no lead and no contract still renders, with the totals BMI knows", () => {
    const [row] = mergeEventRows({
      ...base,
      quotesByProjectId: new Map(),
      leadsByProjectId: new Map(),
      foodOutByProjectId: new Map(),
      reservations: [reservation({ id: "99", balance: 250 })],
    });
    expect(row.lead).toBeNull();
    expect(row.contract).toBeNull();
    expect(row.pill.kind).toBe("none");
    expect(row.totalCents).toBe(25000);
    expect(row.collectedCents).toBe(0);
    expect(row.foodOut.time).toBeNull();
  });

  it("hides cancelled events unless asked, and flags them when shown", () => {
    const cancelled = reservation({ id: "77", state: "Cancellation" });
    expect(mergeEventRows({ ...base, reservations: [cancelled] })).toHaveLength(0);
    const [row] = mergeEventRows({ ...base, reservations: [cancelled], includeCancelled: true });
    expect(row.cancelled).toBe(true);
    expect(isCancelledState("Cancellation")).toBe(true);
    expect(isCancelledState("Confirmation")).toBe(false);
  });

  it("sorts by start time", () => {
    const rows = mergeEventRows({
      ...base,
      reservations: [
        reservation({ id: "b", number: "H2", when: "2026-09-19T20:00:00" }),
        reservation({ id: "a", number: "H1", when: "2026-09-19T11:00:00" }),
      ],
    });
    expect(rows.map((r) => r.number)).toEqual(["H1", "H2"]);
  });
});

describe("bandTotals + isPastUnpaid", () => {
  const rows = mergeEventRows({
    centre: "HPFM",
    reservations: [reservation(), reservation({ id: "x", number: "H3", persons: 10 })],
    quotesByProjectId: new Map([
      ["58454076", quote({ collected_cents: 100375 })],
      [
        "x",
        quote({
          bmi_reservation_id: "x",
          total_cents: 50000,
          collected_cents: 50000,
          balance_cents: 0,
        }),
      ],
    ]),
    leadsByProjectId: new Map(),
    foodOutByProjectId: new Map(),
    includeCancelled: false,
  });

  it("sums persons and both money columns", () => {
    expect(bandTotals(rows)).toEqual({
      persons: 34,
      totalCents: 239000,
      collectedCents: 150375,
    });
    expect(bandTotals([])).toEqual({ persons: 0, totalCents: 0, collectedCents: 0 });
  });

  it("a past event with money still owed turns red; a completed one does not", () => {
    const past = { ...rows[0], when: "2026-09-01T16:00:00" };
    expect(isPastUnpaid(past, "2026-09-12")).toBe(true);
    expect(isPastUnpaid(rows[0], "2026-09-12")).toBe(false);
    expect(
      isPastUnpaid({ ...past, contract: { ...past.contract!, status: "completed" } }, "2026-09-12"),
    ).toBe(false);
    expect(isPastUnpaid({ ...past, contract: null }, "2026-09-12")).toBe(false);
  });
});

describe("dayRange / stepDate", () => {
  it("a day is one date; a week is that date plus six, across a month end", () => {
    expect(dayRange("2026-09-30", "day")).toEqual(["2026-09-30"]);
    expect(dayRange("2026-09-30", "week")).toEqual([
      "2026-09-30",
      "2026-10-01",
      "2026-10-02",
      "2026-10-03",
      "2026-10-04",
      "2026-10-05",
      "2026-10-06",
    ]);
  });

  it("prev / next move a whole band", () => {
    expect(stepDate("2026-09-16", "week", 1)).toBe("2026-09-23");
    expect(stepDate("2026-09-16", "week", -1)).toBe("2026-09-09");
    expect(stepDate("2026-09-16", "day", 1)).toBe("2026-09-17");
    // DST is not a trap here: shiftYmd anchors at UTC midday.
    expect(stepDate("2026-11-01", "day", -1)).toBe("2026-10-31");
  });
});
