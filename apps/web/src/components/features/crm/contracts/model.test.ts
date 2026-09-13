import { describe, expect, it } from "vitest";
import type { ContractRow } from "~/features/crm/contracts/contracts";
import {
  CENTRE_OPTIONS,
  WINDOW_OPTIONS,
  balanceNote,
  depositCell,
  depositNote,
  emptyMessage,
  pagerSummary,
  rowMeta,
  sentBannerText,
  statusFolderOptions,
  tileSpecs,
  weekLabel,
  withWeekHeaders,
} from "./model";

/**
 * The Contracts screen's pure half — copy and shape, straight from the
 * prototype (`crm-events.js:206-236`). Structure-level only (R12); nothing
 * here renders React.
 */
const row = (patch: Partial<ContractRow> = {}): ContractRow =>
  ({
    quoteId: "1",
    shortId: "7Hx2Qk",
    projectId: "63000000009561437",
    title: "Storm Smart",
    guestName: "Rick Alvarez",
    guestPhone: "2395551234",
    guestEmail: "rick@stormsmart.test",
    centre: "FT",
    centerCode: "fasttrax",
    centerName: "FastTrax Fort Myers",
    eventDate: "2026-09-18",
    eventNumber: "DH2879",
    guests: 42,
    status: "contract_sent",
    postPaid: false,
    taxExempt: false,
    totalCents: 189_000,
    taxCents: 11_750,
    depositDueCents: 100_375,
    balanceCents: 100_375,
    collectedCents: 0,
    sentAt: null,
    signedAt: null,
    depositPaidAt: null,
    balancePaidAt: null,
    balanceLinkSentAt: null,
    dayofOrderId: null,
    settledOrderId: null,
    giftCardGan: null,
    savedCardBrand: null,
    savedCardLast4: null,
    signedPdfUrl: null,
    plannerEmail: null,
    plannerName: null,
    rep: null,
    leadPublicId: null,
    daysOut: 5,
    sentAgoDays: null,
    reasons: [],
    createdAt: "2026-08-20T13:00:00.000Z",
    updatedAt: "2026-09-01T13:00:00.000Z",
    ...patch,
  }) as ContractRow;

describe("windows and folders", () => {
  it("the six windows, in the prototype's order and wording", () => {
    expect(WINDOW_OPTIONS).toEqual([
      { value: "attention", label: "Needs attention" },
      { value: "7", label: "Next 7 days" },
      { value: "30", label: "Next 30 days" },
      { value: "90", label: "Next 90 days" },
      { value: "past", label: "Past" },
      { value: "all", label: "All dates" },
    ]);
  });

  it("the status folders label 'all' as 'Any status' and the rest from the status table", () => {
    const opts = statusFolderOptions();
    expect(opts[0]).toEqual({ value: "all", label: "Any status" });
    expect(opts.find((o) => o.value === "balance_charged")?.label).toBe("Balance funded");
    expect(opts.find((o) => o.value === "pending_approval")?.label).toBe("Needs approval");
  });

  it("the centre picker offers all three, by short name", () => {
    expect(CENTRE_OPTIONS.map((c) => c.value)).toEqual(["HPFM", "FT", "HPN"]);
    expect(CENTRE_OPTIONS[1].label).toBe("FastTrax");
  });
});

describe("week banding", () => {
  it("labels the Sunday-to-Saturday week the event falls in", () => {
    expect(weekLabel("2026-09-18")).toBe("Week of Sep 13 – Sep 19");
    expect(weekLabel("2026-09-13")).toBe("Week of Sep 13 – Sep 19");
    expect(weekLabel("2026-09-12")).toBe("Week of Sep 6 – Sep 12");
    expect(weekLabel("not-a-date")).toBe("");
  });

  it("bands consecutive rows once per week", () => {
    const rows = [
      row({ eventDate: "2026-09-15" }),
      row({ eventDate: "2026-09-18" }),
      row({ eventDate: "2026-09-22" }),
    ];
    expect(withWeekHeaders(rows, "30").map((r) => r.weekHeader)).toEqual([
      "Week of Sep 13 – Sep 19",
      null,
      "Week of Sep 20 – Sep 26",
    ]);
  });

  it("NEVER bands the attention window — it is a work queue, not a calendar", () => {
    const rows = [row({ eventDate: "2026-09-15" }), row({ eventDate: "2026-09-22" })];
    expect(withWeekHeaders(rows, "attention").map((r) => r.weekHeader)).toEqual([null, null]);
  });
});

describe("the row's cells", () => {
  it("a post-paid event owes no deposit — a dash, not $0.00", () => {
    expect(depositCell(row({ postPaid: true }))).toEqual({ text: "—", paid: false });
  });

  it("a paid deposit is ticked and tinted", () => {
    expect(depositCell(row({ depositPaidAt: "2026-09-01T13:00:00.000Z" }))).toEqual({
      text: "$1,004 ✓",
      paid: true,
    });
    expect(depositCell(row())).toEqual({ text: "$1,004", paid: false });
  });

  it("the meta line reads centre · event number · guests", () => {
    expect(rowMeta(row())).toBe("FastTrax · #DH2879 · 42 guests");
    expect(rowMeta(row({ centre: null, eventNumber: null, guests: null }))).toBe(
      "FastTrax Fort Myers",
    );
  });
});

describe("tiles, empty states and the pager", () => {
  it("the four tiles, in order, with the prototype's labels", () => {
    const specs = tileSpecs({
      attention: 7,
      outUnsigned: 3,
      outUnsignedCents: 1_234_500,
      depositsHeldCents: 987_600,
      balanceOutstandingCents: 555_000,
    });
    expect(specs.map((s) => s.label)).toEqual([
      "Needs attention",
      "Out, unsigned",
      "Deposits held (open events)",
      "Balance outstanding",
    ]);
    expect(specs[0].value).toBe("7");
    expect(specs[0].sub).toBe("unsigned, approvals, failed charges, open past events");
    expect(specs[3].sub).toBe("auto-charges at T-72h");
  });

  it("the empty line differs by window, as the prototype's does", () => {
    expect(emptyMessage("attention")).toBe("Nothing needs a human right now.");
    expect(emptyMessage("30")).toBe("No contracts in this window.");
  });

  it("the pager summary pluralises", () => {
    expect(pagerSummary(1, 25)).toBe("1 contract · sorted by event date · 25 per page");
    expect(pagerSummary(12, 25)).toBe("12 contracts · sorted by event date · 25 per page");
  });
});

describe("the Contract tab's money notes", () => {
  it("balance: settled, invoiced after the event, or auto-charged", () => {
    expect(balanceNote(row({ balanceCents: 0 }))).toBe("settled");
    expect(balanceNote(row({ postPaid: true }))).toBe("invoiced after the event");
    expect(balanceNote(row())).toBe("auto-charges 72 h before");
  });

  it("the sent banner reads the SERVER's day count, never a clock in render", () => {
    expect(sentBannerText(row({ sentAgoDays: 12 }), 3)).toBe(
      "Sent 12 days ago · guest opened it 3× · not signed. Automatic 96-hour reminder is scheduled.",
    );
    expect(sentBannerText(row({ sentAgoDays: 1 }), 0)).toContain("Sent 1 day ago");
    expect(sentBannerText(row({ sentAgoDays: 0 }), 0)).toContain("Sent today");
    expect(sentBannerText(row({ sentAgoDays: null }), 0)).toContain("Sent today");
  });

  it("deposit: paid, none for post-paid, else due at signing", () => {
    expect(depositNote(row({ depositPaidAt: "2026-09-01T13:00:00.000Z" }))).toContain("paid ");
    expect(depositNote(row({ postPaid: true }))).toBe("none — post-paid");
    expect(depositNote(row())).toBe("due at signing");
  });
});
