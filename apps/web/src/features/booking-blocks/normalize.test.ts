import { describe, expect, it } from "vitest";
import {
  normalizeCenter,
  normalizeEmail,
  normalizeOpaque,
  normalizePersonId,
  normalizePhone,
  normalizeValue,
} from "./normalize";

/**
 * Fixtures are the REAL values from the 2026-08-24 dispute batch, in the exact
 * messy shapes our own systems store them in — not tidied-up examples. The whole
 * point of normalization is that these three shapes of one phone number collapse
 * to one key:
 *   guest_phone      "2398512480"      (bare digits, Neon)
 *   Square customer  "+12398512480"    (E.164)
 *   POV notify log   "+1 239-851-2480" (formatted)
 */
describe("normalizePhone", () => {
  it("collapses every shape our systems store for one number", () => {
    const want = "2398512480";
    expect(normalizePhone("2398512480")).toBe(want);
    expect(normalizePhone("+12398512480")).toBe(want);
    expect(normalizePhone("+1 239-851-2480")).toBe(want);
    expect(normalizePhone("(239) 851-2480")).toBe(want);
    expect(normalizePhone(" 1-239-851-2480 ")).toBe(want);
  });

  it("keeps the two disputing phones distinct", () => {
    expect(normalizePhone("+12399899306")).toBe("2399899306");
    expect(normalizePhone("+12398512480")).toBe("2398512480");
    expect(normalizePhone("+12399899306")).not.toBe(normalizePhone("+12398512480"));
  });

  it("rejects anything too short to be a real number", () => {
    // A 4-digit value would match a huge number of unrelated guests.
    expect(normalizePhone("2480")).toBeNull();
    expect(normalizePhone("851-2480")).toBeNull();
    expect(normalizePhone("")).toBeNull();
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone("   ")).toBeNull();
  });

  it("takes the last 10 digits so a country prefix cannot split one guest", () => {
    expect(normalizePhone("001-239-851-2480")).toBe("2398512480");
  });
});

describe("normalizeEmail", () => {
  it("case-folds and trims the Apple private-relay addresses from this case", () => {
    expect(normalizeEmail(" Tactics-Spaces1s@iCloud.com ")).toBe("tactics-spaces1s@icloud.com");
    expect(normalizeEmail("MistaGetFee@icloud.com")).toBe("mistagetfee@icloud.com");
    expect(normalizeEmail("AllenValmyr30@gmail.com")).toBe("allenvalmyr30@gmail.com");
  });

  it("does NOT strip gmail dots or +tags", () => {
    // These are genuinely different addresses to Square and to our mailer, and
    // over-normalizing would block unrelated people who merely look similar.
    expect(normalizeEmail("s.jorvelus@gmail.com")).toBe("s.jorvelus@gmail.com");
    expect(normalizeEmail("sjorvelus+race@gmail.com")).toBe("sjorvelus+race@gmail.com");
    expect(normalizeEmail("s.jorvelus@gmail.com")).not.toBe(normalizeEmail("sjorvelus@gmail.com"));
  });

  it("rejects non-addresses", () => {
    expect(normalizeEmail("not-an-email")).toBeNull();
    expect(normalizeEmail("")).toBeNull();
    expect(normalizeEmail(null)).toBeNull();
  });
});

describe("normalizePersonId", () => {
  it("keeps long ids as strings — never Number()", () => {
    // 17 digits: exceeds Number.MAX_SAFE_INTEGER. Must survive verbatim.
    const big = "63000000007735866";
    expect(normalizePersonId(big)).toBe(big);
    expect(normalizePersonId(big)).toHaveLength(17);
    // The FastTrax racer ids from this case.
    expect(normalizePersonId("57362761")).toBe("57362761");
    expect(normalizePersonId(" 57363230 ")).toBe("57363230");
  });

  it("rejects non-numeric ids", () => {
    expect(normalizePersonId("57362761x")).toBeNull();
    expect(normalizePersonId("W58974")).toBeNull();
    expect(normalizePersonId("")).toBeNull();
  });
});

describe("normalizeOpaque", () => {
  it("preserves case on Square ids and card fingerprints", () => {
    const cust = "XRDGWN5W9H21DCYHKCS9VC9W08";
    expect(normalizeOpaque(` ${cust} `)).toBe(cust);
    const fp = "sq-1-6ysCJ3tiDBOtsL-bBIiTG_FzDd3uBCeMhpzZukEbcuzyNygYBVcVi4nMHHsroCuT-w";
    expect(normalizeOpaque(fp)).toBe(fp);
    // Case-folding would break fingerprint matching entirely.
    expect(normalizeOpaque(fp)).not.toBe(fp.toLowerCase());
  });

  it("rejects empty", () => {
    expect(normalizeOpaque("  ")).toBeNull();
    expect(normalizeOpaque(null)).toBeNull();
  });
});

describe("normalizeCenter", () => {
  it("case-folds so capitalisation cannot defeat a match", () => {
    expect(normalizeCenter("Fort-Myers")).toBe("fort-myers");
    expect(normalizeCenter(null)).toBeNull();
    expect(normalizeCenter("   ")).toBeNull();
  });

  it("collapses the Office client key and the Neon center code to ONE token", () => {
    // This is the bug this map exists to prevent: bmi_person block rows are
    // written with the Office key, but the reserve path passes the Neon code. If
    // these did not collapse, the racer block would silently never fire and the
    // list would look configured while doing nothing.
    expect(normalizeCenter("headpinzftmyers")).toBe("fort-myers");
    expect(normalizeCenter("HeadPinzFtMyers")).toBe("fort-myers");
    expect(normalizeCenter("fortmyers")).toBe("fort-myers");
    expect(normalizeCenter("fasttrax")).toBe("fort-myers");
    expect(normalizeCenter("headpinzftmyers")).toBe(normalizeCenter("fort-myers"));

    expect(normalizeCenter("headpinznaples")).toBe("naples");
    expect(normalizeCenter("headpinznaples")).toBe(normalizeCenter("naples"));
  });

  it("keeps the two complexes distinct", () => {
    expect(normalizeCenter("headpinzftmyers")).not.toBe(normalizeCenter("headpinznaples"));
  });

  it("passes an unknown center through instead of dropping it", () => {
    // Dropping it to null would make the row match EVERY center.
    expect(normalizeCenter("some-new-center")).toBe("some-new-center");
  });
});

describe("normalizeValue", () => {
  it("routes each kind to its own rule", () => {
    expect(normalizeValue("email", "A@B.com")).toBe("a@b.com");
    expect(normalizeValue("phone", "+1 239-851-2480")).toBe("2398512480");
    expect(normalizeValue("bmi_person", "57362761")).toBe("57362761");
    expect(normalizeValue("square_customer", "XRDGWN5W9H21DCYHKCS9VC9W08")).toBe(
      "XRDGWN5W9H21DCYHKCS9VC9W08",
    );
    expect(normalizeValue("card_fingerprint", "sq-1-AbC")).toBe("sq-1-AbC");
  });

  it("throws on an unhandled kind rather than silently passing it through", () => {
    // Guards the exhaustive switch: a new BlockKind must be handled, because a
    // silently un-normalized value would never match and the block would be a
    // no-op that looks configured.
    expect(() => normalizeValue("totally_new" as never, "x")).toThrow(/unhandled kind/);
  });
});
