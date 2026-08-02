import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/bmi-office-actions", () => ({
  KIOSK_CONFIRMATION_STATE_IDS: { "fort-myers": "55397028", fasttrax: "55397028", naples: "8489113" },
  VIP_CONFIRMATION_STATE_IDS: { "fort-myers": "55466363", fasttrax: "55466363" },
  fetchProject: vi.fn(),
  officeProjectIdFromBillId: (billId: string) => {
    const tail = (Number(billId.slice(-10)) + 1).toString();
    return billId.slice(0, -tail.length) + tail;
  },
  setProjectState: vi.fn(async () => undefined),
}));

import { fetchProject, setProjectState } from "@/lib/bmi-office-actions";
import {
  isVipComboBooking,
  stampVipState,
  stampVipStateIfCombo,
  vipConfirmationStateId,
} from "./vip-state.server";

const VIP = "55466363";
const KIOSK = "55397028";
const PROJECT = "43310000000000123";

const inState = (stateId: unknown) => vi.mocked(fetchProject).mockResolvedValue({ stateId });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(setProjectState).mockResolvedValue(undefined);
});

describe("isVipComboBooking", () => {
  it("is true for every combo id — v1, v2, and legacy ids off the registry", () => {
    expect(isVipComboBooking("race-bowl")).toBe(true);
    expect(isVipComboBooking("race-bowl-v2")).toBe(true);
    expect(isVipComboBooking("some-retired-pack")).toBe(true);
  });

  it("is false for a non-combo booking", () => {
    expect(isVipComboBooking(null)).toBe(false);
    expect(isVipComboBooking(undefined)).toBe(false);
    expect(isVipComboBooking("")).toBe(false);
  });
});

describe("vipConfirmationStateId", () => {
  it("resolves the FastTrax / HP-FM id (shared BMI client key)", () => {
    expect(vipConfirmationStateId("fasttrax")).toBe(VIP);
    expect(vipConfirmationStateId("fort-myers")).toBe(VIP);
  });

  it("is null at Naples — BMI has no VIP state there, so callers stay on -3", () => {
    expect(vipConfirmationStateId("naples")).toBeNull();
    expect(vipConfirmationStateId(null)).toBeNull();
  });
});

describe("stampVipState", () => {
  it("claims plain Confirmation (-3)", async () => {
    inState("-3");
    const r = await stampVipState({ centerCode: "fasttrax", officeProjectId: PROJECT });
    expect(r).toEqual({ outcome: "stamped", from: "-3" });
    expect(vi.mocked(setProjectState)).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: PROJECT, stateId: VIP, centerCode: "fasttrax" }),
    );
  });

  it("claims the kiosk confirmation state — owner: VIP wins over kiosk", async () => {
    inState(KIOSK);
    const r = await stampVipState({ centerCode: "fasttrax", officeProjectId: PROJECT });
    expect(r).toEqual({ outcome: "stamped", from: KIOSK });
  });

  it("claims the pending-online ladder the crons recover through", async () => {
    for (const s of ["-100", "-101", "-102"]) {
      inState(s);
      const r = await stampVipState({ centerCode: "fasttrax", officeProjectId: PROJECT });
      expect(r).toEqual({ outcome: "stamped", from: s });
    }
  });

  it("NEVER overwrites a cancelled project — a blind write would revive it", async () => {
    inState("-4");
    const r = await stampVipState({ centerCode: "fasttrax", officeProjectId: PROJECT });
    expect(r).toEqual({ outcome: "left-alone", state: "-4" });
    expect(vi.mocked(setProjectState)).not.toHaveBeenCalled();
  });

  it("NEVER overwrites an arrived project — that would un-check-in a guest", async () => {
    inState("-5");
    const r = await stampVipState({ centerCode: "fasttrax", officeProjectId: PROJECT });
    expect(r).toEqual({ outcome: "left-alone", state: "-5" });
    expect(vi.mocked(setProjectState)).not.toHaveBeenCalled();
  });

  it("leaves an unrecognised custom state (e.g. Confirmation + Waiver) alone", async () => {
    inState("3274635");
    const r = await stampVipState({ centerCode: "fasttrax", officeProjectId: PROJECT });
    expect(r).toEqual({ outcome: "left-alone", state: "3274635" });
  });

  it("is idempotent — a second run reports 'already' and writes nothing", async () => {
    inState(VIP);
    const r = await stampVipState({ centerCode: "fasttrax", officeProjectId: PROJECT });
    expect(r).toEqual({ outcome: "already" });
    expect(vi.mocked(setProjectState)).not.toHaveBeenCalled();
  });

  it("compares a NUMERIC stateId as a string (the Office API returns both)", async () => {
    inState(55466363);
    const r = await stampVipState({ centerCode: "fasttrax", officeProjectId: PROJECT });
    expect(r).toEqual({ outcome: "already" });
  });

  it("derives the project id from a billId (bill + 1, 17-digit safe)", async () => {
    inState("-3");
    await stampVipState({ centerCode: "fasttrax", billId: "43310000000000122" });
    expect(vi.mocked(setProjectState)).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: PROJECT }),
    );
  });

  it("carries the propagation self-heal by default (the late Pandora -3 race)", async () => {
    inState("-3");
    await stampVipState({ centerCode: "fasttrax", officeProjectId: PROJECT });
    expect(vi.mocked(setProjectState)).toHaveBeenCalledWith(
      expect.objectContaining({ ensureAttempts: 3, ensureGapMs: 4000 }),
    );
  });

  it("honours ensureAttempts: 0 for backfills, where no -3 is in flight", async () => {
    inState("-3");
    await stampVipState({ centerCode: "fasttrax", officeProjectId: PROJECT, ensureAttempts: 0 });
    expect(vi.mocked(setProjectState)).toHaveBeenCalledWith(
      expect.objectContaining({ ensureAttempts: 0 }),
    );
  });

  it("skips at Naples instead of writing the FM id into the wrong tenant", async () => {
    const r = await stampVipState({ centerCode: "naples", officeProjectId: PROJECT });
    expect(r.outcome).toBe("skipped");
    expect(vi.mocked(setProjectState)).not.toHaveBeenCalled();
    expect(vi.mocked(fetchProject)).not.toHaveBeenCalled();
  });

  it("skips when given neither a projectId nor a billId", async () => {
    const r = await stampVipState({ centerCode: "fasttrax" });
    expect(r.outcome).toBe("skipped");
  });

  it("leaves the project alone when the read comes back empty", async () => {
    vi.mocked(fetchProject).mockResolvedValue(null);
    const r = await stampVipState({ centerCode: "fasttrax", officeProjectId: PROJECT });
    expect(r).toEqual({ outcome: "left-alone", state: null });
    expect(vi.mocked(setProjectState)).not.toHaveBeenCalled();
  });

  it("never throws — a vendor failure comes back as { failed }", async () => {
    inState("-3");
    vi.mocked(setProjectState).mockRejectedValueOnce(new Error("Office auth failed: 401"));
    const r = await stampVipState({ centerCode: "fasttrax", officeProjectId: PROJECT });
    expect(r).toEqual({ outcome: "failed", error: "Office auth failed: 401" });
  });

  it("never throws when the READ fails either", async () => {
    vi.mocked(fetchProject).mockRejectedValueOnce(new Error("boom"));
    const r = await stampVipState({ centerCode: "fasttrax", officeProjectId: PROJECT });
    expect(r).toEqual({ outcome: "failed", error: "boom" });
  });
});

describe("stampVipStateIfCombo", () => {
  it("does nothing at all for a non-combo booking", async () => {
    const r = await stampVipStateIfCombo({
      comboSpecialId: null,
      centerCode: "fasttrax",
      officeProjectId: PROJECT,
      tag: "test",
    });
    expect(r.outcome).toBe("skipped");
    expect(vi.mocked(fetchProject)).not.toHaveBeenCalled();
    expect(vi.mocked(setProjectState)).not.toHaveBeenCalled();
  });

  it("stamps a combo booking", async () => {
    inState("-3");
    const r = await stampVipStateIfCombo({
      comboSpecialId: "race-bowl-v2",
      centerCode: "fasttrax",
      officeProjectId: PROJECT,
      tag: "test",
    });
    expect(r).toEqual({ outcome: "stamped", from: "-3" });
  });
});
