import { describe, expect, it } from "vitest";
import type { CentreSummary } from "~/features/crm/core/contracts";
import type { CrmStatus } from "~/features/crm/core/types";
import {
  activeStatuses,
  archivedCount,
  clientKeyColumns,
  initialCentre,
  mapRowFor,
  moveId,
  proposalFor,
  slugify,
} from "./model";

const CENTRES: CentreSummary[] = [
  {
    code: "HPFM",
    name: "HeadPinz Fort Myers",
    short: "HP Fort Myers",
    clientKey: "headpinzftmyers",
  },
  { code: "FT", name: "FastTrax Fort Myers", short: "FastTrax", clientKey: "headpinzftmyers" },
  { code: "HPN", name: "HeadPinz Naples", short: "HP Naples", clientKey: "headpinznaples" },
];

const status = (id: string, position: number, archivedAt: string | null = null): CrmStatus => ({
  id,
  label: id,
  kind: "open",
  position,
  slaLabel: null,
  slaHours: null,
  onBoard: true,
  archivedAt,
});

describe("statuses model", () => {
  it("activeStatuses drops archived rows and sorts by position", () => {
    const out = activeStatuses([
      status("b", 2),
      status("z", 9, "2026-09-01T00:00:00Z"),
      status("a", 1),
    ]);
    expect(out.map((s) => s.id)).toEqual(["a", "b"]);
    expect(archivedCount([status("b", 2), status("z", 9, "x")])).toBe(1);
  });

  it("clientKeyColumns folds FT into Fort Myers' Office tenant, Naples stays alone", () => {
    expect(clientKeyColumns(CENTRES)).toEqual([
      { clientKey: "headpinzftmyers", label: "HP Fort Myers · FastTrax", codes: ["HPFM", "FT"] },
      { clientKey: "headpinznaples", label: "HP Naples", codes: ["HPN"] },
    ]);
  });

  it("mapRowFor / proposalFor look up by status + tenant, ids stay strings", () => {
    const map = [
      {
        statusId: "quote",
        clientKey: "headpinzftmyers" as const,
        bmiStateId: "49130082",
        bmiStateName: "Quote",
      },
    ];
    expect(mapRowFor(map, "quote", "headpinzftmyers")?.bmiStateId).toBe("49130082");
    expect(mapRowFor(map, "quote", "headpinznaples")).toBeUndefined();
    const proposals = [
      { statusId: "contract", bmiStateId: "8020645", bmiStateName: "Send Contract" },
    ];
    expect(proposalFor(proposals, "contract")?.bmiStateName).toBe("Send Contract");
    expect(proposalFor(proposals, "quote")).toBeUndefined();
  });

  it("moveId swaps neighbours and refuses to fall off either end", () => {
    expect(moveId(["a", "b", "c"], "b", -1)).toEqual(["b", "a", "c"]);
    expect(moveId(["a", "b", "c"], "b", 1)).toEqual(["a", "c", "b"]);
    expect(moveId(["a", "b", "c"], "a", -1)).toEqual(["a", "b", "c"]);
    expect(moveId(["a", "b", "c"], "c", 1)).toEqual(["a", "b", "c"]);
    expect(moveId(["a", "b", "c"], "zz", 1)).toEqual(["a", "b", "c"]);
  });

  it("initialCentre honours a valid ?centre= and falls back to the first centre", () => {
    expect(initialCentre({ centre: "HPN" }, CENTRES)).toBe("HPN");
    expect(initialCentre({ centre: "NOPE" }, CENTRES)).toBe("HPFM");
    expect(initialCentre({}, CENTRES)).toBe("HPFM");
    expect(initialCentre({ centre: "HPN" }, [])).toBeNull();
  });

  it("slugify makes a status id from a label", () => {
    expect(slugify("Waiting on guest")).toBe("waiting-on-guest");
    expect(slugify("  Déposit  Paid! ")).toBe("d-posit-paid");
  });
});
