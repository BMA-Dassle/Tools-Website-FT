/**
 * Race Sims pricing rail: the builder must PRICE a sim cart for the
 * quote/review screens — ONE line per picked session (racing's heats[]),
 * flat $14.95 × racers (owner 2026-09-15 — no day-split), the shared Square
 * catalog id on every line, track + time riding the name — while reserve
 * guard 2e keeps any charge fail-closed until the BMI track keys are armed
 * (that seam is pinned in race-sims/products.test.ts).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/redis", () => ({ default: {} }));

import { buildCombinedLineItems, quoteUnifiedSession } from "./unified-reserve";
import {
  emptySession,
  newItem,
  type BookingSession,
  type RaceSimItem,
  type RaceSimSession,
} from "../state/types";
import type { BmiProposal } from "../data/bmi";
import { RACE_SIM_SQUARE_CATALOG_ID } from "~/features/race-sims/products";

const proposal = { blocks: [], productLineId: null } as unknown as BmiProposal;
const sess = (slot: string, trackKey: "a" | "b" | "c" = "a"): RaceSimSession => ({
  trackKey,
  slot,
  slotProposal: proposal,
  bmiLineId: null,
  heldQty: null,
});

function simItem(patch: Partial<RaceSimItem> = {}): RaceSimItem {
  return {
    ...(newItem("racesim") as RaceSimItem),
    id: "rs1",
    date: "2026-08-24", // Monday → weekday rate
    productKind: "single",
    productSlug: "sim-single",
    trackKey: "a",
    racerCount: 2,
    sessions: [sess("2026-08-24T15:00:00", "a")],
    assignedTo: ["m1", "m2"],
    ...patch,
  };
}

function simSession(items: BookingSession["items"]): BookingSession {
  return {
    ...emptySession({ entryBrand: "fasttrax" }),
    center: "fort-myers",
    context: { kiosk: true },
    items,
  } as BookingSession;
}

describe("unified pricing — racesim cart", () => {
  it("prices a session at $14.95/racer on the shared Square catalog id", () => {
    const { sqLineItems, pricedLines, totalPriceCents } = buildCombinedLineItems(
      simSession([simItem()]),
    );
    expect(sqLineItems).toHaveLength(1);
    expect(sqLineItems[0].catalogObjectId).toBe(RACE_SIM_SQUARE_CATALOG_ID);
    expect(sqLineItems[0].quantity).toBe("2");
    expect(sqLineItems[0].basePriceMoney?.amount).toBe(1495);
    // 2026-08-24 predates the first circuit lineup, so the line falls back to
    // the key's stable label — what these bookings were actually sold as.
    expect(sqLineItems[0].name).toContain("Track A");
    expect(sqLineItems[0].name).toContain("3:00 PM");
    expect(pricedLines).toHaveLength(1);
    expect(totalPriceCents).toBe(2990);
  });

  it("one line PER SESSION across tracks — 2 sessions × 2 racers × $14.95", () => {
    const { sqLineItems, totalPriceCents } = buildCombinedLineItems(
      simSession([
        simItem({ sessions: [sess("2026-08-24T15:00:00", "a"), sess("2026-08-24T15:15:00", "b")] }),
      ]),
    );
    expect(sqLineItems).toHaveLength(2);
    expect(sqLineItems.map((l) => l.name)).toEqual([
      expect.stringContaining("Track A"),
      expect.stringContaining("Track B"),
    ]);
    expect(sqLineItems.every((l) => l.catalogObjectId === RACE_SIM_SQUARE_CATALOG_ID)).toBe(true);
    expect(totalPriceCents).toBe(5980);
  });

  it("charges the SAME $14.95 on a weekend — the day-split is gone", () => {
    // 2026-08-29 is a Saturday, which used to bill $16. The pack prices are all
    // struck off a flat $14.95 single, so a day-split here would make every
    // published "% off" wrong on one half of the week.
    const { sqLineItems } = buildCombinedLineItems(
      simSession([simItem({ date: "2026-08-29", sessions: [sess("2026-08-29T15:00:00")] })]),
    );
    expect(sqLineItems[0].basePriceMoney?.amount).toBe(1495);
  });

  it("names the CIRCUIT on the receipt once a lineup is programmed", () => {
    // The guest picked "Bristol Motor Speedway", so that is what the receipt
    // must say — not the internal key label. Resolved from the session's OWN
    // date, so a reprint after the lineup rotates still names what was raced.
    const { sqLineItems } = buildCombinedLineItems(
      simSession([
        simItem({
          date: "2026-09-16",
          sessions: [sess("2026-09-16T15:00:00", "b"), sess("2026-09-16T15:15:00", "c")],
        }),
      ]),
    );
    expect(sqLineItems[0].name).toContain("Bristol Motor Speedway");
    expect(sqLineItems[1].name).toContain("Indianapolis Motor Speedway");
    expect(sqLineItems[0].name).not.toContain("Track B");
  });

  it("skips an unready draft (no product picked) and an item with no sessions", () => {
    expect(
      buildCombinedLineItems(simSession([simItem({ productSlug: null })])).sqLineItems,
    ).toHaveLength(0);
    const { sqLineItems, totalPriceCents } = buildCombinedLineItems(
      simSession([simItem({ sessions: [] })]),
    );
    expect(sqLineItems).toHaveLength(0);
    expect(totalPriceCents).toBe(0);
  });

  it("quote mirror carries the same money (single, 1 racer)", () => {
    const q = quoteUnifiedSession(simSession([simItem({ racerCount: 1 })]));
    expect(q.subtotalCents).toBe(1495);
    expect(q.totalCents).toBe(q.subtotalCents + q.taxCents);
    expect(q.lines[0]?.name).toContain("1 Race");
  });
});
