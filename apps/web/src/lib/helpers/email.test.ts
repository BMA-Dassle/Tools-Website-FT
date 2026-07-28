import { describe, expect, it } from "vitest";
import { emailRejection, isDeliverableEmail } from "./email";

describe("emailRejection", () => {
  it("rejects the exact address that orphaned $346.12 on 2026-07-28", () => {
    // Guest typed her address plus one stray `@` from the iPhone email keyboard.
    // QAMF 400'd on it AFTER capture: Customer.Guest.Email "Value is not a valid
    // Email." Every gate we had said yes, because they all asked includes("@").
    expect(emailRejection("natalietorres1732@gmail.com@")).toBe("not-one-at");
    expect(isDeliverableEmail("natalietorres1732@gmail.com@")).toBe(false);
    // ...and the address she actually meant is accepted.
    expect(isDeliverableEmail("natalietorres1732@gmail.com")).toBe(true);
  });

  it("is not satisfied by a bare @, which the old includes('@') gate was", () => {
    expect("@".includes("@")).toBe(true); // the old gate's verdict
    expect(isDeliverableEmail("@")).toBe(false);
  });

  it("accepts ordinary guest addresses", () => {
    for (const ok of [
      "a@b.co",
      "natalie.torres@gmail.com",
      "natalie+racing@gmail.com",
      "first.last@sub.domain.co.uk",
      "eric@headpinz.com",
      "o'brien@example.com",
      "user_name@example-host.com",
      "UPPER@EXAMPLE.COM",
      "1732@gmail.com",
    ]) {
      expect(isDeliverableEmail(ok), ok).toBe(true);
    }
  });

  it("trims surrounding whitespace before judging", () => {
    expect(isDeliverableEmail("  natalie@gmail.com  ")).toBe(true);
    expect(isDeliverableEmail("   ")).toBe(false);
  });

  it("reports the specific reason for each malformed shape", () => {
    expect(emailRejection("")).toBe("empty");
    expect(emailRejection(null)).toBe("empty");
    expect(emailRejection(undefined)).toBe("empty");
    expect(emailRejection("nogmail.com")).toBe("not-one-at");
    expect(emailRejection("a@@b.com")).toBe("not-one-at");
    expect(emailRejection("@gmail.com")).toBe("not-one-at");
    expect(emailRejection(`${"a".repeat(65)}@b.com`)).toBe("local-too-long");
    expect(emailRejection(`a@${"b".repeat(250)}.com`)).toBe("too-long");
    expect(emailRejection("a@b.c")).toBe("tld-too-short");
  });

  it("rejects the malformed shapes a vendor validator would", () => {
    for (const bad of [
      "a@b", // no dot — not deliverable
      "a b@c.com", // space in local
      "a@c om.com", // space in domain
      ".a@b.com", // leading dot
      "a.@b.com", // trailing dot
      "a..b@c.com", // doubled dot
      "a@-b.com", // label starts with hyphen
      "a@b-.com", // label ends with hyphen
      "a@b..com", // empty label
      "a@.com", // empty first label
      "a@b.com.", // trailing dot on domain
      "natalie\n@gmail.com", // embedded newline
    ]) {
      expect(isDeliverableEmail(bad), bad).toBe(false);
    }
  });
});
