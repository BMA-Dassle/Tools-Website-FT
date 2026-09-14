import { describe, expect, it } from "vitest";
import {
  PROTO_NOW,
  QUEUE_LEADS,
  makeLead,
  minsAgo,
  minsFromNow,
} from "~/features/crm/leads/test-support";
import {
  assignToastText,
  bmiChip,
  bmiChipIsRedundant,
  cardUrgency,
  contactHrefs,
  dueLabel,
  leadName,
  leadTitle,
  relativeAge,
  stepIndex,
  typeIcon,
} from "./model";

const OPEN = {
  id: "quote",
  label: "Quote sent",
  kind: "open" as const,
  position: 5,
  slaLabel: null,
  slaHours: null,
  onBoard: true,
  archivedAt: null,
};
const WON = { ...OPEN, id: "deposit", kind: "won" as const };

describe("names", () => {
  it("title is the company when present, else the guest's name", () => {
    expect(leadTitle(QUEUE_LEADS[0]!)).toBe("Gulf Coast Logistics");
    expect(leadTitle(QUEUE_LEADS[1]!)).toBe("Priya Natarajan");
    expect(leadName(QUEUE_LEADS[0]!)).toBe("Marcus Bellamy");
  });
});

describe("dueLabel (crm-shared.js:79)", () => {
  it("overdue in days / minutes, due in, due today, due <weekday>", () => {
    expect(dueLabel(minsAgo(3 * 1440 + 5), PROTO_NOW)).toEqual({ t: "Overdue 3 d", k: "crit" });
    expect(dueLabel(minsAgo(130), PROTO_NOW)).toEqual({ t: "Overdue 2 h 10 m", k: "crit" });
    expect(dueLabel(minsFromNow(40), PROTO_NOW)).toEqual({ t: "Due in 40 min", k: "warn" });
    expect(dueLabel(minsFromNow(300), PROTO_NOW)).toEqual({ t: "Due today", k: "" });
    expect(dueLabel("2026-09-15T13:00:00.000Z", PROTO_NOW)).toEqual({ t: "Due Tue", k: "" });
  });
  it("cardUrgency tints open leads only", () => {
    const l = makeLead({
      id: "1",
      status: "quote",
      nextAction: { kind: "call", due: minsAgo(10), label: "x" },
    });
    expect(cardUrgency(l, OPEN, PROTO_NOW)).toBe("overdue");
    expect(cardUrgency(l, WON, PROTO_NOW)).toBe("");
    expect(
      cardUrgency(
        { ...l, nextAction: { kind: "call", due: minsFromNow(30), label: "x" } },
        OPEN,
        PROTO_NOW,
      ),
    ).toBe("due");
    expect(cardUrgency({ ...l, nextAction: null }, OPEN, PROTO_NOW)).toBe("");
  });
});

describe("chips and steps", () => {
  it("bmiChip: minted → outlined state chip; prospect; needs email/time; failed; creating", () => {
    expect(bmiChip(QUEUE_LEADS[0]!)).toMatchObject({ label: "BMI · New Lead", kind: "bmi" });
    expect(bmiChip(makeLead({ id: "1", isProspect: true, mintStatus: "none" }))).toMatchObject({
      label: "Prospect · no BMI yet",
      kind: "bmi",
    });
    expect(
      bmiChip(makeLead({ id: "1", mintStatus: "none", mintError: "needs_email_or_time" })),
    ).toMatchObject({ label: "BMI · needs email & time", kind: "warn" });
    expect(bmiChip(makeLead({ id: "1", mintStatus: "failed", mintError: "boom" }))).toMatchObject({
      label: "BMI · not minted",
      kind: "lost",
    });
    expect(bmiChip(makeLead({ id: "1", mintStatus: "pending" }))).toMatchObject({
      label: "BMI · creating…",
      kind: "open",
    });
  });
  it("stepIndex follows the prototype's ladder; lost statuses are -1", () => {
    expect(
      [
        "new",
        "assigned",
        "contacted",
        "waiting",
        "quote",
        "contract",
        "deposit",
        "confirmed",
        "lost",
        "noresp",
      ].map(stepIndex),
    ).toEqual([0, 0, 1, 2, 2, 3, 4, 4, -1, -1]);
    expect(stepIndex("mystery")).toBe(0);
  });
  it("typeIcon maps every event type", () => {
    expect(typeIcon("corporate")).toBe("building");
    expect(typeIcon("birthday")).toBe("gift");
    expect(typeIcon("holiday")).toBe("gift");
    expect(typeIcon("team")).toBe("users");
    expect(typeIcon("school")).toBe("star");
    expect(typeIcon("fundraiser")).toBe("flag");
  });
});

describe("misc", () => {
  it("assignToastText says what happened in BMI", () => {
    expect(assignToastText("Kelsea", { status: "synced" })).toEqual({
      text: "Assigned to Kelsea · BMI responsible updated",
      kind: "ok",
    });
    expect(assignToastText("Kelsea", { status: "failed", error: "x" }).kind).toBe("warn");
    expect(assignToastText("Kelsea", { status: "paused" }).text).toContain("paused");
  });
  it("relativeAge and contactHrefs", () => {
    expect(relativeAge(minsAgo(0), PROTO_NOW)).toBe("just now");
    expect(relativeAge(minsAgo(70), PROTO_NOW)).toBe("1 h ago");
    expect(relativeAge(minsAgo(3000), PROTO_NOW)).toBe("2 d ago");
    expect(contactHrefs(QUEUE_LEADS[0]!)).toEqual({
      tel: "tel:+12395552710",
      sms: "sms:+12395552710",
      mailto: "mailto:marcus.bellamy@gulfcoastlogistics.com",
    });
    expect(
      contactHrefs(
        makeLead({
          id: "1",
          guest: { first: "A", last: "B", phone: null, email: null, company: null, prefers: null },
        }),
      ),
    ).toEqual({ tel: null, sms: null, mailto: null });
  });
});

describe("bmiChipIsRedundant", () => {
  /**
   * The chip earns its line only when Office DISAGREES with the column (on a
   * board card) or with the status chip beside it (on the deal header).
   * "BMI · Pending Quote" under a "Pending Quote" header is a second chip
   * carrying no second fact — and it was repeated down twenty cards. Owner,
   * 2026-09-14: "I still think you can do better with these tiles", and on the
   * deal header: "No hierarchy — the eye has nowhere to land first."
   */
  const minted = (stateName: string | null) =>
    makeLead({
      id: "1",
      bmi: {
        projectId: "63000000009561437",
        projectNumber: "H1",
        stateId: "-2",
        stateName,
        personId: null,
        syncedAt: null,
      },
    });

  it("is redundant when Office says what the status already says", () => {
    expect(bmiChipIsRedundant(minted("Pending Quote"), "Pending Quote")).toBe(true);
    // Case and spacing do not make it a different fact.
    expect(bmiChipIsRedundant(minted("pending  quote"), "Pending Quote")).toBe(true);
    // Office's per-centre suffix is not a difference either.
    expect(bmiChipIsRedundant(minted("Deposit Requested (HPFM)"), "Deposit Requested")).toBe(true);
  });

  it("is NOT redundant when they disagree — which is the case worth showing", () => {
    expect(bmiChipIsRedundant(minted("New Lead"), "Contract sent")).toBe(false);
  });

  it("never suppresses a chip that is not about a real project", () => {
    // "not minted", "creating…" and "needs email & time" are always worth
    // saying, whatever the status chip reads.
    const noProject = makeLead({ id: "2", mintStatus: "none" });
    expect(bmiChipIsRedundant(noProject, "New")).toBe(false);
    expect(bmiChipIsRedundant(minted(null), "New")).toBe(false);
  });

  it("with no status to compare against, the chip stands", () => {
    expect(bmiChipIsRedundant(minted("Pending Quote"), null)).toBe(false);
    expect(bmiChipIsRedundant(minted("Pending Quote"), undefined)).toBe(false);
  });
});
