import { describe, expect, it } from "vitest";
import { ContactInfoSchema } from "./schemas";

describe("ContactInfoSchema.email", () => {
  const base = {
    firstName: "Natalie",
    lastName: "Torres",
    phone: "9414674710",
  };

  it("rejects the 2026-07-28 address that QAMF refused after capture", () => {
    const res = ContactInfoSchema.safeParse({
      ...base,
      email: "natalietorres1732@gmail.com@",
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues[0]?.message).toBe("Enter a valid email address.");
      expect(res.error.issues[0]?.path).toEqual(["email"]);
    }
  });

  it("accepts the address she meant, and trims it", () => {
    const res = ContactInfoSchema.safeParse({
      ...base,
      email: "  natalietorres1732@gmail.com ",
    });
    expect(res.success).toBe(true);
    if (res.success) expect(res.data.email).toBe("natalietorres1732@gmail.com");
  });

  it("is stricter than zod's own .email(), which this field used to use", () => {
    // zod 3's .email() accepts a dotless domain; QAMF-bound addresses must be
    // deliverable, so ours does not. Guard against a future revert to .email().
    expect(ContactInfoSchema.safeParse({ ...base, email: "a@b" }).success).toBe(false);
  });
});
