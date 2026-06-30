import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { buildVerificationDetails } from "./square-verification-details";

describe("buildVerificationDetails", () => {
  it("builds CHARGE details with amount + currency + flags", () => {
    const d = buildVerificationDetails({
      intent: "CHARGE",
      amountDollars: 43.99,
      contact: { firstName: "Frank", lastName: "Norberto", email: "f@x.com", phone: "239" },
    });
    expect(d.intent).toBe("CHARGE");
    expect(d.amount).toBe("43.99");
    expect(d.currencyCode).toBe("USD");
    expect(d.customerInitiated).toBe(true);
    expect(d.sellerKeyedIn).toBe(false);
    expect(d.billingContact).toEqual({
      givenName: "Frank",
      familyName: "Norberto",
      email: "f@x.com",
      phone: "239",
    });
  });

  it("formats amount to 2 decimals and floors negatives to 0.00", () => {
    expect(buildVerificationDetails({ intent: "CHARGE", amountDollars: 5 }).amount).toBe("5.00");
    expect(buildVerificationDetails({ intent: "CHARGE", amountDollars: -3 }).amount).toBe("0.00");
    expect(buildVerificationDetails({ intent: "CHARGE" }).amount).toBe("0.00");
  });

  it("omits amount for STORE intent", () => {
    const d = buildVerificationDetails({ intent: "STORE" });
    expect(d.intent).toBe("STORE");
    expect(d.amount).toBeUndefined();
    expect(d.billingContact).toEqual({});
  });

  it("omits empty contact fields from billingContact", () => {
    const d = buildVerificationDetails({ intent: "STORE", contact: { firstName: "A", email: "" } });
    expect(d.billingContact).toEqual({ givenName: "A" });
  });
});

describe("3DS regression — deprecated verifyBuyer must not be reintroduced", () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === ".next" || name === ".turbo") continue;
      const p = join(dir, name);
      const s = statSync(p);
      if (s.isDirectory()) walk(p, out);
      else if (/\.(ts|tsx)$/.test(name) && !name.endsWith(".test.ts")) out.push(p);
    }
    return out;
  }

  it("no source file calls payments.verifyBuyer(", () => {
    const root = join(__dirname, "..");
    const offenders = walk(root).filter((f) => /\.verifyBuyer\s*\(/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});
