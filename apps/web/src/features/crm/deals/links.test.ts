import { describe, expect, it } from "vitest";
import { BRAND_HOST, dealLinks, waiverHref, type DealLinkInput } from "./links";
import type { LeadContractSummary } from "../leads/contracts";

/**
 * The links a planner opens FOR a guest (owner, 2026-09-13). Two things here
 * are worth pinning rather than eyeballing: the brand host, because a
 * cross-brand link reads as phishing to whoever clicks it, and the waiver's
 * loc/pid pair, because half of it silently attaches the signature to nothing
 * while still looking reservation-scoped.
 */

const QUOTE: LeadContractSummary = {
  shortId: "e41b6fdf",
  status: "balance_link_sent",
  baseUrl: null,
  totalCents: 464879,
  depositDueCents: 239724,
  balanceCents: 225155,
  collectedCents: 239724,
  sentAt: "2026-08-20T12:00:00.000Z",
  signedAt: "2026-08-28T11:00:00.000Z",
  depositPaidAt: "2026-08-28T11:13:36.328Z",
  balancePaidAt: null,
};

const input = (over: Partial<DealLinkInput> = {}): DealLinkInput => ({
  publicId: "L-225",
  centre: "HPFM",
  contract: QUOTE,
  bmiProjectId: "47357477",
  locationId: 332160,
  ...over,
});

const byId = (i: DealLinkInput) => new Map(dealLinks(i).map((l) => [l.id, l]));

describe("dealLinks", () => {
  it("a HeadPinz event's guest links stay on headpinz.com", () => {
    const m = byId(input());
    expect(m.get("contract")!.href).toBe("https://headpinz.com/contract/e41b6fdf");
    expect(m.get("pdf")!.href).toBe("https://headpinz.com/contract/e41b6fdf/pdf");
  });

  it("a FastTrax event's do NOT — they go to fasttraxent.com", () => {
    const m = byId(input({ centre: "FT" }));
    expect(m.get("contract")!.href).toBe("https://fasttraxent.com/contract/e41b6fdf");
    expect(BRAND_HOST.FT).toBe("https://fasttraxent.com");
  });

  it("the quote's own base_url WINS over the centre's brand — it is the host the contract was issued on", () => {
    const m = byId(input({ contract: { ...QUOTE, baseUrl: "https://fasttraxent.com/" } }));
    // Trailing slash trimmed, no doubled separator.
    expect(m.get("contract")!.href).toBe("https://fasttraxent.com/contract/e41b6fdf");
  });

  it("Pay balance is offered only while there is a balance left to collect", () => {
    expect(byId(input()).has("pay")).toBe(true);
    expect(byId(input({ contract: { ...QUOTE, balanceCents: 0 } })).has("pay")).toBe(false);
    expect(
      byId(input({ contract: { ...QUOTE, balancePaidAt: "2026-09-01T00:00:00.000Z" } })).has("pay"),
    ).toBe(false);
  });

  it("an unsigned contract still lists the PDF, but says it will 404", () => {
    const m = byId(input({ contract: { ...QUOTE, signedAt: null } }));
    expect(m.get("pdf")!.hint).toContain("404");
  });

  it("no contract: the waiver is the only link, because it is the only one that is not contract-scoped", () => {
    const links = dealLinks(input({ contract: null }));
    expect(links.map((l) => l.id)).toEqual(["waiver"]);
  });

  it("contract history stays inside the CRM and is marked staff-only", () => {
    const h = byId(input()).get("history")!;
    expect(h.audience).toBe("staff");
    expect(h.href).toBe("/admin/crm/deal/L-225?tab=history");
  });
});

describe("waiverHref", () => {
  it("carries BOTH loc and pid so the signature attaches to the event", () => {
    const url = new URL(waiverHref(input()));
    expect(url.searchParams.get("loc")).toBe("332160");
    expect(url.searchParams.get("pid")).toBe("47357477");
    expect(url.searchParams.get("c")).toBe("headpinz");
  });

  it("drops BOTH when there is no project — a half-set pair attaches to nothing while looking scoped", () => {
    const url = new URL(waiverHref(input({ bmiProjectId: null })));
    expect(url.searchParams.has("loc")).toBe(false);
    expect(url.searchParams.has("pid")).toBe(false);
    expect(dealLinks(input({ bmiProjectId: null })).find((l) => l.id === "waiver")!.hint).toContain(
      "will not attach",
    );
  });

  it("names the centre's own brand", () => {
    expect(new URL(waiverHref(input({ centre: "FT" }))).searchParams.get("c")).toBe("fasttrax");
    expect(new URL(waiverHref(input({ centre: "HPN" }))).searchParams.get("c")).toBe("headpinz");
  });
});
