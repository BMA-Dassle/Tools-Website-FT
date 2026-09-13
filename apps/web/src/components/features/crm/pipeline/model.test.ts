import { describe, expect, it } from "vitest";
import type { StatusBmiMapRow } from "~/features/crm/core/types";
import { makeLead } from "~/features/crm/leads/test-support";
import { STATUSES } from "~/features/crm/statuses/test-support";
import { boardSubtitle, columnIdAtPoint, columnSum, leadIndex, statusOptions } from "./model";

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

describe("columnIdAtPoint", () => {
  it("reads the column id off the nearest [data-col] ancestor", () => {
    const card = { closest: (sel: string) => (sel === "[data-col]" ? col : null) };
    const col = { dataset: { col: "quote" } } as unknown as HTMLElement;
    const doc = { elementFromPoint: () => card } as unknown as Document;
    expect(columnIdAtPoint(10, 10, doc)).toBe("quote");
  });

  it("is null outside any column, and null when there is no document at all", () => {
    const doc = {
      elementFromPoint: () => ({ closest: () => null }),
    } as unknown as Document;
    expect(columnIdAtPoint(10, 10, doc)).toBeNull();
    expect(
      columnIdAtPoint(10, 10, { elementFromPoint: () => null } as unknown as Document),
    ).toBeNull();
  });
});
