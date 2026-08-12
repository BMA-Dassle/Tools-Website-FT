import { describe, it, expect } from "vitest";
import { onsitePillCopy, type ReservationSyncState } from "./bmi-sync-view";

const state = (over: Partial<ReservationSyncState>): ReservationSyncState => ({
  state: "unknown",
  pending: 0,
  parked: 0,
  done: 0,
  waitingKinds: [],
  oldestWaitingMin: null,
  ...over,
});

describe("onsitePillCopy — what the board is allowed to claim", () => {
  it("green only when steps actually LANDED", () => {
    const p = onsitePillCopy(state({ state: "green", done: 3 }));
    expect(p.tone).toBe("green");
    expect(p.label).toContain("✓");
    expect(p.title).toContain("3");
  });

  it("NO rows is 'unknown', never green — absence of evidence is not evidence", () => {
    const p = onsitePillCopy(state({ state: "unknown" }));
    expect(p.tone).toBe("grey");
    expect(p.label).toContain("?");
    // The wording must not imply completion.
    expect(p.title).not.toMatch(/\bdone\b|complete/i);
  });

  it("a fresh wait is quiet grey — a few seconds of sync is normal, not an alert", () => {
    const p = onsitePillCopy(
      state({
        state: "waiting",
        pending: 2,
        waitingKinds: ["push-waiver-signature"],
        oldestWaitingMin: 1,
      }),
    );
    expect(p.tone).toBe("grey");
    expect(p.label).toBe("On-site…");
  });

  it("a wait past ~10 min turns amber and shows the age — that is the stall signal", () => {
    const p = onsitePillCopy(
      state({
        state: "waiting",
        pending: 1,
        waitingKinds: ["add-membership"],
        oldestWaitingMin: 23,
      }),
    );
    expect(p.tone).toBe("amber");
    expect(p.label).toBe("On-site 23m");
    expect(p.title).toContain("add-membership");
  });

  it("parked outranks pending — something stopped retrying and needs a person", () => {
    const p = onsitePillCopy(
      state({
        state: "attention",
        parked: 1,
        pending: 4,
        waitingKinds: ["seat"],
        oldestWaitingMin: 40,
      }),
    );
    expect(p.tone).toBe("red");
    expect(p.title).toMatch(/human/i);
  });

  it("names the outstanding kinds so staff know WHAT is late", () => {
    const p = onsitePillCopy(
      state({
        state: "waiting",
        pending: 2,
        waitingKinds: ["push-waiver-signature", "add-membership"],
        oldestWaitingMin: 12,
      }),
    );
    expect(p.title).toContain("push-waiver-signature");
    expect(p.title).toContain("add-membership");
  });
});
