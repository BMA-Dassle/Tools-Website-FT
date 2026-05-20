import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installSquareMock, type SquareMockHandle } from "~/test/mocks/square";
import { aSquareCustomer } from "~/test/builders/survey";
import { normalizePhoneE164, resolveAudienceMember, splitGuestName } from "./audience";

describe("splitGuestName", () => {
  it("splits a simple two-token name", () => {
    expect(splitGuestName("Ada Lovelace")).toEqual({
      firstName: "Ada",
      lastName: "Lovelace",
    });
  });

  it("treats a single token as firstName only", () => {
    expect(splitGuestName("Madonna")).toEqual({ firstName: "Madonna", lastName: "" });
  });

  it("joins everything after the first token as lastName", () => {
    expect(splitGuestName("Mary Jane Watson")).toEqual({
      firstName: "Mary",
      lastName: "Jane Watson",
    });
  });

  it("collapses multiple internal spaces", () => {
    expect(splitGuestName("Ada    Lovelace")).toEqual({
      firstName: "Ada",
      lastName: "Lovelace",
    });
  });

  it("trims leading/trailing whitespace", () => {
    expect(splitGuestName("  Ada Lovelace  ")).toEqual({
      firstName: "Ada",
      lastName: "Lovelace",
    });
  });

  it("returns empty strings for empty/whitespace input", () => {
    expect(splitGuestName("")).toEqual({ firstName: "", lastName: "" });
    expect(splitGuestName("   ")).toEqual({ firstName: "", lastName: "" });
  });
});

describe("normalizePhoneE164", () => {
  it("prefixes 10-digit US numbers with +1", () => {
    expect(normalizePhoneE164("5551234567")).toBe("+15551234567");
  });

  it("handles formatted US 10-digit", () => {
    expect(normalizePhoneE164("(555) 123-4567")).toBe("+15551234567");
  });

  it("handles 11-digit starting with 1", () => {
    expect(normalizePhoneE164("15551234567")).toBe("+15551234567");
  });

  it("preserves an existing + prefix", () => {
    expect(normalizePhoneE164("+15551234567")).toBe("+15551234567");
    expect(normalizePhoneE164("+447911123456")).toBe("+447911123456");
  });

  it("throws on empty input", () => {
    expect(() => normalizePhoneE164("")).toThrow();
  });

  it("throws when no digits remain", () => {
    expect(() => normalizePhoneE164("abc")).toThrow();
  });
});

describe("resolveAudienceMember", () => {
  let sq: SquareMockHandle;

  beforeEach(() => {
    process.env.SQUARE_ACCESS_TOKEN = "test-token";
    sq = installSquareMock();
  });

  afterEach(() => {
    sq.reset();
    vi.restoreAllMocks();
  });

  it("prefers the loyalty-linked customer over a plain phone match", async () => {
    // Two customers share the phone: a plain record (CUS_PLAIN) and a
    // Rewards-enrolled one (CUS_REWARDS). The loyalty search runs first
    // and returns CUS_REWARDS — resolveAudienceMember must use that one
    // and NOT fall through to /customers/search.
    sq.onLoyaltyAccountsSearch().reply({
      loyalty_accounts: [{ id: "loy_1", customer_id: "CUS_REWARDS" }],
    });
    sq.onCustomerGet("CUS_REWARDS").reply({
      customer: aSquareCustomer({
        id: "CUS_REWARDS",
        given_name: "Ada",
        family_name: "Lovelace",
        email_address: "ada@example.com",
        phone_number: "+15551234567",
      }),
    });

    const result = await resolveAudienceMember({ phone: "5551234567" });

    expect(result.squareCustomerId).toBe("CUS_REWARDS");
    expect(result.isNew).toBe(false);

    // /customers/search must NOT have been called — loyalty took the win.
    const phoneSearchCalls = sq
      .allCalls()
      .filter((c) => c.method === "POST" && c.url.endsWith("/customers/search"));
    expect(phoneSearchCalls).toHaveLength(0);
  });

  it("falls back to /customers/search when no loyalty account matches", async () => {
    sq.onLoyaltyAccountsSearch().reply({ loyalty_accounts: [] });
    sq.onCustomerSearch().reply({
      customers: [aSquareCustomer({ id: "CUS_PLAIN", phone_number: "+15551234567" })],
    });

    const result = await resolveAudienceMember({ phone: "5551234567" });

    expect(result.squareCustomerId).toBe("CUS_PLAIN");
  });

  it("returns an existing customer on phone match without creating", async () => {
    const existing = aSquareCustomer({
      id: "CUS_HIT",
      given_name: "Ada",
      family_name: "Lovelace",
      email_address: "ada@example.com",
      phone_number: "+15551234567",
    });
    sq.onCustomerSearch().reply({ customers: [existing] });

    const result = await resolveAudienceMember({
      phone: "5551234567",
      firstName: "Ada",
      lastName: "Lovelace",
    });

    expect(result.squareCustomerId).toBe("CUS_HIT");
    expect(result.isNew).toBe(false);
    expect(result.phoneE164).toBe("+15551234567");

    const createCalls = sq
      .allCalls()
      .filter((c) => c.method === "POST" && c.url.endsWith("/customers"));
    expect(createCalls).toHaveLength(0);
  });

  it("creates a customer when phone lookup misses and no name was supplied", async () => {
    sq.onCustomerSearch().reply({ customers: [] });
    sq.onCustomerCreate().reply({ customer: aSquareCustomer({ id: "CUS_NEW" }) });

    const result = await resolveAudienceMember({ phone: "5551234567" });

    expect(result.isNew).toBe(true);
    expect(result.squareCustomerId).toBe("CUS_NEW");
  });

  it("falls back to name search before creating", async () => {
    sq.onCustomerSearch()
      .reply({ customers: [] }) // first search (phone) → miss
      .reply({ customers: [aSquareCustomer({ id: "CUS_BY_NAME" })] }); // second search (name) → hit

    const result = await resolveAudienceMember({
      phone: "5551234567",
      firstName: "Ada",
      lastName: "Lovelace",
    });

    expect(result.isNew).toBe(false);
    expect(result.squareCustomerId).toBe("CUS_BY_NAME");
  });

  it("creates when both phone and name searches miss", async () => {
    sq.onCustomerSearch()
      .reply({ customers: [] }) // phone
      .reply({ customers: [] }); // name
    sq.onCustomerCreate().reply({
      customer: aSquareCustomer({ id: "CUS_CREATED", given_name: "Ada" }),
    });

    const result = await resolveAudienceMember({
      phone: "5551234567",
      firstName: "Ada",
      lastName: "Lovelace",
    });

    expect(result.isNew).toBe(true);
    expect(result.squareCustomerId).toBe("CUS_CREATED");

    // Verify create body carried the supplied fields.
    const createCalls = sq
      .allCalls()
      .filter((c) => c.method === "POST" && c.url.endsWith("/customers"));
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0].body).toMatchObject({
      given_name: "Ada",
      family_name: "Lovelace",
      phone_number: "+15551234567",
    });
    expect((createCalls[0].body as { idempotency_key: string }).idempotency_key).toMatch(
      /^audience-15551234567-\d{4}-\d{2}-\d{2}$/,
    );
  });

  it("PATCHes missing name/email on an existing customer", async () => {
    const existing = aSquareCustomer({
      id: "CUS_PARTIAL",
      phone_number: "+15551234567",
      // no name, no email
    });
    sq.onCustomerSearch().reply({ customers: [existing] });
    const patch = sq.onCustomerPatch("CUS_PARTIAL").replyEmpty();

    await resolveAudienceMember({
      phone: "5551234567",
      firstName: "Ada",
      lastName: "Lovelace",
      email: "ada@example.com",
    });

    expect(patch.calls()).toHaveLength(1);
    expect(patch.calls()[0].body).toMatchObject({
      given_name: "Ada",
      family_name: "Lovelace",
      email_address: "ada@example.com",
    });
  });

  it("does NOT PATCH when all fields already present on Square", async () => {
    const existing = aSquareCustomer({
      id: "CUS_FULL",
      given_name: "Ada",
      family_name: "Lovelace",
      email_address: "ada@example.com",
      phone_number: "+15551234567",
    });
    sq.onCustomerSearch().reply({ customers: [existing] });
    const patch = sq.onCustomerPatch("CUS_FULL").replyEmpty();

    await resolveAudienceMember({
      phone: "5551234567",
      firstName: "Ada",
      lastName: "Lovelace",
      email: "ada@example.com",
    });

    expect(patch.calls()).toHaveLength(0);
  });

  it("throws on Square search failure", async () => {
    sq.onCustomerSearch().replyError(500, { error: "internal" });
    await expect(resolveAudienceMember({ phone: "5551234567" })).rejects.toThrow(/search/i);
  });

  it("throws on Square create failure", async () => {
    sq.onCustomerSearch().reply({ customers: [] });
    sq.onCustomerCreate().replyError(400, { error: "bad request" });
    await expect(resolveAudienceMember({ phone: "5551234567" })).rejects.toThrow(/create/i);
  });
});
