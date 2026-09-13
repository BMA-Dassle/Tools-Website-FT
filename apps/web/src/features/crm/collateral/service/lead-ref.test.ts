import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The share → lead seam, which is now one call into the leads sub.
 *
 * What is worth pinning here is not SQL — B3 owns that statement and tests it
 * — but the two things a share depends on:
 *
 *   both id forms reach the reader   a deal drawer holds `4211`, a URL holds
 *                                    `L-1042`, and a share can be minted from
 *                                    either;
 *   an unknown lead is NULL          `crm_activities.lead_id` is a foreign
 *                                    key, so an invented id would turn a share
 *                                    into a constraint error instead of a
 *                                    timeline row.
 *
 * The label is the sheet's only cosmetic: a business name when there is one,
 * otherwise the guest, otherwise just the public id — never an empty "L-1042 ·".
 */

const bag = vi.hoisted(() => ({
  asked: [] as string[],
  lead: null as unknown,
}));

vi.mock("~/features/crm/leads", () => ({
  getLead: async (idOrPublic: string) => {
    bag.asked.push(idOrPublic);
    return bag.lead;
  },
}));

const { findShareLead } = await import("./lead-ref");

function lead(over: Record<string, unknown> = {}) {
  return {
    id: "4211",
    publicId: "L-1042",
    guest: { first: "Dana", last: "Reed", phone: null, email: null, company: null, prefers: null },
    ...over,
  };
}

beforeEach(() => {
  bag.asked = [];
  bag.lead = null;
});

describe("findShareLead", () => {
  it("passes a public id straight through to the leads reader", async () => {
    bag.lead = lead();
    await expect(findShareLead("L-1042")).resolves.toEqual({
      id: "4211",
      publicId: "L-1042",
      label: "L-1042 · Dana Reed",
    });
    expect(bag.asked).toEqual(["L-1042"]);
  });

  it("takes the numeric row id a deal drawer holds, trimmed", async () => {
    bag.lead = lead();
    await findShareLead("  4211 ");
    expect(bag.asked).toEqual(["4211"]);
  });

  it("prefers the business name for the label", async () => {
    bag.lead = lead({
      guest: { first: "Dana", last: "Reed", phone: null, email: null, company: "Lee Health" },
    });
    await expect(findShareLead("L-1042")).resolves.toMatchObject({
      label: "L-1042 · Lee Health",
    });
  });

  it("never prints a trailing separator when there is no name at all", async () => {
    bag.lead = lead({ guest: { first: "", last: "", phone: null, email: null, company: "  " } });
    await expect(findShareLead("L-1042")).resolves.toMatchObject({ label: "L-1042" });
  });

  it("answers null for a lead that is not there, and never invents an id", async () => {
    bag.lead = null;
    await expect(findShareLead("L-9999")).resolves.toBeNull();
  });

  it("does not even ask for an empty input", async () => {
    await expect(findShareLead("   ")).resolves.toBeNull();
    await expect(findShareLead(null)).resolves.toBeNull();
    expect(bag.asked).toEqual([]);
  });
});
