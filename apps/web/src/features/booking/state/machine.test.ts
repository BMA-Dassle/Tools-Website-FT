import { describe, expect, it } from "vitest";
import { reducer } from "./machine";
import {
  emptySession,
  newItem,
  newPartyMember,
  type BookingSession,
  type KbfItem,
  type PartyMember,
  type RaceHeatAssignment,
  type RaceItem,
  type AttractionItem,
  type BowlingItem,
} from "./types";

function seedSession(): BookingSession {
  return emptySession({ entryBrand: "fasttrax" });
}

function makeMember(args: Partial<PartyMember> = {}): PartyMember {
  return newPartyMember({
    firstName: args.firstName ?? "Alex",
    lastName: args.lastName,
    bmiPersonId: args.bmiPersonId,
    isNewRacer: args.isNewRacer ?? true,
    category: args.category,
    isBillingCustomer: args.isBillingCustomer,
  });
}

const heat = (overrides: Partial<RaceHeatAssignment> = {}): RaceHeatAssignment => ({
  productId: "24960859",
  track: "Red",
  heatId: null,
  bmiLineId: null,
  assignedTo: null,
  ...overrides,
});

describe("reducer — cart items", () => {
  it("addItem appends to items, makes it active, seeds cursor", () => {
    const s0 = seedSession();
    const race = newItem("race");
    const s1 = reducer(s0, { type: "addItem", item: race });
    expect(s1.items).toHaveLength(1);
    expect(s1.activeItemId).toBe(race.id);
    expect(s1.cursors[race.id]).toBe(0);
  });

  it("updateItem shallow-merges a patch into the matching item", () => {
    const s0 = seedSession();
    const attraction = newItem("attraction");
    const s1 = reducer(s0, { type: "addItem", item: attraction });
    const s2 = reducer(s1, {
      type: "updateItem",
      id: attraction.id,
      patch: { slug: "gel-blaster", qty: 4 } as Partial<typeof attraction>,
    });
    expect(s2.items[0]).toMatchObject({ slug: "gel-blaster", qty: 4 });
  });

  it("addItem allows mixed carts (bowling + race)", () => {
    const s0 = seedSession();
    const race = newItem("race");
    const s1 = reducer(s0, { type: "addItem", item: race });
    const bowling = newItem("bowling");
    const s2 = reducer(s1, { type: "addItem", item: bowling });
    expect(s2.items).toHaveLength(2);
    expect(s2.items.map((i) => i.kind).sort()).toEqual(["bowling", "race"]);
  });

  it("removeItem drops the item, drops the cursor, clears activeItemId if matched", () => {
    const s0 = seedSession();
    const race = newItem("race");
    const s1 = reducer(s0, { type: "addItem", item: race });
    const s2 = reducer(s1, { type: "removeItem", id: race.id });
    expect(s2.items).toHaveLength(0);
    expect(s2.cursors[race.id]).toBeUndefined();
    expect(s2.activeItemId).toBeNull();
  });
});

describe("reducer — step cursor", () => {
  it("next / back / goto only affect the active item's cursor", () => {
    const s0 = seedSession();
    const race = newItem("race");
    const s1 = reducer(s0, { type: "addItem", item: race });
    const s2 = reducer(s1, { type: "next" });
    expect(s2.cursors[race.id]).toBe(1);
    const s3 = reducer(s2, { type: "next" });
    expect(s3.cursors[race.id]).toBe(2);
    const s4 = reducer(s3, { type: "back" });
    expect(s4.cursors[race.id]).toBe(1);
    const s5 = reducer(s4, { type: "goto", index: 0 });
    expect(s5.cursors[race.id]).toBe(0);
  });

  it("next / back are no-ops when no item is active", () => {
    const s0 = seedSession();
    expect(reducer(s0, { type: "next" })).toEqual(s0);
    expect(reducer(s0, { type: "back" })).toEqual(s0);
  });
});

describe("reducer — party roster", () => {
  it("addPartyMember appends to party", () => {
    const m = makeMember();
    const s = reducer(seedSession(), { type: "addPartyMember", member: m });
    expect(s.party).toEqual([m]);
  });

  it("updatePartyMember shallow-merges by id", () => {
    const m = makeMember({ firstName: "Alex", isNewRacer: true });
    const s0 = reducer(seedSession(), { type: "addPartyMember", member: m });
    const s1 = reducer(s0, {
      type: "updatePartyMember",
      id: m.id,
      patch: { isNewRacer: false, bmiPersonId: "63000000000021716" },
    });
    expect(s1.party[0].isNewRacer).toBe(false);
    expect(s1.party[0].bmiPersonId).toBe("63000000000021716");
    expect(s1.party[0].firstName).toBe("Alex");
  });

  it("removePartyMember drops the member AND cascade-clears heat assignments", () => {
    const alex = makeMember({ firstName: "Alex" });
    const bob = makeMember({ firstName: "Bob" });
    const race = newItem("race") as RaceItem;
    const initial: BookingSession = {
      ...seedSession(),
      party: [alex, bob],
      items: [
        {
          ...race,
          heats: [
            heat({ assignedTo: alex.id }),
            heat({ assignedTo: bob.id }),
            heat({ assignedTo: alex.id }),
          ],
        },
      ],
    };
    const after = reducer(initial, { type: "removePartyMember", id: alex.id });
    expect(after.party.map((m) => m.id)).toEqual([bob.id]);
    const raceItem = after.items[0] as RaceItem;
    expect(raceItem.heats.map((h) => h.assignedTo)).toEqual([null, bob.id, null]);
  });

  it("removePartyMember filters attraction/bowling assignedTo[] arrays", () => {
    const alex = makeMember();
    const bob = makeMember({ firstName: "Bob" });
    const attraction = {
      ...newItem("attraction"),
      assignedTo: [alex.id, bob.id],
      slug: "gel-blaster",
      qty: 2,
    };
    const bowling = { ...newItem("bowling"), assignedTo: [alex.id, bob.id] };
    const initial: BookingSession = {
      ...seedSession(),
      party: [alex, bob],
      items: [attraction, bowling],
    };
    const after = reducer(initial, { type: "removePartyMember", id: alex.id });
    const att = after.items.find((i) => i.id === attraction.id);
    const bowl = after.items.find((i) => i.id === bowling.id);
    expect(att?.kind === "attraction" && att.assignedTo).toEqual([bob.id]);
    expect(bowl?.kind === "bowling" && bowl.assignedTo).toEqual([bob.id]);
  });
});

describe("reducer — signer-only guardians (kiosk)", () => {
  it("addGuardian appends to guardians without touching party", () => {
    const g = makeMember({ firstName: "Dana", isNewRacer: false });
    const s = reducer(seedSession(), { type: "addGuardian", member: g });
    expect(s.guardians).toEqual([g]);
    expect(s.party).toEqual([]);
  });

  it("updateGuardian shallow-merges by id", () => {
    const g = makeMember({ firstName: "Dana" });
    const s0 = reducer(seedSession(), { type: "addGuardian", member: g });
    const s1 = reducer(s0, {
      type: "updateGuardian",
      id: g.id,
      patch: { waiverValid: true, pandoraPersonId: "12345" },
    });
    expect(s1.guardians?.[0]).toMatchObject({
      firstName: "Dana",
      waiverValid: true,
      pandoraPersonId: "12345",
    });
  });

  it("removeGuardian drops the entry", () => {
    const g = makeMember({ firstName: "Dana" });
    const s0 = reducer(seedSession(), { type: "addGuardian", member: g });
    const s1 = reducer(s0, { type: "removeGuardian", id: g.id });
    expect(s1.guardians).toEqual([]);
  });

  it("join-the-party move (addPartyMember + removeGuardian) keeps the id a minor references", () => {
    const g = makeMember({ firstName: "Dana", isNewRacer: false });
    const minor = { ...makeMember({ firstName: "Kid" }), isMinor: true, guardianMemberId: g.id };
    const s0: BookingSession = { ...seedSession(), party: [minor], guardians: [g] };
    const s1 = reducer(s0, { type: "addPartyMember", member: g });
    const s2 = reducer(s1, { type: "removeGuardian", id: g.id });
    expect(s2.guardians).toEqual([]);
    expect(s2.party.map((m) => m.id)).toContain(minor.guardianMemberId);
  });
});

describe("reducer — race heat assignments", () => {
  it("addHeat appends to a RaceItem's heats[]", () => {
    const race = newItem("race");
    const s0 = reducer(seedSession(), { type: "addItem", item: race });
    const s1 = reducer(s0, {
      type: "addHeat",
      itemId: race.id,
      heat: heat({ track: "Red" }),
    });
    expect((s1.items[0] as RaceItem).heats).toHaveLength(1);
  });

  it("updateHeat patches a single heat by index", () => {
    const race = newItem("race");
    const s0 = reducer(seedSession(), { type: "addItem", item: race });
    const s1 = reducer(s0, { type: "addHeat", itemId: race.id, heat: heat() });
    const s2 = reducer(s1, { type: "addHeat", itemId: race.id, heat: heat() });
    const s3 = reducer(s2, {
      type: "updateHeat",
      itemId: race.id,
      heatIndex: 1,
      patch: { heatId: "h-99", assignedTo: "racer-A" },
    });
    const heats = (s3.items[0] as RaceItem).heats;
    expect(heats[0].heatId).toBeNull();
    expect(heats[1].heatId).toBe("h-99");
    expect(heats[1].assignedTo).toBe("racer-A");
  });

  it("removeHeat drops a heat by index", () => {
    const race = newItem("race");
    const s0 = reducer(seedSession(), { type: "addItem", item: race });
    const s1 = reducer(s0, { type: "addHeat", itemId: race.id, heat: heat({ heatId: "a" }) });
    const s2 = reducer(s1, { type: "addHeat", itemId: race.id, heat: heat({ heatId: "b" }) });
    const s3 = reducer(s2, { type: "addHeat", itemId: race.id, heat: heat({ heatId: "c" }) });
    const s4 = reducer(s3, { type: "removeHeat", itemId: race.id, heatIndex: 1 });
    expect((s4.items[0] as RaceItem).heats.map((h) => h.heatId)).toEqual(["a", "c"]);
  });

  it("addHeat is a no-op on non-race items", () => {
    const attraction = newItem("attraction");
    const s0 = reducer(seedSession(), { type: "addItem", item: attraction });
    const s1 = reducer(s0, { type: "addHeat", itemId: attraction.id, heat: heat() });
    expect(s1.items[0]).toEqual(attraction);
  });
});

describe("reducer — session-wide", () => {
  it("setContact shallow-merges contact fields including smsOptIn", () => {
    const s0 = seedSession();
    const s1 = reducer(s0, { type: "setContact", patch: { firstName: "Alex" } });
    const s2 = reducer(s1, { type: "setContact", patch: { email: "a@b.co", smsOptIn: true } });
    expect(s2.contact).toEqual({ firstName: "Alex", email: "a@b.co", smsOptIn: true });
  });

  it("setBmiBillId stashes the combined BMI bill anchor", () => {
    const s = reducer(seedSession(), { type: "setBmiBillId", id: "63000000000021716" });
    expect(s.bmiBillId).toBe("63000000000021716");
  });

  it("applyPromo captures a session-level promo and can clear it", () => {
    const s0 = seedSession();
    expect(s0.appliedPromo).toBeNull();
    const promo = {
      code: "MAY20",
      domains: ["racing"] as const,
      scopes: { racing: { productSlugs: null } },
      startsAt: "2026-05-01T00:00:00Z",
      expiresAt: "2026-06-01T00:00:00Z",
      allowedWeekdays: null,
      bookingDateStart: null,
      bookingDateEnd: null,
      mechanic: "percent" as const,
      amountPct: 20,
      amountCents: null,
      squareCatalogId: "SQ_DISC_1",
    };
    const s1 = reducer(s0, {
      type: "applyPromo",
      promo: {
        ...promo,
        domains: [...promo.domains],
      },
    });
    expect(s1.appliedPromo?.code).toBe("MAY20");
    const s2 = reducer(s1, { type: "applyPromo", promo: null });
    expect(s2.appliedPromo).toBeNull();
  });

  it("setCenter to the SAME center is a no-op (no cart clear)", () => {
    const race = newItem("race");
    const s0 = reducer(seedSession(), { type: "setCenter", center: "fort-myers" });
    const s1 = reducer(s0, { type: "addItem", item: race });
    const s2 = reducer(s1, { type: "setCenter", center: "fort-myers" });
    expect(s2.items).toHaveLength(1);
  });

  it("setCenter to a DIFFERENT center clears items[]", () => {
    const race = newItem("race");
    const s0 = reducer(seedSession(), { type: "setCenter", center: "fort-myers" });
    const s1 = reducer(s0, { type: "addItem", item: race });
    const s2 = reducer(s1, { type: "setCenter", center: "naples" });
    expect(s2.items).toHaveLength(0);
    expect(s2.center).toBe("naples");
  });
});

describe("reducer — KBF identity (conditional)", () => {
  it("adding a KbfItem auto-initializes session.kbfIdentity", () => {
    const kbf = newItem("kbf");
    const s = reducer(seedSession(), { type: "addItem", item: kbf });
    expect(s.kbfIdentity).toEqual({ phase: "lookup", emailOrPhone: "", passId: null, members: [] });
  });

  it("adding a SECOND KbfItem does NOT reset the verified identity", () => {
    const kbf1 = newItem("kbf");
    const s0 = reducer(seedSession(), { type: "addItem", item: kbf1 });
    const s1 = reducer(s0, {
      type: "setKbfIdentity",
      patch: { phase: "verified", passId: 42 },
    });
    const kbf2 = newItem("kbf");
    const s2 = reducer(s1, { type: "addItem", item: kbf2 });
    expect(s2.kbfIdentity?.phase).toBe("verified");
    expect(s2.kbfIdentity?.passId).toBe(42);
  });

  it("removing the LAST KbfItem clears session.kbfIdentity", () => {
    const kbf = newItem("kbf") as KbfItem;
    const s0 = reducer(seedSession(), { type: "addItem", item: kbf });
    const s1 = reducer(s0, {
      type: "setKbfIdentity",
      patch: { phase: "verified", passId: 42 },
    });
    expect(s1.kbfIdentity).toBeDefined();
    const s2 = reducer(s1, { type: "removeItem", id: kbf.id });
    expect(s2.kbfIdentity).toBeUndefined();
  });

  it("removing one of TWO KbfItems keeps the identity", () => {
    const kbf1 = newItem("kbf");
    const kbf2 = newItem("kbf");
    const s0 = reducer(seedSession(), { type: "addItem", item: kbf1 });
    const s1 = reducer(s0, { type: "addItem", item: kbf2 });
    const s2 = reducer(s1, {
      type: "setKbfIdentity",
      patch: { phase: "verified", passId: 42 },
    });
    const s3 = reducer(s2, { type: "removeItem", id: kbf1.id });
    expect(s3.kbfIdentity?.passId).toBe(42);
  });

  it("setKbfIdentity merges patches without overwriting unchanged fields", () => {
    const kbf = newItem("kbf");
    const s0 = reducer(seedSession(), { type: "addItem", item: kbf });
    const s1 = reducer(s0, { type: "setKbfIdentity", patch: { emailOrPhone: "alex@x.co" } });
    const s2 = reducer(s1, { type: "setKbfIdentity", patch: { phase: "verify" } });
    expect(s2.kbfIdentity).toEqual({
      phase: "verify",
      emailOrPhone: "alex@x.co",
      passId: null,
      members: [],
    });
  });
});

describe("applyVoucher — native multi-item keying", () => {
  it("keeps two items of ONE native voucher as distinct applied entries", () => {
    // A mixed voucher (game card + race) dispatches two applyVoucher actions
    // under the same code. Keying on code alone would collapse them; keying on
    // (code, itemIndex) keeps both so each covers its own thing.
    let s = seedSession();
    s = reducer(s, {
      type: "applyVoucher",
      voucher: { code: "HPW4K7M9PQR", issuer: "native", itemIndex: 0, name: "Race" },
    });
    s = reducer(s, {
      type: "applyVoucher",
      voucher: { code: "HPW4K7M9PQR", issuer: "native", itemIndex: 1, name: "Laser Tag" },
    });
    expect(s.appliedVouchers).toHaveLength(2);
    expect(s.appliedVouchers?.map((v) => v.itemIndex)).toEqual([0, 1]);
  });

  it("re-dispatching the SAME (code,itemIndex) replaces in place, not appends", () => {
    let s = seedSession();
    const v = { code: "HPW4K7M9PQR", issuer: "native" as const, itemIndex: 0, name: "Race" };
    s = reducer(s, { type: "applyVoucher", voucher: { ...v, pending: true } });
    s = reducer(s, { type: "applyVoucher", voucher: v });
    expect(s.appliedVouchers).toHaveLength(1);
    expect(s.appliedVouchers?.[0].pending).toBeUndefined();
  });

  it("BMI vouchers (no itemIndex) still upsert by code — unchanged", () => {
    let s = seedSession();
    s = reducer(s, { type: "applyVoucher", voucher: { code: "K5B7C3S7Q4Z9Q9Z3M9A9T7Z2" } });
    s = reducer(s, {
      type: "applyVoucher",
      voucher: {
        code: "K5B7C3S7Q4Z9Q9Z3M9A9T7Z2",
        name: "Race Comp",
        billId: "1",
        voucherOrderItemId: "2",
      },
    });
    expect(s.appliedVouchers).toHaveLength(1);
    expect(s.appliedVouchers?.[0].name).toBe("Race Comp");
  });

  it("removeVoucher drops every item of a code", () => {
    let s = seedSession();
    s = reducer(s, {
      type: "applyVoucher",
      voucher: { code: "HPWAAAAAAAA", issuer: "native", itemIndex: 0 },
    });
    s = reducer(s, {
      type: "applyVoucher",
      voucher: { code: "HPWAAAAAAAA", issuer: "native", itemIndex: 1 },
    });
    s = reducer(s, { type: "removeVoucher", code: "HPWAAAAAAAA" });
    expect(s.appliedVouchers ?? []).toHaveLength(0);
  });

  it("removeVoucher with itemIndex drops ONLY that leg (kiosk per-leg ✕)", () => {
    let s = seedSession();
    s = reducer(s, {
      type: "applyVoucher",
      voucher: { code: "HPWAAAAAAAA", issuer: "native", itemIndex: 0 },
    });
    s = reducer(s, {
      type: "applyVoucher",
      voucher: { code: "HPWAAAAAAAA", issuer: "native", itemIndex: 1 },
    });
    s = reducer(s, {
      type: "applyVoucher",
      voucher: { code: "HPWBBBBBBBB", issuer: "native", itemIndex: 0 },
    });
    s = reducer(s, { type: "removeVoucher", code: "HPWAAAAAAAA", itemIndex: 1 });
    expect(s.appliedVouchers).toHaveLength(2);
    expect(s.appliedVouchers?.some((v) => v.code === "HPWAAAAAAAA" && v.itemIndex === 0)).toBe(
      true,
    );
    expect(s.appliedVouchers?.some((v) => v.code === "HPWAAAAAAAA" && v.itemIndex === 1)).toBe(
      false,
    );
    expect(s.appliedVouchers?.some((v) => v.code === "HPWBBBBBBBB")).toBe(true);
  });
});

describe("updateItem — race date change re-validates pack picks", () => {
  // 2026-07-20 Monday, 2026-07-18 Saturday.
  function raceWithPacks(): { s: BookingSession; id: string } {
    let s = seedSession();
    const item = { ...newItem("race"), date: "2026-07-20" } as RaceItem;
    s = { ...s, items: [item] };
    s = reducer(s, {
      type: "updateItem",
      id: item.id,
      patch: {
        creditPacks: [
          { slug: "3-race-weekday", memberId: "m1" },
          { slug: "5-race-anytime", memberId: "m2" },
        ],
      } as Partial<RaceItem>,
    });
    return { s, id: item.id };
  }

  it("date → Saturday drops the weekday pick, keeps the any-day one", () => {
    const { s, id } = raceWithPacks();
    const next = reducer(s, {
      type: "updateItem",
      id,
      patch: { date: "2026-07-18" } as Partial<RaceItem>,
    });
    const race = next.items[0] as RaceItem;
    expect(race.creditPacks).toEqual([{ slug: "5-race-anytime", memberId: "m2" }]);
  });

  it("date → another weekday keeps both picks", () => {
    const { s, id } = raceWithPacks();
    const next = reducer(s, {
      type: "updateItem",
      id,
      patch: { date: "2026-07-21" } as Partial<RaceItem>,
    });
    expect((next.items[0] as RaceItem).creditPacks).toHaveLength(2);
  });

  it("a non-date patch never touches picks", () => {
    const { s, id } = raceWithPacks();
    const next = reducer(s, {
      type: "updateItem",
      id,
      patch: { povQuantity: 1 } as Partial<RaceItem>,
    });
    expect((next.items[0] as RaceItem).creditPacks).toHaveLength(2);
  });

  it("all picks invalid → creditPacks cleared to undefined", () => {
    let s = seedSession();
    const item = { ...newItem("race"), date: "2026-07-20" } as RaceItem;
    s = { ...s, items: [item] };
    s = reducer(s, {
      type: "updateItem",
      id: item.id,
      patch: { creditPacks: [{ slug: "3-race-weekday", memberId: "m1" }] } as Partial<RaceItem>,
    });
    const next = reducer(s, {
      type: "updateItem",
      id: item.id,
      patch: { date: "2026-07-18" } as Partial<RaceItem>,
    });
    expect((next.items[0] as RaceItem).creditPacks).toBeUndefined();
  });
});

/**
 * A bundle with a recurring day rule (BOGO — Wednesday races only) must not
 * survive a move to a day it isn't sold on, still priced at the deal. Nothing
 * downstream refuses it: `raceItemChargeLines` resolves packages by id through
 * `getPackage`, which is deliberately NOT day-gated because expiring one there
 * drops the heats from the Square lines while BMI still books them at $0.
 * Clearing the pointer is the only fail-safe direction available.
 *
 * 2026-08-19 and 2026-09-16 are Wednesdays; 2026-08-20 is a Thursday.
 */
describe("updateItem — race date change re-validates PACKAGE picks", () => {
  function raceWithBogo(date: string): { s: BookingSession; id: string } {
    let s = seedSession();
    const item = { ...newItem("race"), date } as RaceItem;
    s = { ...s, items: [item] };
    s = reducer(s, {
      type: "updateItem",
      id: item.id,
      patch: {
        packageIdAdult: "bogo-weekday",
        packageIdJunior: "bogo-weekday-junior",
      } as Partial<RaceItem>,
    });
    return { s, id: item.id };
  }

  it("Wednesday → Thursday clears both BOGO picks", () => {
    const { s, id } = raceWithBogo("2026-08-19");
    const next = reducer(s, {
      type: "updateItem",
      id,
      patch: { date: "2026-08-20" } as Partial<RaceItem>,
    });
    const race = next.items[0] as RaceItem;
    expect(race.packageIdAdult).toBeNull();
    expect(race.packageIdJunior).toBeNull();
  });

  it("Wednesday → another Wednesday keeps them", () => {
    const { s, id } = raceWithBogo("2026-08-19");
    const next = reducer(s, {
      type: "updateItem",
      id,
      patch: { date: "2026-09-16" } as Partial<RaceItem>,
    });
    const race = next.items[0] as RaceItem;
    expect(race.packageIdAdult).toBe("bogo-weekday");
    expect(race.packageIdJunior).toBe("bogo-weekday-junior");
  });

  /** No `raceDays` on the standing bundles, so this cannot disturb them — the
   *  reducer must not become a general package-eligibility gate. */
  it("a standing bundle survives any date change", () => {
    let s = seedSession();
    const item = { ...newItem("race"), date: "2026-08-19" } as RaceItem;
    s = { ...s, items: [item] };
    s = reducer(s, {
      type: "updateItem",
      id: item.id,
      patch: { packageIdAdult: "ultimate-qualifier-weekday" } as Partial<RaceItem>,
    });
    for (const date of ["2026-08-20", "2026-08-22"]) {
      const next = reducer(s, {
        type: "updateItem",
        id: item.id,
        patch: { date } as Partial<RaceItem>,
      });
      expect((next.items[0] as RaceItem).packageIdAdult).toBe("ultimate-qualifier-weekday");
    }
  });

  it("a non-date patch never touches package picks", () => {
    const { s, id } = raceWithBogo("2026-08-19");
    const next = reducer(s, {
      type: "updateItem",
      id,
      patch: { povQuantity: 1 } as Partial<RaceItem>,
    });
    expect((next.items[0] as RaceItem).packageIdAdult).toBe("bogo-weekday");
  });
});
