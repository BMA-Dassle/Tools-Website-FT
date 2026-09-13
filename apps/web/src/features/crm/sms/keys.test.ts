import { describe, expect, it } from "vitest";
import { contactKey, e164FromDigits, parseConversationKey, phoneDigits, phoneKey } from "./keys";

/**
 * The conversation key is a PATH SEGMENT, so "what shapes exist" and "what a
 * URL may contain" are the same question. Anything else parses to null and the
 * route answers 404 — a key can never become a traversal or a SQL argument.
 */
describe("conversation keys", () => {
  it("round-trips a contact", () => {
    expect(contactKey("9")).toBe("c-9");
    expect(parseConversationKey("c-9")).toEqual({ kind: "contact", contactId: "9" });
  });

  it("round-trips a number", () => {
    expect(phoneKey("+1 (239) 555-1234")).toBe("p-12395551234");
    expect(parseConversationKey("p-12395551234")).toEqual({
      kind: "phone",
      digits: "12395551234",
    });
    expect(e164FromDigits("12395551234")).toBe("+12395551234");
  });

  it("a bare 10-digit US number becomes E.164", () => {
    expect(e164FromDigits("2395551234")).toBe("+12395551234");
  });

  it("only the two shapes parse", () => {
    for (const bad of [
      "",
      "c-",
      "p-123",
      "../../etc/passwd",
      "c-9;drop table crm_leads",
      "x-9",
      "c-9999999999999999999",
    ]) {
      expect(parseConversationKey(bad), bad).toBeNull();
    }
  });

  it("digits are capped at E.164's own 15", () => {
    expect(phoneDigits("+1239555123456789012")).toHaveLength(15);
  });
});
