import { describe, expect, it } from "vitest";

import { getComboSpecial } from "./combo-specials";
import {
  buildVipEmailFields,
  buildVipSmsBody,
  buildVipVoucherSectionHtml,
  vipEmailSubject,
} from "./vip-welcome";

const raceBowl = getComboSpecial("race-bowl")!;

describe("vipEmailSubject", () => {
  it("welcomes by combo name and keeps the reservation number searchable", () => {
    expect(vipEmailSubject(raceBowl, "12345")).toBe(
      "Welcome to the Ultimate VIP Experience — Booking #12345",
    );
  });
});

describe("buildVipEmailFields — itinerary", () => {
  it("renders real schedule lines, numbered and in the given (time-sorted) order", () => {
    const { itineraryHtml } = buildVipEmailFields(raceBowl, {
      scheduleLines: [
        "Starter Race · 2:00 PM",
        "VIP Bowling · 2:45 PM - 4:15 PM",
        "Intermediate Race · 4:30 PM",
      ],
    });
    const starter = itineraryHtml.indexOf("Starter Race · 2:00 PM");
    const bowl = itineraryHtml.indexOf("VIP Bowling · 2:45 PM");
    const inter = itineraryHtml.indexOf("Intermediate Race · 4:30 PM");
    expect(starter).toBeGreaterThan(-1);
    expect(bowl).toBeGreaterThan(starter);
    expect(inter).toBeGreaterThan(bowl);
    // Step blurbs attach by keyword to the real product lines.
    expect(itineraryHtml).toContain("Qualify here to unlock your Intermediate race.");
    expect(itineraryHtml).toContain("semi-private VIP lane at the HeadPinz bowling center");
    expect(itineraryHtml).toContain("Come back faster.");
  });

  it("falls back to registry legs (no times) when no schedule lines are provided", () => {
    const { itineraryHtml } = buildVipEmailFields(raceBowl);
    const starter = itineraryHtml.indexOf("Starter Race");
    const bowl = itineraryHtml.indexOf("VIP Bowling");
    const inter = itineraryHtml.indexOf("Intermediate Race");
    expect(starter).toBeGreaterThan(-1);
    expect(bowl).toBeGreaterThan(starter);
    expect(inter).toBeGreaterThan(bowl);
    expect(itineraryHtml).toContain("1.5 hours");
  });

  it("uses fallbackComponents order for a races-first (reordered) booking", () => {
    const { itineraryHtml } = buildVipEmailFields(raceBowl, { reordered: true });
    const starter = itineraryHtml.indexOf("Starter Race");
    const inter = itineraryHtml.indexOf("Intermediate Race");
    const bowl = itineraryHtml.indexOf("VIP Bowling");
    expect(starter).toBeGreaterThan(-1);
    expect(inter).toBeGreaterThan(starter);
    expect(bowl).toBeGreaterThan(inter);
  });

  it("includes the qualify fallback note", () => {
    const { itineraryHtml } = buildVipEmailFields(raceBowl);
    expect(itineraryHtml).toContain("we'll convert your Intermediate");
  });
});

describe("buildVipEmailFields — perks, tagline, duration", () => {
  it("lists every registry perk", () => {
    const { perksHtml } = buildVipEmailFields(raceBowl);
    for (const perk of raceBowl.perks!) {
      expect(perksHtml).toContain(perk.replace(/&/g, "&amp;"));
    }
  });

  it("tagline reflects the included license + POV and the full-prepay model", () => {
    const { tagline } = buildVipEmailFields(raceBowl);
    expect(tagline).toContain("Racing license");
    expect(tagline).toContain("POV race video");
    expect(tagline).toContain("paid in full");
  });

  it("duration label renders the approx sign as an HTML entity", () => {
    const { durationLabel } = buildVipEmailFields(raceBowl);
    expect(durationLabel).toBe("&asymp; 3-Hour Experience");
    expect(durationLabel).not.toMatch(/≈/);
  });

  it("customer copy has no emoji and says bowling center, never alley", () => {
    const fields = buildVipEmailFields(raceBowl, {
      scheduleLines: ["Starter Race · 2:00 PM", "VIP Bowling · 2:45 PM"],
    });
    const all = [fields.tagline, fields.itineraryHtml, fields.perksHtml].join(" ");
    expect(all.toLowerCase()).not.toContain("alley");
    // Emoji live outside the basic multilingual plane — surrogate pairs.
    expect(all).not.toMatch(/[\uD800-\uDFFF]/);
  });
});

describe("buildVipSmsBody", () => {
  const base = {
    brandName: "FastTrax",
    comboName: raceBowl.name,
    dateTime: "Sat Jul 11, 2:00 PM",
    cta: "View, waiver + POV codes",
    shortConfirm: "https://fasttraxent.com/s/abcd1234",
  };

  it("composes the VIP body and stays within one GSM-7 segment", () => {
    const body = buildVipSmsBody(base);
    expect(body).toBe(
      "FastTrax: Your Ultimate VIP Experience is booked for Sat Jul 11, 2:00 PM. " +
        "View, waiver + POV codes: https://fasttraxent.com/s/abcd1234 See you soon!",
    );
    expect(body!.length).toBeLessThanOrEqual(160);
    expect(body).not.toMatch(/[^\x00-\x7F]/);
  });

  it("never ends with the URL — trailing text keeps iOS from splitting the link into its own preview bubble", () => {
    const body = buildVipSmsBody(base);
    expect(body).not.toMatch(/https?:\/\/\S+$/);
  });

  it("survives worst-case realistic inputs within budget", () => {
    const body = buildVipSmsBody({
      ...base,
      dateTime: "Wed Sep 30, 10:00 PM",
      shortConfirm: "https://fasttraxent.com/s/abcdefgh",
    });
    expect(body).not.toBeNull();
    expect(body!.length).toBeLessThanOrEqual(160);
  });

  it("returns null when over the 160-char budget so the route falls back", () => {
    const body = buildVipSmsBody({
      ...base,
      shortConfirm:
        "https://fasttraxent.com/book/confirmation/v2?billId=12345678901234567&sig=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
    expect(body).toBeNull();
  });

  it("returns null on any non-ASCII character", () => {
    const body = buildVipSmsBody({ ...base, dateTime: "Sat Jul 11 — 2:00 PM" });
    expect(body).toBeNull();
  });

  it("omits the link clause when no short link was minted", () => {
    const body = buildVipSmsBody({ ...base, shortConfirm: "" });
    expect(body).toBe("FastTrax: Your Ultimate VIP Experience is booked for Sat Jul 11, 2:00 PM.");
  });
});

describe("buildVipVoucherSectionHtml — the V2 grant card", () => {
  const args = {
    codeDisplay: "HPW-4K7M-9PQR",
    itemLabels: ["100 bonus tokens", "laser tag or gel blaster", "shuffly"],
    expiresAt: "2027-08-03T04:59:59.000Z",
    redeemUrl: "https://headpinz.com/v/HPW4K7M9PQR",
    qrCid: "qr-HPW4K7M9PQR",
  };

  it("renders the code, the cid QR (never a data: URI), and every item", () => {
    const html = buildVipVoucherSectionHtml(args);
    expect(html).toContain("HPW-4K7M-9PQR");
    expect(html).toContain('src="cid:qr-HPW4K7M9PQR"');
    expect(html).not.toContain("data:image"); // Gmail/Outlook strip data URIs
    for (const label of args.itemLabels) expect(html).toContain(label);
    expect(html).toContain("https://headpinz.com/v/HPW4K7M9PQR");
  });

  it("carries the owner's terms: 1 year from race date + not transferable", () => {
    const html = buildVipVoucherSectionHtml(args);
    expect(html).toContain("1 year from your race date");
    expect(html).toContain("Not transferable");
    // The expiry instant (race date 23:59:59 EST + 12 months) renders in ET as
    // the day AFTER the anniversary during DST — the EST pin's deliberate
    // guest-favouring slack (see comboVoucherExpiry).
    expect(html).toContain("August 3, 2027");
  });

  it("omits the expiry sentence when the voucher never expires", () => {
    const html = buildVipVoucherSectionHtml({ ...args, expiresAt: null });
    expect(html).not.toContain("Valid through");
    expect(html).toContain("Not transferable");
  });

  it("escapes bare ampersands in item labels (email HTML stays valid)", () => {
    const html = buildVipVoucherSectionHtml({ ...args, itemLabels: ["chips & salsa"] });
    expect(html).toContain("chips &amp; salsa");
  });
});

describe("buildVipEmailFields — V2 pack 'Included With Your VIP Experience'", () => {
  const v2 = getComboSpecial("race-bowl-v2")!;

  it("merges experience items + perks into one list (owner: the split lists read the same)", () => {
    const { perksHtml } = buildVipEmailFields(v2);
    expect(perksHtml).toContain("Starter Race"); // includes[]
    expect(perksHtml).toContain("Semi-private 8-lane VIP area"); // perks[]
  });

  it("appends the voucher sub-block with the shared terms stated ONCE", () => {
    const { perksHtml } = buildVipEmailFields(v2);
    expect(perksHtml).toContain("Plus vouchers to your favorite attractions");
    expect(perksHtml).toContain("$10 Game Zone Bonus Card");
    expect(perksHtml).toContain("Laser Tag OR Gel Blaster");
    expect(perksHtml).toContain("Shuffly");
    expect(perksHtml).toContain("1 year from your race date");
    expect(perksHtml.match(/when available/gi)).toHaveLength(1);
    expect(perksHtml).toContain("Not transferable");
  });

  it("v1 (no voucherIncludes) renders the merged list with no voucher block", () => {
    const { perksHtml } = buildVipEmailFields(raceBowl);
    expect(perksHtml).not.toContain("Plus vouchers");
    expect(perksHtml).toContain("Starter Race");
  });
});

describe("buildVipVoucherSectionHtml — repeated items collapse to a qty", () => {
  const base = {
    codeDisplay: "HPW-4K7M-9PQR",
    expiresAt: "2027-08-03T23:59:59-04:00",
    redeemUrl: "https://headpinz.com/v/HPW4K7M9PQR",
    qrCid: "qr-x",
  };

  it("renders one row per DISTINCT item with a count", () => {
    // A 3-guest VIP grant repeats the per-guest items, which rendered as six
    // near-identical lines (owner 2026-08-03: "its just a long list of what is
    // include do by qty and format right").
    const html = buildVipVoucherSectionHtml({
      ...base,
      itemLabels: [
        "$10 Game Card",
        "Laser Tag or Gel Blasters",
        "$10 Game Card",
        "Laser Tag or Gel Blasters",
        "$10 Game Card",
        "Laser Tag or Gel Blasters",
        "1 Hour of Shuffly",
      ],
    });
    expect(html).toContain("3 &times; $10 Game Card");
    expect(html).toContain("3 &times; Laser Tag or Gel Blasters");
    // Singletons carry no count.
    expect(html).toContain("&nbsp;&nbsp;1 Hour of Shuffly");
    expect(html).not.toContain("1 &times;");
    // Three distinct rows, not seven.
    expect(html.match(/&#10003;/g)).toHaveLength(3);
  });

  it("keeps a single-item voucher unprefixed", () => {
    const html = buildVipVoucherSectionHtml({ ...base, itemLabels: ["$10 Game Card"] });
    expect(html).toContain("&nbsp;&nbsp;$10 Game Card");
    expect(html).not.toContain("&times;");
  });

  it("still escapes a bare ampersand in a label", () => {
    const html = buildVipVoucherSectionHtml({ ...base, itemLabels: ["chips & salsa", "chips & salsa"] });
    expect(html).toContain("2 &times; chips &amp; salsa");
  });
});
