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

  // B5 (contract, payments, history) and B6 (notes, event) have both landed,
  // so every one of the six now points at its real component and nothing is
  // left on TabComingLater. Each half asserted the OTHER half was still a stub,
  // which was true per-branch and false the moment they were merged.
  it("all six tabs are built — nothing is left pointing at TabComingLater", () => {
    expect(String(DEAL_TABS.overview)).toContain("OverviewTab");
    expect(String(DEAL_TABS.contract)).toContain("ContractTab");
    expect(String(DEAL_TABS.notes)).toContain("NotesTab");
    expect(String(DEAL_TABS.event)).toContain("EventTab");
    expect(String(DEAL_TABS.payments)).toContain("PaymentsTab");
    expect(String(DEAL_TABS.history)).toContain("HistoryTab");
    for (const id of DEAL_TAB_IDS) {
      expect(String(DEAL_TABS[id]), id).not.toContain("TabComingLater");
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
