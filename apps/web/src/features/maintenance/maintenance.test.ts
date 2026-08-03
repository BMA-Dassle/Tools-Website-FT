import { afterEach, describe, expect, it } from "vitest";
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

/** The registry ships with the BMI outage ON (owner 2026-08-03) and is cleared
 *  with MAINTENANCE_VENDOR_BMI="false". These tests assert both states, so the
 *  day the entry is deleted the "cleared" half keeps passing and the "declared"
 *  half fails loudly rather than silently testing nothing. */
const clearBmi = () => {
  process.env.MAINTENANCE_VENDOR_BMI = "false";
};

afterEach(() => {
  delete process.env.MAINTENANCE_VENDOR_BMI;
  delete process.env.MAINTENANCE_VENDOR_BMI_OFFICE;
  delete process.env.MAINTENANCE_VENDORS_DOWN;
  delete process.env.NEXT_PUBLIC_FASTTRAX_QAMF_DUCKPIN;
});

describe("vendor map", () => {
  it("puts the VIP combo on BOTH vendors — either one down takes it off sale", () => {
    expect(vendorsForProduct("race-bowl")).toEqual(["bmi", "qamf"]);
    expect(isProductPaused("race-bowl")).toBe(true); // BMI declared
  });

  it("keeps bowling, KBF and Game Zone off BMI so they survive a BMI outage", () => {
    for (const id of ["bowling", "kbf", "game-zone"]) {
      expect(vendorsForProduct(id)).not.toContain("bmi");
      expect(isProductPaused(id)).toBe(false);
    }
  });

  it("follows duckpin's vendor through the same kill switch the booking flow reads", () => {
    expect(vendorsForProduct("duck-pin")).toEqual(["qamf"]); // default: QAMF 11542
    expect(isProductPaused("duck-pin")).toBe(false);
    process.env.NEXT_PUBLIC_FASTTRAX_QAMF_DUCKPIN = "false"; // revert to legacy BMI page
    expect(vendorsForProduct("duck-pin")).toEqual(["bmi"]);
    expect(isProductPaused("duck-pin")).toBe(true);
  });

  it("fails OPEN for a product it doesn't classify", () => {
    expect(vendorsForProduct("some-future-thing")).toEqual([]);
    expect(isProductPaused("some-future-thing")).toBe(false);
  });
});

describe("outage switch", () => {
  it("is ON by default and cleared by the env var", () => {
    expect(isVendorDown("bmi")).toBe(true);
    clearBmi();
    expect(isVendorDown("bmi")).toBe(false);
    expect(pausedProductIds()).toEqual([]);
  });

  it("pauses exactly the BMI SELLING rail — the 2026-08-03 scope", () => {
    expect(pausedProductIds().sort()).toEqual(
      [
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
});

/**
 * The whole point of splitting "BMI" into two vendors: on 2026-08-03 the booking
 * API was dark while BMI Office stayed up, so check-in kept working and waivers
 * (signed through Pandora, which was also healthy) did too. Blocking them would
 * have sent guests to the desk for no reason; blocking contracts would have
 * stopped us collecting group balances we could still collect. These tests pin
 * that scope so a future edit can't quietly widen the blast radius.
 */
describe("surfaces that must STAY UP through a booking-API outage", () => {
  // Owner 2026-08-03: "dont do anything with eticket or check in. its working."
  // They are not classified at all, so this feature cannot reach them — an
  // unclassified id fails open. Pinned so nobody "completes" the map later.
  it("cannot touch check-in or e-tickets — they are out of scope by construction", () => {
    for (const id of ["checkin", "eticket"]) {
      expect(vendorsForProduct(id)).toEqual([]);
      expect(isProductPaused(id)).toBe(false);
    }
    // …and no URL for them maps to a gated product.
    for (const p of ["/kiosk/checkin", "/t/abc123", "/g/abc123", "/book/bowling/checkin"]) {
      expect(maintenanceRedirectForPath(p)).toBeNull();
    }
  });

  it("keeps waivers up — lookup is Office, signing is Pandora", () => {
    expect(vendorsForProduct("waiver")).toEqual(["bmi-office"]);
    expect(isProductPaused("waiver")).toBe(false);
    expect(maintenanceRedirectForPath("/waiver")).toBeNull();
  });

  it("keeps group-event contracts up — Neon + Square + Blob, notes fall back to DB", () => {
    expect(vendorsForProduct("contract")).toEqual(["pandora"]);
    expect(isVendorDown("pandora")).toBe(false);
    expect(isProductPaused("contract")).toBe(false);
  });
});

describe("the waiver guard is ARMED for an Office outage", () => {
  // Office went down 01:46–06:15 the same morning, so this is a real recurrence
  // path, not a hypothetical: one env var must take waivers down, with no
  // deploy and without touching check-in or e-tickets.
  const officeDown = () => {
    process.env.MAINTENANCE_VENDORS_DOWN = "bmi-office";
  };

  it("takes waivers down", () => {
    officeDown();
    expect(isVendorDown("bmi-office")).toBe(true);
    expect(isProductPaused("waiver")).toBe(true);
    expect(maintenanceRedirectForPath("/waiver")).toEqual({
      path: SERVICE_NOTICE_PATH,
      product: "waiver",
    });
  });

  it("still cannot reach check-in or e-tickets", () => {
    officeDown();
    expect(isProductPaused("checkin")).toBe(false);
    expect(maintenanceRedirectForPath("/kiosk/checkin")).toBeNull();
    expect(maintenanceRedirectForPath("/t/abc123")).toBeNull();
  });

  it("leaves the working vendors alone", () => {
    officeDown();
    expect(isProductPaused("bowling")).toBe(false);
    expect(isProductPaused("contract")).toBe(false);
  });

  it("ignores junk in the ad-hoc list", () => {
    process.env.MAINTENANCE_VENDORS_DOWN = "not-a-vendor, ,bmi-office";
    expect(isVendorDown("bmi-office")).toBe(true);
    expect(activeOutages().every((o) => o.vendor === "bmi" || o.vendor === "bmi-office")).toBe(true);
  });

  it("gives an ad-hoc outage real guest copy, not an empty shell", () => {
    officeDown();
    const o = activeOutages().find((x) => x.vendor === "bmi-office");
    expect(o?.web.heading).toBeTruthy();
    expect(o?.web.body).toContain("outage");
    expect(o?.kiosk.es).toContain("Servicio al Cliente");
  });
});

describe("waiver path matching", () => {
  it("maps the unified waiver flow and its sub-paths", () => {
    expect(bookingProductForPath("/waiver")).toBe("waiver");
    expect(bookingProductForPath("/waiver/")).toBe("waiver");
    expect(bookingProductForPath("/waiver/anything")).toBe("waiver");
  });

  it("does NOT swallow /waiver-3, the static legal page", () => {
    // A bare startsWith("/waiver") would take this down too — it has nothing to
    // do with signing and must stay up.
    expect(bookingProductForPath("/waiver-3")).toBeNull();
    expect(maintenanceRedirectForPath("/waiver-3")).toBeNull();
  });
});

describe("bookingProductForPath", () => {
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

  it("redirects a paused entry to the notice with the product attached", () => {
    expect(maintenanceRedirectForPath("/book/race/v2")).toEqual({
      path: SERVICE_NOTICE_PATH,
      product: "race",
    });
    clearBmi();
    expect(maintenanceRedirectForPath("/book/race/v2")).toBeNull();
  });

  it("keeps the notice path off the /book prefix, which bypasses the /hp rewrite", () => {
    expect(SERVICE_NOTICE_PATH.startsWith("/book")).toBe(false);
  });
});

describe("bmiWriteBlocked", () => {
  it("refuses only the writes that OPEN a sale", () => {
    expect(bmiWriteBlocked("booking/book")).toBe(true);
    expect(bmiWriteBlocked("booking/sell")).toBe(true);
  });

  it("lets an already-charged session finish and abandoned holds be released", () => {
    // Blocking these is how you strand a hold on a heat or orphan a charge.
    for (const e of ["payment/confirm", "booking/removeItem", "booking/memo", "availability"]) {
      expect(bmiWriteBlocked(e)).toBe(false);
    }
  });

  it("stops blocking the moment the outage is cleared", () => {
    clearBmi();
    expect(bmiWriteBlocked("booking/book")).toBe(false);
  });
});
