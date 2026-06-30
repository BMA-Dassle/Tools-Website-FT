import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface SqlCall {
  text: string;
  values: unknown[];
}
const calls: SqlCall[] = [];

vi.mock("@/lib/db", () => {
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join("?"), values });
    return Promise.resolve([]);
  };
  return { isDbConfigured: () => true, sql: () => tag };
});

import { recordCustomerComm, redactCardLike } from "./customer-comms";

beforeEach(() => {
  calls.length = 0;
});
afterEach(() => {
  vi.clearAllMocks();
});

describe("redactCardLike", () => {
  it("redacts PAN-like 13-19 digit runs (incl. spaced/hyphenated)", () => {
    expect(redactCardLike("card 4111111111111111 ok")).toBe("card [redacted] ok");
    expect(redactCardLike("4111 1111 1111 1111")).toBe("[redacted]");
    expect(redactCardLike("4111-1111-1111-1111")).toBe("[redacted]");
  });
  it("leaves short numbers (reservation #, phone, last-4) intact", () => {
    expect(redactCardLike("Booking #W42303 for 239-481-9666")).toBe(
      "Booking #W42303 for 239-481-9666",
    );
    expect(redactCardLike("Mastercard ending 6335")).toBe("Mastercard ending 6335");
  });
  it("passes through null", () => {
    expect(redactCardLike(null)).toBeNull();
  });
});

describe("recordCustomerComm", () => {
  const findInsert = () =>
    calls.find((c) => c.text.includes("INSERT INTO customer_communications"));

  it("inserts the comm row with channel + metadata", async () => {
    await recordCustomerComm({
      channel: "email",
      toAddress: "guest@example.com",
      subject: "Booking Confirmed",
      body: "<p>All sales are final</p>",
      policyVersion: "v2-2026-04-30",
      reservationRef: "63000000003928151",
      kind: "booking-confirmation",
      provider: "sendgrid",
      status: "sent",
    });
    const ins = findInsert();
    expect(ins).toBeDefined();
    expect(ins!.values).toContain("email");
    expect(ins!.values).toContain("guest@example.com");
    expect(ins!.values).toContain("v2-2026-04-30");
    expect(ins!.values).toContain("63000000003928151");
    expect(ins!.values).toContain("booking-confirmation");
    expect(ins!.values).toContain("sent");
  });

  it("redacts any card-like digits in subject/body before insert", async () => {
    await recordCustomerComm({
      channel: "email",
      subject: "Receipt 4111111111111111",
      body: "Charged card 4111 1111 1111 1111 today",
    });
    const ins = findInsert();
    const joined = ins!.values.join(" | ");
    expect(joined).not.toContain("4111111111111111");
    expect(joined).not.toContain("4111 1111 1111 1111");
    expect(joined).toContain("[redacted]");
  });
});
