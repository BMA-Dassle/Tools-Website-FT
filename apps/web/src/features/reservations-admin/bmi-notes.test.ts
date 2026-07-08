import { beforeEach, describe, expect, it, vi } from "vitest";

const office = vi.hoisted(() => ({
  appendProjectPrivateNote: vi.fn(),
  noteTimestamp: vi.fn(() => "2026-07-06 8:00 PM"),
}));
const cancel = vi.hoisted(() => ({ resolveBmiProject: vi.fn() }));

vi.mock("@/lib/bmi-office-actions", () => office);
vi.mock("~/features/cancellation/bmi-cancel", () => cancel);

import { syncNoteToBmi } from "./bmi-notes";

const BILL_ID = "18014567890123456789"; // > MAX_SAFE_INTEGER — string end to end

function raceLeg() {
  return {
    id: 4212,
    bmiBillId: BILL_ID,
    bmiReservationNumber: "W47881",
    centerCode: "fort-myers",
    productKind: "race" as const,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("syncNoteToBmi", () => {
  it("appends via the merge path under the project's REAL location (race → fasttrax)", async () => {
    cancel.resolveBmiProject.mockResolvedValue({ projectId: "555001", project: {}, headers: {} });
    office.appendProjectPrivateNote.mockResolvedValue(true);

    const ok = await syncNoteToBmi(raceLeg(), "headsock size XL");
    expect(ok).toBe(true);
    // Resolver gets the RAW string bill id + W-number.
    expect(cancel.resolveBmiProject).toHaveBeenCalledWith({
      bmiClientKey: "headpinzftmyers",
      bmiBillId: BILL_ID,
      bmiReservationNumber: "W47881",
    });
    // Race projects live under the FastTrax Pandora location; the note is a
    // timestamped APPEND (merge-write preserves existing combo/VIP memos).
    expect(office.appendProjectPrivateNote).toHaveBeenCalledWith({
      centerCode: "fasttrax",
      projectId: "555001",
      note: "[2026-07-06 8:00 PM] Portal note: headsock size XL",
    });
  });

  it("returns false without writing when the row has no BMI bill", async () => {
    const ok = await syncNoteToBmi({ ...raceLeg(), bmiBillId: undefined }, "note");
    expect(ok).toBe(false);
    expect(cancel.resolveBmiProject).not.toHaveBeenCalled();
    expect(office.appendProjectPrivateNote).not.toHaveBeenCalled();
  });

  it("returns false when no project resolves (never falls back to the overwriting booking/memo)", async () => {
    cancel.resolveBmiProject.mockResolvedValue({
      projectId: undefined,
      project: null,
      headers: null,
    });
    const ok = await syncNoteToBmi(raceLeg(), "note");
    expect(ok).toBe(false);
    expect(office.appendProjectPrivateNote).not.toHaveBeenCalled();
  });

  it("surfaces a skipped merge (read-failed) as false and swallows append errors", async () => {
    cancel.resolveBmiProject.mockResolvedValue({ projectId: "555001", project: {}, headers: {} });
    office.appendProjectPrivateNote.mockResolvedValue(false); // safety read failed → no write
    expect(await syncNoteToBmi(raceLeg(), "note")).toBe(false);

    office.appendProjectPrivateNote.mockRejectedValue(new Error("Office down"));
    expect(await syncNoteToBmi(raceLeg(), "note")).toBe(false);
  });
});
