import { describe, expect, it } from "vitest";
import type { StatusBmiMapRow } from "~/features/crm/core/types";
import { makeLead } from "~/features/crm/leads/test-support";
import { STATUSES } from "~/features/crm/statuses/test-support";
import {
  boardSubtitle,
  boardTracks,
  columnSum,
  leadIndex,
  railColumnIds,
  statusOptions,
} from "./model";

/**
 * The board's pure client helpers. The one worth reading twice is
 * `statusOptions`: the prototype's sheet promised "Writes BMI state X" for
 * every row, which is only true where a `crm_status_bmi_map` row exists for
 * THAT tenant — and on day one most statuses have none. A sheet that promises
 * an Office write it will not make is how a rep ends up telling a guest the
 * booking moved when it did not.
 */

const map: StatusBmiMapRow[] = [
  {
    statusId: "contract",
    clientKey: "headpinzftmyers",
    bmiStateId: "49130082",
    bmiStateName: "Send Contract",
  },
  {
    statusId: "contract",
    clientKey: "headpinznaples",
    bmiStateId: "8020645",
    bmiStateName: "Send Contract",
  },
  {
    statusId: "confirmed",
    clientKey: "headpinzftmyers",
    bmiStateId: "-3",
    bmiStateName: "Confirmation",
  },
];

describe("railColumnIds / boardTracks", () => {
  // A board mid-week: two stages busy, three empty.
  const COLUMNS = [
    { id: "assigned", count: 3 },
    { id: "contacted", count: 0 },
    { id: "waiting", count: 0 },
    { id: "quote", count: 5 },
    { id: "won", count: 0 },
  ];

  it("collapses exactly the empty columns", () => {
    const rails = railColumnIds(COLUMNS, { showAll: false, overColumnId: null });
    expect([...rails].sort()).toEqual(["contacted", "waiting", "won"]);
  });

  it("never collapses the column a card is being dragged over", () => {
    const rails = railColumnIds(COLUMNS, { showAll: false, overColumnId: "waiting" });
    expect(rails.has("waiting")).toBe(false);
    // An empty stage must stay reachable BY DRAG — that is the whole reason
    // this collapses rather than hides.
    expect([...rails].sort()).toEqual(["contacted", "won"]);
  });

  it("collapses nothing when the planner asked for every column", () => {
    expect(railColumnIds(COLUMNS, { showAll: true, overColumnId: null }).size).toBe(0);
  });

  it("writes one track per column, in board order", () => {
    const rails = railColumnIds(COLUMNS, { showAll: false, overColumnId: null });
    expect(boardTracks(COLUMNS, rails)).toBe(
      "var(--col-w) var(--col-rail-w) var(--col-rail-w) var(--col-w) var(--col-rail-w)",
    );
  });

  it("writes NO template when nothing is collapsed — grid-auto-columns keeps its job", () => {
    // This null is what leaves the phone's 86% swipe columns and the queue's
    // 300px alone: a template would override both.
    expect(boardTracks(COLUMNS, new Set())).toBeNull();
    expect(boardTracks(COLUMNS, railColumnIds(COLUMNS, { showAll: true, overColumnId: null })))
      .toBeNull();
  });

  it("handles a board where every column is empty", () => {
    const bare = COLUMNS.map((c) => ({ ...c, count: 0 }));
    expect(railColumnIds(bare, { showAll: false, overColumnId: null }).size).toBe(5);
    expect(boardTracks(bare, railColumnIds(bare, { showAll: false, overColumnId: null }))).toBe(
      "var(--col-rail-w) var(--col-rail-w) var(--col-rail-w) var(--col-rail-w) var(--col-rail-w)",
    );
  });
});

describe("boardSubtitle / columnSum", () => {
  it("reads like the prototype's header", () => {
    expect(boardSubtitle(12, 8_430_000)).toBe("12 open · $84,300 quoted");
    expect(boardSubtitle(0, 0)).toBe("0 open · $0 quoted");
  });

  it("omits a zero sum rather than printing $0 in every column", () => {
    expect(columnSum({ sumCents: 0 })).toBeNull();
    expect(columnSum({ sumCents: 120_000 })).toBe("$1.2k");
  });
});

describe("leadIndex", () => {
  it("keys by the numeric id the columns carry, not the public one", () => {
    const index = leadIndex([makeLead({ id: "1042" })]);
    expect(index.get("1042")?.publicId).toBe("L-1042");
    expect(index.get("L-1042")).toBeUndefined();
  });
});

describe("statusOptions", () => {
  const lead = makeLead({ id: "1", status: "quote", centre: "HPFM" });

  it("marks the lead's current status and orders by position", () => {
    const options = statusOptions(STATUSES, lead, map, "headpinzftmyers");
    expect(options.map((o) => o.status.id)).toEqual(STATUSES.map((s) => s.id));
    expect(options.filter((o) => o.current).map((o) => o.status.id)).toEqual(["quote"]);
  });

  it("names the Office state ONLY where this tenant has one mapped", () => {
    const options = statusOptions(STATUSES, lead, map, "headpinzftmyers");
    const contract = options.find((o) => o.status.id === "contract")!;
    expect(contract.bmiStateName).toBe("Send Contract");
    expect(contract.why).toContain("Writes BMI state Send Contract");

    const contacted = options.find((o) => o.status.id === "contacted")!;
    expect(contacted.bmiStateName).toBeNull();
    expect(contacted.why).toContain("No BMI state mapped for this centre");
    expect(contacted.why).not.toContain("Writes BMI state");
  });

  it("uses the tenant's OWN state id — a Naples lead never sees the Fort Myers one", () => {
    const naples = makeLead({ id: "2", status: "quote", centre: "HPN" });
    const options = statusOptions(STATUSES, naples, map, "headpinznaples");
    const contract = options.find((o) => o.status.id === "contract")!;
    expect(contract.why).toContain("Send Contract");
    // And the Fort Myers row is not what answered: the sheet is per tenant.
    expect(map.find((m) => m.clientKey === "headpinznaples")!.bmiStateId).toBe("8020645");
  });

  it("says a built-in state is the Contract tab's job rather than promising a write", () => {
    const options = statusOptions(STATUSES, lead, map, "headpinzftmyers");
    const confirmed = options.find((o) => o.status.id === "confirmed")!;
    expect(confirmed.builtIn).toBe(true);
    expect(confirmed.why).toContain("Contract tab");
    expect(confirmed.why).not.toContain("Writes BMI state");
  });

  it("carries the SLA into the line, where a status has one", () => {
    const withSla = STATUSES.map((s) =>
      s.id === "contacted" ? { ...s, slaLabel: "48 h to next touch" } : s,
    );
    const options = statusOptions(withSla, lead, map, "headpinzftmyers");
    expect(options.find((o) => o.status.id === "contacted")!.why).toContain("48 h to next touch");
  });

  it("hides an archived status — it is not somewhere a lead can be sent", () => {
    const archived = STATUSES.map((s) =>
      s.id === "waiting" ? { ...s, archivedAt: "2026-09-01T00:00:00Z" } : s,
    );
    expect(
      statusOptions(archived, lead, map, "headpinzftmyers").map((o) => o.status.id),
    ).not.toContain("waiting");
  });
});
