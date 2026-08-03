import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  activeOutages,
  bmiWriteBlocked,
  bookingProductForPath,
  isProductPaused,
  isVendorDown,
  maintenanceRedirectForPath,
  pausedProductIds,
  SERVICE_NOTICE_PATH,
  vendorsForProduct,
} from ".";

/**
 * ONE variable drives everything: MAINTENANCE_VENDORS_DOWN lists the vendors that
 * are down. Unset = nothing down (owner 2026-08-03: "have everything as off by
 * default then tell me what to flip on").
 */
const down = (v: string) => {
  process.env.MAINTENANCE_VENDORS_DOWN = v;
};

afterEach(() => {
  delete process.env.MAINTENANCE_VENDORS_DOWN;
  delete process.env.NEXT_PUBLIC_FASTTRAX_QAMF_DUCKPIN;
});

describe("nothing is down by default", () => {
  // The safety cost of the env-driven model, pinned deliberately: with no
  // variable set, EVERYTHING sells. If someone forgets to set it during an
  // outage we take money we cannot fulfil, so this behavior must be explicit
  // and visible in the suite rather than an accident of implementation.
  it("sells everything and shows no notice when the variable is unset", () => {
    expect(activeOutages()).toEqual([]);
    expect(pausedProductIds()).toEqual([]);
    expect(isVendorDown("bmi")).toBe(false);
    expect(maintenanceRedirectForPath("/book/race/v2")).toBeNull();
    expect(bmiWriteBlocked("booking/book")).toBe(false);
  });

  it("treats an empty or whitespace value as nothing down", () => {
    down("");
    expect(activeOutages()).toEqual([]);
    down("   ");
    expect(activeOutages()).toEqual([]);
  });
});

describe("MAINTENANCE_VENDORS_DOWN parsing", () => {
  it("accepts the value TODAY's outage uses", () => {
    down("bmi");
    expect(isVendorDown("bmi")).toBe(true);
    expect(activeOutages().map((o) => o.vendor)).toEqual(["bmi"]);
  });

  it("accepts several vendors, and tolerates case, spaces and underscores", () => {
    down(" BMI , bmi_office ");
    expect(isVendorDown("bmi")).toBe(true);
    expect(isVendorDown("bmi-office")).toBe(true);
  });

  it("de-duplicates repeats", () => {
    down("bmi,bmi,BMI");
    expect(activeOutages()).toHaveLength(1);
  });

  it("ignores an unknown name without taking down the valid ones alongside it", () => {
    // A typo must not break the whole variable — the vendors that ARE named still
    // go down. (The parser logs the bad token; failing open silently is the risk
    // this guards.)
    down("bmiii,bmi");
    expect(isVendorDown("bmi")).toBe(true);
    expect(activeOutages().map((o) => o.vendor)).toEqual(["bmi"]);
  });

  it("gives every listed vendor real guest copy, tailored or generic", () => {
    down("bmi,qamf");
    const [bmi, qamf] = activeOutages();
    expect(bmi.web.body).toContain("racing"); // tailored
    expect(bmi.kiosk.es).toContain("Servicio al Cliente");
    expect(qamf.web.heading).toBeTruthy(); // generic fallback, still complete
    expect(qamf.web.body).toContain("outage");
    expect(qamf.kiosk.es).toContain("Servicio al Cliente");
  });

  it("always carries a shortNote — a locked card must explain itself standalone", () => {
    // "Temporarily unavailable" with no reason reads like the product was
    // discontinued (owner 2026-08-03). Every vendor, tailored or generic, has to
    // supply the one-liner the locked CTA renders, and it must say when to return.
    down("bmi,bmi-office,pandora,qamf,intercard");
    for (const o of activeOutages()) {
      expect(o.web.shortNote, o.vendor).toBeTruthy();
      expect(o.web.shortNote.length, o.vendor).toBeLessThan(120); // fits a card
      expect(o.web.shortNote.toLowerCase(), o.vendor).toContain("check back");
    }
  });
});

describe("today's outage: MAINTENANCE_VENDORS_DOWN=bmi", () => {
  beforeEach(() => down("bmi"));

  it("takes exactly the products that need the BMI booking rail off sale", () => {
    // `checkin` is here because it needs the booking API to FINISH (attach +
    // schedule + state stamp), not just Office to look up. `waiver` is NOT: its
    // lookup is Office and its signing is Pandora, both healthy.
    expect(pausedProductIds().sort()).toEqual(
      [
        "checkin",
        "gel-blaster",
        "laser-tag",
        "race",
        "race-bowl",
        "race-pack",
        "shuffly",
        "shuffly-fasttrax",
        "shuffly-headpinz",
        "ultimate-qualifier",
      ].sort(),
    );
  });

  it("puts the VIP combo on BOTH vendors — either one down takes it off sale", () => {
    expect(vendorsForProduct("race-bowl")).toEqual(["bmi", "qamf"]);
    expect(isProductPaused("race-bowl")).toBe(true);
  });

  it("keeps bowling, KBF and Game Zone selling — different vendors", () => {
    for (const id of ["bowling", "kbf", "game-zone"]) {
      expect(vendorsForProduct(id)).not.toContain("bmi");
      expect(isProductPaused(id)).toBe(false);
    }
  });

  it("keeps waivers and group contracts up — neither is on the booking API", () => {
    expect(vendorsForProduct("waiver")).toEqual(["bmi-office"]);
    expect(isProductPaused("waiver")).toBe(false);
    expect(maintenanceRedirectForPath("/waiver")).toBeNull();
    expect(vendorsForProduct("contract")).toEqual(["pandora"]);
    expect(isProductPaused("contract")).toBe(false);
  });

  // E-tickets stay out of scope entirely (owner: "dont do anything with
  // eticket") — display-only, and not classified, so no value of the env var can
  // reach them. Pinned so nobody "completes" the map later.
  it("cannot touch e-tickets, whatever is listed as down", () => {
    down("bmi,bmi-office,pandora,qamf,intercard");
    expect(vendorsForProduct("eticket")).toEqual([]);
    expect(isProductPaused("eticket")).toBe(false);
    for (const p of ["/t/abc123", "/g/abc123"]) {
      expect(maintenanceRedirectForPath(p)).toBeNull();
    }
  });

  // Kiosk check-in needs BOTH rails: Office to find the reservation, the booking
  // API to finish it. Its BMI writes fail silently by design, so a dark booking
  // rail means the kiosk confirms a check-in BMI never recorded — a confident
  // false success, worse than a closed door (owner 2026-08-03).
  it("takes kiosk check-in down with EITHER BMI rail", () => {
    expect(vendorsForProduct("checkin")).toEqual(["bmi", "bmi-office"]);
    expect(isProductPaused("checkin")).toBe(true); // today: booking rail down
    down("bmi-office");
    expect(isProductPaused("checkin")).toBe(true); // lookup rail down
    down("qamf");
    expect(isProductPaused("checkin")).toBe(false); // neither BMI rail down
  });

  it("still never redirects a check-in URL — the kiosk page guards itself", () => {
    // Enforcement is the /kiosk/checkin server component, not the middleware
    // gate: the kiosk needs its own chrome and Spanish, and /book/bowling/checkin
    // is QAMF lane check-in that must keep working regardless.
    down("bmi,bmi-office");
    for (const p of ["/kiosk/checkin", "/book/bowling/checkin", "/hp/book/bowling/checkin"]) {
      expect(maintenanceRedirectForPath(p)).toBeNull();
    }
  });

  it("redirects paused booking entries and refuses the sale-opening BMI writes", () => {
    expect(maintenanceRedirectForPath("/book/race/v2")).toEqual({
      path: SERVICE_NOTICE_PATH,
      product: "race",
    });
    expect(bmiWriteBlocked("booking/book")).toBe(true);
    expect(bmiWriteBlocked("booking/sell")).toBe(true);
  });

  it("lets an already-charged session finish and abandoned holds be released", () => {
    // Blocking these is how you orphan a charge or strand a hold on a heat.
    for (const e of ["payment/confirm", "booking/removeItem", "booking/memo", "availability"]) {
      expect(bmiWriteBlocked(e)).toBe(false);
    }
  });
});

describe("duckpin follows its own vendor flag", () => {
  it("is QAMF by default, and moves under a BMI outage only if reverted", () => {
    down("bmi");
    expect(vendorsForProduct("duck-pin")).toEqual(["qamf"]); // QAMF 11542
    expect(isProductPaused("duck-pin")).toBe(false);
    process.env.NEXT_PUBLIC_FASTTRAX_QAMF_DUCKPIN = "false"; // legacy BMI page
    expect(vendorsForProduct("duck-pin")).toEqual(["bmi"]);
    expect(isProductPaused("duck-pin")).toBe(true);
  });

  it("fails OPEN for a product it doesn't classify", () => {
    down("bmi");
    expect(vendorsForProduct("some-future-thing")).toEqual([]);
    expect(isProductPaused("some-future-thing")).toBe(false);
  });
});

describe("an Office outage takes waivers down", () => {
  it("only needs the vendor added to the list", () => {
    down("bmi,bmi-office");
    expect(isProductPaused("waiver")).toBe(true);
    expect(maintenanceRedirectForPath("/waiver")).toEqual({
      path: SERVICE_NOTICE_PATH,
      product: "waiver",
    });
    // …and removing it puts them straight back.
    down("bmi");
    expect(isProductPaused("waiver")).toBe(false);
  });
});

describe("path matching", () => {
  beforeEach(() => down("bmi"));

  it("maps v1 and v2 booking entries, with or without /hp", () => {
    expect(bookingProductForPath("/book/race")).toBe("race");
    expect(bookingProductForPath("/book/race/v2")).toBe("race");
    expect(bookingProductForPath("/book/laser-tag")).toBe("laser-tag");
    expect(bookingProductForPath("/hp/book/laser-tag/v2")).toBe("laser-tag");
    expect(bookingProductForPath("/book/gel-blaster/v2")).toBe("gel-blaster");
    expect(bookingProductForPath("/book/shuffly/v2")).toBe("shuffly");
    expect(bookingProductForPath("/book/race-packs")).toBe("race-pack");
    expect(bookingProductForPath("/book/race-pack/v2")).toBe("race-pack");
    expect(bookingProductForPath("/book/combo/race-bowl-v2/v2")).toBe("race-bowl");
  });

  it("NEVER matches a post-purchase surface — a paid guest keeps their receipt", () => {
    for (const p of [
      "/book/confirmation",
      "/book/race/confirmation",
      "/book/race-packs/confirmation",
      "/book/laser-tag/confirmation",
      "/hp/book/bowling/checkin",
    ]) {
      expect(bookingProductForPath(p)).toBeNull();
    }
  });

  it("leaves working products and non-booking paths alone", () => {
    expect(maintenanceRedirectForPath("/book/bowling/v2")).toBeNull();
    expect(maintenanceRedirectForPath("/book/kbf/v2")).toBeNull();
    expect(maintenanceRedirectForPath("/book/duck-pin/v2")).toBeNull();
    expect(maintenanceRedirectForPath("/book/v2")).toBeNull(); // landing shows locked tiles
    expect(maintenanceRedirectForPath("/reload")).toBeNull();
  });

  it("maps the waiver flow but does NOT swallow /waiver-3, the legal page", () => {
    expect(bookingProductForPath("/waiver")).toBe("waiver");
    expect(bookingProductForPath("/waiver/")).toBe("waiver");
    expect(bookingProductForPath("/waiver/anything")).toBe("waiver");
    expect(bookingProductForPath("/waiver-3")).toBeNull();
    expect(maintenanceRedirectForPath("/waiver-3")).toBeNull();
  });

  it("keeps the notice path off the /book prefix, which bypasses the /hp rewrite", () => {
    expect(SERVICE_NOTICE_PATH.startsWith("/book")).toBe(false);
  });
});
