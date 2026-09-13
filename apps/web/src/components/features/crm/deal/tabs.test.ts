import { describe, expect, it } from "vitest";
import {
  DEAL_TABS,
  DEAL_TAB_DESCRIPTION,
  DEAL_TAB_IDS,
  DEAL_TAB_LABEL,
  activeTab,
  isDealTabId,
} from "./tabs";

/**
 * The registry B4/B5/B6 flip one line of: the prototype's six tabs in order,
 * overview → OverviewTab, everything else → TabComingLater until its PR lands.
 */
describe("deal tab registry", () => {
  it("the prototype's six tabs, in order, each labelled and described", () => {
    expect(DEAL_TAB_IDS).toEqual(["overview", "contract", "notes", "event", "payments", "history"]);
    for (const id of DEAL_TAB_IDS) {
      expect(DEAL_TAB_LABEL[id]).toBeTruthy();
      expect(DEAL_TAB_DESCRIPTION[id].length).toBeGreaterThan(10);
    }
    expect(DEAL_TAB_DESCRIPTION.history).toBe(
      "contract audit log · versions · status changes · BMI syncs",
    );
  });

  it("overview is built; every other id points at TabComingLater", () => {
    expect(String(DEAL_TABS.overview)).toContain("OverviewTab");
    for (const id of DEAL_TAB_IDS.filter((t) => t !== "overview")) {
      expect(String(DEAL_TABS[id]), id).toContain("TabComingLater");
    }
  });

  it("activeTab reads ?tab= and falls back to overview", () => {
    expect(activeTab({})).toBe("overview");
    expect(activeTab({ tab: "payments" })).toBe("payments");
    expect(activeTab({ tab: "nope" })).toBe("overview");
    expect(isDealTabId("event")).toBe(true);
    expect(isDealTabId("events")).toBe(false);
  });
});
