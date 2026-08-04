/**
 * Express-lane state revert — the W54793 lesson (2026-07-28).
 *
 * The demotion cleared `fastLane` and wrote a "** NO VALID WAIVER **" memo but
 * left the reservation in "Confirmation - Kiosk", the state staff read as
 * "waivers signed, skip the desk". The revert must move it back to -3 — and must
 * NOT touch a row whose state now belongs to someone else (cancelled, arrived,
 * already plain Confirmation), where a blind -3 would revive a cancel or
 * un-check-in a guest at the counter.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { revertExpressKioskState } from "./express-revoke";
import { fetchProject, setProjectState } from "@/lib/bmi-office-actions";

vi.mock("@/lib/bmi-office-actions", () => ({
  fetchProject: vi.fn(),
  setProjectState: vi.fn(async () => undefined),
  officeProjectIdFromBillId: (billId: string) => {
    const tail = (Number(billId.slice(-10)) + 1).toString();
    return billId.slice(0, -tail.length) + tail;
  },
  KIOSK_CONFIRMATION_STATE_IDS: {
    "fort-myers": "55397028",
    fasttrax: "55397028",
    naples: "8489113",
  },
}));

const BILL = "63000000005919999";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("revertExpressKioskState", () => {
  it("moves a kiosk-state row back to Confirmation (-3)", async () => {
    vi.mocked(fetchProject).mockResolvedValue({ stateId: "55397028" });

    const res = await revertExpressKioskState({ billId: BILL });

    expect(res).toEqual({ outcome: "reverted", from: "55397028" });
    expect(vi.mocked(setProjectState)).toHaveBeenCalledWith(
      expect.objectContaining({
        centerCode: "fasttrax",
        // Office project id = bill id + 1, computed on the last 10 digits only.
        projectId: "63000000005920000",
        stateId: "-3",
      }),
    );
  });

  it("accepts a numeric stateId from the Office payload", async () => {
    vi.mocked(fetchProject).mockResolvedValue({ stateId: 55397028 });

    const res = await revertExpressKioskState({ billId: BILL });

    expect(res).toEqual({ outcome: "reverted", from: "55397028" });
  });

  it.each([
    ["cancelled", "-4"],
    ["arrived", "-5"],
    ["already plain Confirmation", "-3"],
    ["a waiver state", "3274635"],
  ])("leaves %s alone", async (_label, stateId) => {
    vi.mocked(fetchProject).mockResolvedValue({ stateId });

    const res = await revertExpressKioskState({ billId: BILL });

    expect(res).toEqual({ outcome: "left-alone", state: stateId });
    expect(vi.mocked(setProjectState)).not.toHaveBeenCalled();
  });

  it("uses the Naples kiosk state id for Naples rows", async () => {
    vi.mocked(fetchProject).mockResolvedValue({ stateId: "8489113" });

    const res = await revertExpressKioskState({ billId: BILL, centerCode: "naples" });

    expect(res).toEqual({ outcome: "reverted", from: "8489113" });
    expect(vi.mocked(setProjectState)).toHaveBeenCalledWith(
      expect.objectContaining({ centerCode: "naples", stateId: "-3" }),
    );
  });

  it("does not write when the project cannot be read", async () => {
    vi.mocked(fetchProject).mockResolvedValue(null);

    const res = await revertExpressKioskState({ billId: BILL });

    expect(res).toEqual({ outcome: "left-alone", state: null });
    expect(vi.mocked(setProjectState)).not.toHaveBeenCalled();
  });

  it("reports a failed write instead of throwing", async () => {
    vi.mocked(fetchProject).mockResolvedValue({ stateId: "55397028" });
    vi.mocked(setProjectState).mockRejectedValueOnce(new Error("Office auth failed: 401"));

    const res = await revertExpressKioskState({ billId: BILL });

    expect(res).toEqual({ outcome: "failed", error: "Office auth failed: 401" });
  });
});
