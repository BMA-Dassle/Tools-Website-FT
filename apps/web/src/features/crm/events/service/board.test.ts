import { describe, expect, it, vi } from "vitest";
import type { Reservation } from "~/features/daily-events/types";
import type { LeadView } from "~/features/crm/leads/contracts";
import type { EventFoodOut } from "../contracts";
import type { BoardQuote } from "../projection";

/** Redis is the Office token cache; there is no server in CI (transport.test.ts idiom). */
vi.mock("@/lib/redis", () => ({
  default: {
    get: async () => null,
    setex: async () => "OK",
    set: async () => "OK",
    on: () => undefined,
  },
}));

const { eventsBoard, leadLink, resolveBoardDate } = await import("./board");
const { defaultBoardDeps } = await import("./board");

const HPFM_LOCATION = 332160;

function res(over: Partial<Reservation> = {}): Reservation {
  return {
    id: "1",
    number: "H1",
    kind: "Group function",
    name: "Ruiz birthday",
    personName: "Angela Ruiz",
    persons: 24,
    when: "2026-09-16T16:00:00",
    state: "Send Contract",
    stateId: "49130082",
    responsible: "Kelsea Kosco",
    balance: 890,
    _isDayPlannerBlock: false,
    ...over,
  };
}

function quote(id: string, over: Partial<BoardQuote> = {}): BoardQuote & { event_day: string } {
  return {
    bmi_reservation_id: id,
    contract_short_id: "7Hx2Qk",
    status: "deposit_paid",
    total_cents: 189000,
    tax_cents: 11750,
    deposit_due_cents: 100375,
    balance_cents: 88625,
    collected_cents: 100375,
    deposit_paid_at: "2026-09-11T14:00:00.000Z",
    contract_signed_at: "2026-09-11T13:50:00.000Z",
    contract_sent_at: "2026-09-10T13:06:00.000Z",
    balance_paid_at: null,
    square_dayof_order_id: null,
    square_gift_card_gan: null,
    event_day: "2026-09-16",
    ...over,
  };
}

function lead(projectId: string): LeadView {
  return {
    id: "1048",
    publicId: "L-1048",
    contactId: "5",
    accountId: null,
    centre: "HPFM",
    eventDate: "2026-09-16",
    eventTime: "16:00",
    guests: 24,
    type: "birthday",
    source: "web",
    isProspect: false,
    status: "contract",
    rep: "3",
    assignedAt: null,
    heldForRep: null,
    firstTouchAt: null,
    guestIntroAt: null,
    nextAction: null,
    valueCents: 189000,
    lostReason: null,
    notes: null,
    bmi: {
      projectId,
      projectNumber: "H1",
      stateId: "49130082",
      stateName: "Send Contract",
      personId: "63000000009561437",
      syncedAt: null,
    },
    mintStatus: "minted",
    mintError: null,
    mintAttempts: 1,
    gfShortId: "7Hx2Qk",
    lastYearBmiProjectId: null,
    coldRowId: null,
    createdBy: null,
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-01T10:00:00.000Z",
    archivedAt: null,
    kids: true,
    guest: {
      first: "Angela",
      last: "Ruiz",
      phone: "+12395551234",
      email: "angela@example.com",
      company: null,
      prefers: "text",
    },
    repSlug: "kelsea",
    repName: "Kelsea Kosco",
    // B7 made this a required field on LeadView; an events fixture has no
    // guest request of its own.
    requestedRep: null,
  };
}

const FOOD_OUT: EventFoodOut = {
  time: "4:45 PM",
  source: "manual",
  confidence: "high",
  reasoning: null,
  updatedAt: "2026-09-12T12:00:00.000Z",
};

interface Calls {
  days: string[];
  quoteCalls: number;
  leadCalls: number;
  foodOutCalls: number;
  projectIds: string[];
}

function deps(
  byDate: Record<string, Reservation[] | Error>,
  calls: Calls,
  quotes: Array<BoardQuote & { event_day: string }> = [],
  leads: LeadView[] = [],
) {
  return {
    listDailyEvents: async (locationId: number, date: string) => {
      expect(locationId).toBe(HPFM_LOCATION);
      calls.days.push(date);
      const day = byDate[date];
      if (day instanceof Error) throw day;
      return { reservations: day ?? [] };
    },
    listQuotes: async (_dates: string[], centerCodes: string[]) => {
      calls.quoteCalls += 1;
      expect(centerCodes).toEqual(["fort-myers"]);
      return quotes;
    },
    listLeads: async (projectIds: string[]) => {
      calls.leadCalls += 1;
      calls.projectIds = projectIds;
      return leads;
    },
    listFoodOut: async () => {
      calls.foodOutCalls += 1;
      return new Map<string, EventFoodOut>([["1", FOOD_OUT]]);
    },
    now: () => new Date("2026-09-16T16:00:00.000Z"),
  };
}

function emptyCalls(): Calls {
  return { days: [], quoteCalls: 0, leadCalls: 0, foodOutCalls: 0, projectIds: [] };
}

describe("eventsBoard", () => {
  it("a week is seven bands, one BMI read per day and ONE quote/lead/food-out read for the band", async () => {
    const calls = emptyCalls();
    const board = await eventsBoard(
      { centre: "HPFM", view: "week", date: "2026-09-16", includeCancelled: false },
      deps({ "2026-09-16": [res()] }, calls, [quote("1")], [lead("1")]),
    );

    expect(board.days).toHaveLength(7);
    expect(calls.days).toHaveLength(7);
    expect(calls.quoteCalls).toBe(1);
    expect(calls.leadCalls).toBe(1);
    expect(calls.foodOutCalls).toBe(1);
    expect(calls.projectIds).toEqual(["1"]);

    const first = board.days[0];
    expect(first.date).toBe("2026-09-16");
    expect(first.isToday).toBe(true);
    expect(first.events).toHaveLength(1);
    expect(first.events[0].lead?.publicId).toBe("L-1048");
    expect(first.events[0].pill.label).toBe("DEPOSIT");
    expect(first.events[0].foodOut.time).toBe("4:45 PM");
    expect(first.persons).toBe(24);
    expect(first.collectedCents).toBe(100375);
    expect(board.days.slice(1).every((d) => d.events.length === 0)).toBe(true);
  });

  it("online reservations are dropped — this is the GROUP view of the same board", async () => {
    const calls = emptyCalls();
    const board = await eventsBoard(
      { centre: "HPFM", view: "day", date: "2026-09-16", includeCancelled: false },
      deps(
        { "2026-09-16": [res(), res({ id: "2", number: "H2", kind: "Online booking" })] },
        calls,
      ),
    );
    expect(board.days[0].events.map((e) => e.number)).toEqual(["H1"]);
  });

  it("one day's BMI failure keeps its own error and never empties the rest of the week", async () => {
    const calls = emptyCalls();
    const board = await eventsBoard(
      { centre: "HPFM", view: "week", date: "2026-09-16", includeCancelled: false },
      deps(
        { "2026-09-16": [res()], "2026-09-18": new Error("Office 503") },
        calls,
        [quote("1")],
        [],
      ),
    );
    const broken = board.days.find((d) => d.date === "2026-09-18")!;
    expect(broken.error).toContain("Office 503");
    expect(broken.events).toEqual([]);
    expect(board.days[0].events).toHaveLength(1);
    expect(board.days[0].error).toBeNull();
  });

  it("with nothing booked it does not ask Neon for quotes, leads or food out at all", async () => {
    const calls = emptyCalls();
    const board = await eventsBoard(
      { centre: "HPN", view: "day", date: "2026-09-16", includeCancelled: false },
      {
        ...deps({}, calls),
        listDailyEvents: async () => {
          calls.days.push("x");
          return { reservations: [] };
        },
      },
    );
    expect(board.days[0].events).toEqual([]);
    expect(calls.quoteCalls).toBe(0);
    expect(calls.leadCalls).toBe(0);
    expect(calls.foodOutCalls).toBe(0);
  });

  it("echoes the filters it was asked for, and reports ET today", async () => {
    const calls = emptyCalls();
    const board = await eventsBoard(
      { centre: "HPFM", view: "day", date: "2026-09-16", includeCancelled: true },
      deps({ "2026-09-16": [res({ state: "Cancellation" })] }, calls),
    );
    expect(board).toMatchObject({ centre: "HPFM", view: "day", includeCancelled: true });
    // 16:00Z on 2026-09-16 is 12:00 ET the SAME day — never the next one (R10).
    expect(board.today).toBe("2026-09-16");
    expect(board.days[0].events[0].cancelled).toBe(true);
  });
});

describe("leadLink / resolveBoardDate", () => {
  it("carries only what a row needs", () => {
    expect(leadLink(lead("1"))).toEqual({
      publicId: "L-1048",
      id: "1048",
      status: "contract",
      repName: "Kelsea Kosco",
      repSlug: "kelsea",
      guestPhone: "+12395551234",
    });
  });

  it("a missing or malformed date falls back to ET today, not to the UTC day", () => {
    // 01:30 UTC on the 17th is still the 16th in Fort Myers.
    const lateNight = new Date("2026-09-17T01:30:00.000Z");
    expect(resolveBoardDate(undefined, lateNight)).toBe("2026-09-16");
    expect(resolveBoardDate("nope", lateNight)).toBe("2026-09-16");
    expect(resolveBoardDate("2026-10-01", lateNight)).toBe("2026-10-01");
  });

  it("the production deps exist and are wired", () => {
    const d = defaultBoardDeps();
    expect(typeof d.listDailyEvents).toBe("function");
    expect(typeof d.listQuotes).toBe("function");
    expect(typeof d.listLeads).toBe("function");
    expect(typeof d.listFoodOut).toBe("function");
  });
});
