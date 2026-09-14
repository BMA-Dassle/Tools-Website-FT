import { describe, expect, it } from "vitest";
import type { StatusBmiMapRow } from "../../core/types";
import { bmiStateBranch, bmiSyncChipFor, isRailedStateId, transitionToastFor } from "./bmi-state";

const mapped = (bmiStateId: string): StatusBmiMapRow => ({
  statusId: "quote",
  clientKey: "headpinzftmyers",
  bmiStateId,
  bmiStateName: "Quote",
});

describe("bmiStateBranch", () => {
  it("no project beats everything — there is nothing in Office to move", () => {
    expect(
      bmiStateBranch({ projectId: null, mapping: mapped("49130082"), writesAllowed: true }),
    ).toBe("no_project");
  });

  it("an unmapped status moves Neon only — the DAY-ONE case, not an error", () => {
    // New Lead / Contacted / Quote ids are UNKNOWN per centre until a director
    // confirms them on Statuses & BMI (brief §1.8).
    expect(
      bmiStateBranch({ projectId: "63000000009561437", mapping: null, writesAllowed: true }),
    ).toBe("unmapped");
  });

  it("paused writes stop a MAPPED status from reaching Office", () => {
    expect(
      bmiStateBranch({
        projectId: "63000000009561437",
        mapping: mapped("49130082"),
        writesAllowed: false,
      }),
    ).toBe("paused");
  });

  it("a built-in (negative) state id is the Contract tab's job, never a board drag", () => {
    expect(
      bmiStateBranch({
        projectId: "63000000009561437",
        mapping: mapped("-4"),
        writesAllowed: true,
      }),
    ).toBe("builtin");
    expect(
      bmiStateBranch({
        projectId: "63000000009561437",
        mapping: mapped("-3"),
        writesAllowed: true,
      }),
    ).toBe("builtin");
  });

  it("a custom (positive) id is written", () => {
    expect(
      bmiStateBranch({
        projectId: "63000000009561437",
        mapping: mapped("49130082"),
        writesAllowed: true,
      }),
    ).toBe("write");
  });

  it("recognises a built-in id even with stray whitespace", () => {
    expect(isRailedStateId(" -4")).toBe(true);
    expect(isRailedStateId("49130082")).toBe(false);
  });
});

describe("bmiSyncChipFor / transitionToastFor", () => {
  it("names the written state on success and never claims one otherwise", () => {
    const ok = bmiSyncChipFor({
      status: "write",
      stateId: "49130082",
      stateName: "Send Contract",
    })!;
    expect(ok.label).toBe("BMI · Send Contract");
    expect(ok.kind).toBe("bmi");

    for (const status of ["unmapped", "paused", "no_project", "builtin", "pending"] as const) {
      const chip = bmiSyncChipFor({ status, stateId: null, stateName: null })!;
      expect(chip.label).not.toContain("Send Contract");
      expect(chip.title.length).toBeGreaterThan(20);
    }
  });

  it("a pending sync is the only CRITICAL toast — the rest are warnings or fine", () => {
    expect(
      transitionToastFor("Quote sent", { status: "pending", stateId: "1", stateName: "Quote" })
        .kind,
    ).toBe("crit");
    expect(
      transitionToastFor("Quote sent", { status: "write", stateId: "1", stateName: "Quote" }),
    ).toEqual({ text: "Status → Quote sent · BMI → Quote", kind: "ok" });
    expect(
      transitionToastFor("Quote sent", { status: "unmapped", stateId: null, stateName: null }).kind,
    ).toBe("warn");
    expect(
      transitionToastFor("Quote sent", { status: "no_project", stateId: null, stateName: null })
        .kind,
    ).toBe("ok");
  });
});
