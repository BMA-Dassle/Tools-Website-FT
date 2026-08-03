import { describe, it, expect } from "vitest";
import {
  DEAL_CATALOG,
  DEAL_LOCATIONS,
  dealExpiryFrom,
  dealIsSellable,
  dealVoucherItems,
  dealVoucherSummary,
  dealValue,
  getDeal,
  isDealLocation,
} from "./catalog";

describe("deal catalog shape", () => {
  it("has the two packs the owner priced", () => {
    expect(DEAL_CATALOG.map((d) => [d.slug, d.priceCents])).toEqual([
      ["laser-tag-game-card-pack", 3400],
      ["gel-blaster-game-card-pack", 4500],
    ]);
  });

  it("mints TWO qty:1 admissions, never one qty:2", () => {
    // Coverage is awarded one unit per APPLIED SESSION ENTRY, and claims are
    // unique per (code, itemIndex). A single qty:2 item would cover one unit and
    // silently charge for the second, and could not be split across visits.
    for (const deal of DEAL_CATALOG) {
      const admissions = deal.items.filter((i) => i.kind === "attraction");
      expect(admissions).toHaveLength(2);
      for (const item of admissions) {
        expect(item).toEqual({ kind: "attraction", slug: deal.scheduleSlug, qty: 1 });
      }
    }
  });

  it("mints two separate game-card items with comped value in the BONUS bucket", () => {
    const laser = getDeal("laser-tag-game-card-pack")!;
    expect(laser.items.filter((i) => i.kind === "gamezone")).toEqual([
      { kind: "gamezone", tokens: 0, bonusTokens: 100, bonusCashDollars: 0 },
      { kind: "gamezone", tokens: 0, bonusTokens: 100, bonusCashDollars: 0 },
    ]);
    const gel = getDeal("gel-blaster-game-card-pack")!;
    expect(gel.items.filter((i) => i.kind === "gamezone")).toEqual([
      { kind: "gamezone", tokens: 0, bonusTokens: 150, bonusCashDollars: 0 },
      { kind: "gamezone", tokens: 0, bonusTokens: 150, bonusCashDollars: 0 },
    ]);
  });

  it("every game-card denomination is on the MINT allowlist", async () => {
    // mintVouchers throws on an off-allowlist denomination, so a bad number here
    // would break the purchase at capture time — after the guest has paid.
    const { NATIVE_GRANT_DENOMINATIONS } =
      await import("~/features/game-cards/service/native-voucher");
    for (const deal of DEAL_CATALOG) {
      for (const item of deal.items) {
        if (item.kind === "gamezone") {
          expect(NATIVE_GRANT_DENOMINATIONS).toContain(item.bonusTokens);
        }
      }
    }
  });

  it("is sellable — every deal carries a Square catalog id", () => {
    // Charging without one books revenue that is invisible in QBO and cannot be
    // retro-fitted onto a captured payment, so buildDealOrder refuses.
    for (const deal of DEAL_CATALOG) {
      expect(dealIsSellable(deal), `${deal.slug} has no Square catalog id`).toBe(true);
    }
  });

  it("points at the live Square variations, not item ids", () => {
    // Pinned literally: these were read off the Square Catalog API, and a
    // dashboard column clipped them (the laser id's 9th char is P, not F). A typo
    // here fails at order-create, after the buyer has filled the form in.
    expect(getDeal("laser-tag-game-card-pack")!.squareCatalogId).toBe("FGDAFYAVPFJ2GRRZQXNHZJB6");
    expect(getDeal("gel-blaster-game-card-pack")!.squareCatalogId).toBe("B6ST5YMWFNLL66PVQXVXXYFY");
    // Square catalog ids are 24 chars here — a clipped paste is the likely error.
    for (const deal of DEAL_CATALOG) {
      expect(deal.squareCatalogId).toHaveLength(24);
    }
  });

  it("resolves and rejects location keys", () => {
    expect(DEAL_LOCATIONS).toEqual(["headpinz", "naples"]);
    expect(isDealLocation("naples")).toBe(true);
    expect(isDealLocation("headpinz")).toBe(true);
    expect(isDealLocation("fasttrax")).toBe(false); // FastTrax sells neither
    expect(isDealLocation("")).toBe(false);
  });

  it("returns null for an unknown slug", () => {
    expect(getDeal("nope")).toBeNull();
  });
});

describe("dealValue — the advertised strikethrough", () => {
  it("prices the laser pack at $44 à la carte, a 22% saving", () => {
    const v = dealValue(getDeal("laser-tag-game-card-pack")!, "headpinz", 3400);
    expect(v.lines).toEqual([
      { label: "2 × Laser Tag (7 min session · 20 min experience)", cents: 2000 },
      { label: "200 Game Zone Tokens", cents: 2000 },
      { label: "2 × new-card activation fee", cents: 400 },
    ]);
    expect(v.compareAtCents).toBe(4400);
    expect(v.savingsCents).toBe(1000);
    // 1000/4400 = 22.7% — floored, because a discount must never be overstated.
    expect(v.savingsPct).toBe(22);
  });

  it("prices the gel pack at $58 à la carte, a 22% saving", () => {
    const v = dealValue(getDeal("gel-blaster-game-card-pack")!, "headpinz", 4500);
    expect(v.lines).toEqual([
      { label: "2 × Gel Blasters (7 min session · 20 min experience)", cents: 2400 },
      { label: "300 Game Zone Tokens", cents: 3000 },
      { label: "2 × new-card activation fee", cents: 400 },
    ]);
    expect(v.compareAtCents).toBe(5800);
    expect(v.savingsCents).toBe(1300);
    expect(v.savingsPct).toBe(22);
  });

  it("prices every deal at every location it is sold for", () => {
    // A deal offered at a location with no product there would throw — which is
    // the point: an under-stated "value" is a false advertising claim.
    for (const deal of DEAL_CATALOG) {
      for (const location of deal.locations) {
        const v = dealValue(deal, location, deal.priceCents);
        expect(v.compareAtCents).toBeGreaterThan(deal.priceCents);
        expect(v.savingsPct).toBeGreaterThan(0);
      }
    }
  });

  it("counts a limited-time bonus into the value, so the saving really does drop", () => {
    // This is what makes "limited time" honest without touching the price. The
    // bonus is real value, so it lifts the à-la-carte total and the advertised
    // saving with it — and when the offer ends, the same $34 shows a smaller
    // saving automatically, with no copy edit anywhere.
    const laser = getDeal("laser-tag-game-card-pack")!;
    const bonus = { kind: "gamezone" as const, tokens: 0, bonusTokens: 50, bonusCashDollars: 0 };

    const withBonus = dealValue(laser, "headpinz", 3400, [bonus]);
    const without = dealValue(laser, "headpinz", 3400);

    expect(withBonus.priceCents).toBe(without.priceCents);
    expect(withBonus.compareAtCents).toBe(4900);
    expect(withBonus.savingsCents).toBe(1500);
    expect(withBonus.savingsPct).toBe(30);
    expect(without.savingsPct).toBe(22);

    // The bonus is its own line, so the offer is visible in the table.
    expect(withBonus.lines).toContainEqual({
      label: "50 bonus Game Zone Tokens (limited time)",
      cents: 500,
    });
  });

  it("does not charge the value table an activation fee for bonus tokens", () => {
    // Bonus tokens ride the cards the pack already includes. Counting another
    // $2 activation fee would overstate the saving — the same instinct as the
    // throw for a missing product: never inflate.
    const laser = getDeal("laser-tag-game-card-pack")!;
    const bonus = { kind: "gamezone" as const, tokens: 0, bonusTokens: 50, bonusCashDollars: 0 };
    const v = dealValue(laser, "headpinz", 3400, [bonus]);
    const fees = v.lines.filter((l) => l.label.includes("activation fee"));
    expect(fees).toEqual([{ label: "2 × new-card activation fee", cents: 400 }]);
  });

  it("throws rather than under-stating when a product is missing at a location", () => {
    const bogus = {
      ...getDeal("laser-tag-game-card-pack")!,
      items: [{ kind: "attraction" as const, slug: "duck-pin", qty: 1 }],
    };
    // Duckpin is FastTrax-only — there is no Naples product.
    expect(() => dealValue(bogus, "naples", 3400)).toThrow(/no duck-pin product at naples/);
  });
});

describe("dealExpiryFrom", () => {
  it("uses the REAL ET offset so the date never rolls (DST)", () => {
    // The bug this guards: a hardcoded -05:00 means 23:59:59 EST is 00:59:59
    // EDT the FOLLOWING morning, so a pack bought 3 Aug rendered as expiring
    // 4 Aug in every surface that formats in America/New_York. An off-by-one on
    // a printed expiry is something a guest argues with staff about.
    expect(dealExpiryFrom(new Date("2026-08-02T14:30:00Z"), 12)).toBe("2027-08-02T23:59:59-04:00");
    // Winter really is -05:00.
    expect(dealExpiryFrom(new Date("2026-01-15T12:00:00Z"), 12)).toBe("2027-01-15T23:59:59-05:00");
  });

  it("still reads as the intended day once formatted in ET", () => {
    // The assertion that actually matters — what the guest sees.
    for (const iso of ["2026-08-03T12:00:00Z", "2026-12-20T12:00:00Z"]) {
      const purchased = new Date(iso);
      const expires = dealExpiryFrom(purchased, 12);
      const shown = new Date(expires).toLocaleDateString("en-US", {
        timeZone: "America/New_York",
        month: "numeric",
        day: "numeric",
        year: "numeric",
      });
      const want = new Date(purchased);
      want.setFullYear(want.getFullYear() + 1);
      expect(shown).toBe(`${want.getMonth() + 1}/${want.getDate()}/${want.getFullYear()}`);
    }
  });
});

describe("dealVoucherSummary", () => {
  it("collapses duplicate legs and prices Game Zone value as dollars of tokens", () => {
    // itemsSummary groups the same legs generically ("200 Tokens + 2 × Laser
    // Tag") because all it has is the legs. A seller knows the product was sold
    // as N packs, so it can name the Game Zone rail the buyer saw.
    expect(dealVoucherSummary(getDeal("laser-tag-game-card-pack")!)).toBe(
      "2 × Laser Tag + 200 Game Zone Tokens",
    );
    expect(dealVoucherSummary(getDeal("gel-blaster-game-card-pack")!)).toBe(
      "2 × Gel Blasters + 300 Game Zone Tokens",
    );
  });
});

describe("dealVoucherItems — the limited-time bonus", () => {
  const bonus = { kind: "gamezone" as const, tokens: 0, bonusTokens: 50, bonusCashDollars: 0 };
  const laser = getDeal("laser-tag-game-card-pack")!;

  it("grants the bonus PER PACK, not once per order", () => {
    // Three packs bought during a 50-token offer are owed three 50-token legs.
    // Granting one would quietly short two thirds of what was advertised.
    const items = dealVoucherItems(laser, 3, [bonus]);
    expect(items.filter((i) => i.kind === "gamezone" && i.bonusTokens === 50)).toHaveLength(3);
    // And the pack's own legs are still all there, three times over.
    expect(items.filter((i) => i.kind === "attraction")).toHaveLength(6);
    expect(items).toHaveLength(3 * 4 + 3);
  });

  it("appends rather than replaces, and changes nothing when there is no bonus", () => {
    expect(dealVoucherItems(laser, 1, [])).toEqual(laser.items);
    expect(dealVoucherItems(laser, 1)).toEqual(laser.items);
    expect(dealVoucherItems(laser, 1, [bonus])).toEqual([...laser.items, bonus]);
  });

  it("describes the bonus in the receipt summary the buyer receives", () => {
    // 200 pack tokens + 50 bonus. The receipt must describe the voucher that was
    // actually minted, not the catalog pack.
    expect(dealVoucherSummary(laser, 1, [bonus])).toBe("2 × Laser Tag + 250 Game Zone Tokens");
    expect(dealVoucherSummary(laser, 1)).toBe("2 × Laser Tag + 200 Game Zone Tokens");
  });
});

describe("dealVoucherItems — combining packs onto one code", () => {
  it("repeats the pack's legs, one discrete leg per redeemable unit", () => {
    // Repeated legs rather than qty>1 on purpose: a claim is unique per
    // (code, itemIndex) and coverage awards ONE unit per applied entry, so N
    // discrete legs is what makes N units separately redeemable. A single
    // qty:N item would cover one and silently charge for the rest.
    const deal = getDeal("laser-tag-game-card-pack")!;
    const three = dealVoucherItems(deal, 3);
    expect(three).toHaveLength(deal.items.length * 3);
    expect(three.filter((i) => i.kind === "attraction")).toHaveLength(6);
    expect(three.filter((i) => i.kind === "gamezone")).toHaveLength(6);
    for (const item of three) {
      if (item.kind === "attraction") expect(item.qty).toBe(1);
    }
  });

  it("one pack returns the registry list untouched", () => {
    const deal = getDeal("gel-blaster-game-card-pack")!;
    expect(dealVoucherItems(deal, 1)).toBe(deal.items);
    expect(dealVoucherItems(deal)).toBe(deal.items);
  });

  it("treats a nonsense pack count as one", () => {
    const deal = getDeal("laser-tag-game-card-pack")!;
    expect(dealVoucherItems(deal, 0)).toHaveLength(deal.items.length);
    expect(dealVoucherItems(deal, -2)).toHaveLength(deal.items.length);
  });

  it("scales the guest-facing summary with the pack count", () => {
    const deal = getDeal("laser-tag-game-card-pack")!;
    expect(dealVoucherSummary(deal, 3)).toBe("6 × Laser Tag + 600 Game Zone Tokens");
    // Still every denomination the mint allowlist accepts.
    expect(dealVoucherSummary(deal, 1)).toBe("2 × Laser Tag + 200 Game Zone Tokens");
  });
});
