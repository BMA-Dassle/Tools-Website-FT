import { describe, it, expect } from "vitest";
import {
  onsitePillCopy,
  guestAddStatus,
  guestAddVerdict,
  type ReservationSyncState,
} from "./bmi-sync-view";

const state = (over: Partial<ReservationSyncState>): ReservationSyncState => ({
  state: "unknown",
  pending: 0,
  parked: 0,
  done: 0,
  waitingKinds: [],
  oldestWaitingMin: null,
  ...over,
});

describe("guestAddStatus — 'handed to the queue' is not 'BMI has it'", () => {
  it("only a FILED waiver is done", () => {
    expect(guestAddStatus("attached", "signed")).toBe("done");
    expect(guestAddStatus("attached", "salvaged")).toBe("done");
  });

  it("queued is PENDING — the push was handed off, not completed", () => {
    // The regression this guards: counting `queued` as done made a signature whose
    // consumer never ran read green forever, with no age to give it away.
    expect(guestAddStatus("attached", "queued")).toBe("pending");
  });

  it("no waiver row at all is pending, never done", () => {
    expect(guestAddStatus("attached", null)).toBe("pending");
  });

  it("a failed attach needs a human regardless of the waiver", () => {
    expect(guestAddStatus("failed", "signed")).toBe("parked");
  });
});

describe("guestAddVerdict — 'we have not asked yet' is not 'they owe a waiver'", () => {
  const CREATED = "2026-08-18T14:00:00.000Z";
  const verdict = (covered: boolean | undefined, waiver: string | null = null) =>
    guestAddVerdict({ attach: "attached", waiver, covered, attachError: null, createdAt: CREATED });

  it("BMI says covered → done, and says why", () => {
    const v = verdict(true);
    expect(v.status).toBe("done");
    expect(v.resolvedAt).toBe(CREATED);
    expect(v.lastError).toContain("BMI already holds a current waiver");
  });

  it("BMI says no → pending, and claims we asked", () => {
    const v = verdict(false);
    expect(v.status).toBe("pending");
    expect(v.resolvedAt).toBeNull();
    expect(v.lastError).toContain("waiver not recorded yet");
  });

  it("nobody has asked yet → pending, and says SO — not 'not recorded yet'", () => {
    // The regression this guards: the coverage read moved off the request path
    // (2026-08-18), so a cold cache is now normal for one poll. Spelling that the
    // same way as a real "BMI says no" is how a board starts crying wolf.
    const v = verdict(undefined);
    expect(v.status).toBe("pending");
    expect(v.lastError).toContain("checking BMI");
    expect(v.lastError).not.toContain("not recorded yet");
  });

  it("a waiver WE filed wins without asking BMI at all", () => {
    const v = verdict(undefined, "signed");
    expect(v.status).toBe("done");
    expect(v.resolvedAt).toBe(CREATED);
    expect(v.lastError).not.toContain("checking BMI");
  });

  it("a failed attach still needs a human, whatever the coverage says", () => {
    const v = guestAddVerdict({
      attach: "failed",
      waiver: null,
      covered: true,
      attachError: "person 63000000008791316 not visible at LAB52GY480CJF",
      createdAt: CREATED,
    });
    expect(v.status).toBe("parked");
    expect(v.resolvedAt).toBeNull();
    expect(v.lastError).toContain("not visible");
  });
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
