import { describe, expect, it } from "vitest";
import { publicRep } from "../../core/projections";
import type { PublicRep } from "../../core/contracts";
import { ALL_REPS, PROTO_NOW, makeLead, minsAgo } from "../../leads/test-support";
import { STATUSES } from "../test-support";
import {
  BOOKED_COLUMN_ID,
  CLOSED_COLUMN_ID,
  REP_ORDER,
  boardColumns,
  buildBoard,
  columnDropTarget,
  leadInColumn,
} from "./board";

/**
 * The board is the prototype's, line for line (direction-b.html:67-69): the
 * on-board statuses as columns, then the two SYNTHETIC buckets, cards matched
 * by status id (real) or status KIND (synthetic), and `?by=rep` swimlanes in
 * REP_ORDER.
 */

const REPS: PublicRep[] = ALL_REPS.map((r) => publicRep(r)!);
const kindOf = (id: string) => STATUSES.find((s) => s.id === id)?.kind;

describe("boardColumns", () => {
  it("drops the five off-board statuses and appends Booked and Closed", () => {
    const cols = boardColumns(STATUSES);
    expect(cols.map((c) => c.id)).toEqual([
      "assigned",
      "contacted",
      "waiting",
      "quote",
      "contract",
      BOOKED_COLUMN_ID,
      CLOSED_COLUMN_ID,
    ]);
    // `new`, `deposit`, `confirmed`, `lost` and `noresp` are never columns —
    // they are reached through Booked / Closed or through the queue.
    expect(cols.map((c) => c.id)).not.toContain("new");
    expect(cols.map((c) => c.id)).not.toContain("deposit");
  });

  it("labels the synthetic columns Booked and Closed and refuses drops on them", () => {
    const cols = boardColumns(STATUSES);
    const booked = cols.find((c) => c.id === BOOKED_COLUMN_ID)!;
    const closed = cols.find((c) => c.id === CLOSED_COLUMN_ID)!;
    expect([booked.label, closed.label]).toEqual(["Booked", "Closed"]);
    expect(booked.droppable).toBe(false);
    expect(closed.droppable).toBe(false);
    expect(columnDropTarget(cols, BOOKED_COLUMN_ID)).toBeNull();
    expect(columnDropTarget(cols, CLOSED_COLUMN_ID)).toBeNull();
    expect(columnDropTarget(cols, "quote")).toBe("quote");
    expect(columnDropTarget(cols, "nope")).toBeNull();
  });

  it("orders real columns by position, not by insertion", () => {
    const shuffled = [...STATUSES].reverse();
    expect(
      boardColumns(shuffled)
        .map((c) => c.id)
        .slice(0, 5),
    ).toEqual(["assigned", "contacted", "waiting", "quote", "contract"]);
  });

  it("hides an archived status even when it is still marked on-board", () => {
    const withArchived = STATUSES.map((s) =>
      s.id === "waiting" ? { ...s, archivedAt: "2026-09-01T00:00:00.000Z" } : s,
    );
    expect(boardColumns(withArchived).map((c) => c.id)).not.toContain("waiting");
  });
});

describe("leadInColumn", () => {
  it("matches a real column by status id and a synthetic one by status KIND", () => {
    const deposit = makeLead({ id: "1", status: "deposit" });
    const confirmed = makeLead({ id: "2", status: "confirmed" });
    const noresp = makeLead({ id: "3", status: "noresp" });
    const quote = makeLead({ id: "4", status: "quote" });

    // Two DIFFERENT won statuses both land in Booked — the point of the bucket.
    expect(leadInColumn(deposit, { id: BOOKED_COLUMN_ID }, kindOf)).toBe(true);
    expect(leadInColumn(confirmed, { id: BOOKED_COLUMN_ID }, kindOf)).toBe(true);
    expect(leadInColumn(noresp, { id: CLOSED_COLUMN_ID }, kindOf)).toBe(true);
    expect(leadInColumn(noresp, { id: BOOKED_COLUMN_ID }, kindOf)).toBe(false);
    expect(leadInColumn(quote, { id: "quote" }, kindOf)).toBe(true);
    expect(leadInColumn(quote, { id: "contacted" }, kindOf)).toBe(false);
  });
});

describe("buildBoard", () => {
  const leads = [
    makeLead({ id: "1", status: "quote", valueCents: 120_000, rep: "1", repSlug: "kelsea" }),
    makeLead({ id: "2", status: "quote", valueCents: 80_000, rep: "2", repSlug: "lori" }),
    makeLead({ id: "3", status: "contacted", valueCents: 0, rep: "1", repSlug: "kelsea" }),
    makeLead({ id: "4", status: "deposit", valueCents: 300_000, rep: "3", repSlug: "stephanie" }),
    makeLead({ id: "5", status: "lost", valueCents: 50_000, rep: "2", repSlug: "lori" }),
    // A `new` lead belongs to the QUEUE, not the board.
    makeLead({ id: "6", status: "new", valueCents: 10_000 }),
  ];

  it("counts and sums each column, and leaves queue-only leads off the board", () => {
    const board = buildBoard({
      leads,
      statuses: STATUSES,
      reps: REPS,
      byRep: false,
      now: PROTO_NOW,
    });
    const quote = board.columns.find((c) => c.id === "quote")!;
    expect(quote.count).toBe(2);
    expect(quote.sumCents).toBe(200_000);
    expect(board.columns.find((c) => c.id === BOOKED_COLUMN_ID)!.count).toBe(1);
    expect(board.columns.find((c) => c.id === CLOSED_COLUMN_ID)!.count).toBe(1);
    expect(board.leads.map((l) => l.id)).not.toContain("6");
    // Open = the three open-kind leads; Booked and Closed do not count as open.
    expect(board.openCount).toBe(3);
    expect(board.openValueCents).toBe(200_000);
    expect(board.columns.every((c) => c.lanes === null)).toBe(true);
  });

  it("?by=rep groups a column's cards into lanes in REP_ORDER", () => {
    const board = buildBoard({
      leads,
      statuses: STATUSES,
      reps: REPS,
      byRep: true,
      now: PROTO_NOW,
    });
    const quote = board.columns.find((c) => c.id === "quote")!;
    expect(quote.lanes!.map((l) => l.repSlug)).toEqual(["kelsea", "lori"]);
    expect(REP_ORDER.indexOf("kelsea")).toBeLessThan(REP_ORDER.indexOf("lori"));
    // Only reps WITH cards get a lane (the prototype's `ls.some(l => l.rep === id)`).
    expect(quote.lanes!.length).toBe(2);
    expect(quote.lanes![0]!.leadIds).toEqual(["1"]);
  });

  it("marks a lane late when one of its OPEN leads is past due, and not otherwise", () => {
    const overdue = makeLead({
      id: "7",
      status: "contacted",
      rep: "1",
      repSlug: "kelsea",
      nextAction: { kind: "call", due: minsAgo(90), label: "Follow up" },
    });
    const lostAndOverdue = makeLead({
      id: "8",
      status: "lost",
      rep: "2",
      repSlug: "lori",
      nextAction: { kind: "call", due: minsAgo(90), label: "Follow up" },
    });
    const board = buildBoard({
      leads: [overdue, lostAndOverdue],
      statuses: STATUSES,
      reps: REPS,
      byRep: true,
      now: PROTO_NOW,
    });
    expect(board.columns.find((c) => c.id === "contacted")!.lanes![0]!.hasOverdue).toBe(true);
    // A closed lead is not chased, so its stale due time is not a red dot.
    expect(board.columns.find((c) => c.id === CLOSED_COLUMN_ID)!.lanes![0]!.hasOverdue).toBe(false);
  });

  it("keeps unassigned board cards in a lane of their own, after every named rep", () => {
    const orphan = makeLead({ id: "9", status: "quote", rep: null, repSlug: null });
    const mine = makeLead({ id: "10", status: "quote", rep: "1", repSlug: "kelsea" });
    const board = buildBoard({
      leads: [orphan, mine],
      statuses: STATUSES,
      reps: REPS,
      byRep: true,
      now: PROTO_NOW,
    });
    const lanes = board.columns.find((c) => c.id === "quote")!.lanes!;
    expect(lanes.map((l) => l.repSlug)).toEqual(["kelsea", null]);
  });
});
