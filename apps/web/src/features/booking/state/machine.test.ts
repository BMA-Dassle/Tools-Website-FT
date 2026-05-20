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
    const attractionId = "i-att";
    const bowlingId = "i-bowl";
    const initial: BookingSession = {
      ...seedSession(),
      party: [alex, bob],
      items: [
        {
          id: attractionId,
          kind: "attraction",
          slug: "gel-blaster",
          date: null,
          slot: null,
          qty: 2,
          assignedTo: [alex.id, bob.id],
        },
        {
          id: bowlingId,
          kind: "bowling",
          variant: "open",
          date: null,
          hour: null,
          laneCount: 1,
          assignedTo: [alex.id, bob.id],
        },
      ],
    };
    const after = reducer(initial, { type: "removePartyMember", id: alex.id });
    const att = after.items.find((i) => i.id === attractionId);
    const bowl = after.items.find((i) => i.id === bowlingId);
    expect(att?.kind === "attraction" && att.assignedTo).toEqual([bob.id]);
    expect(bowl?.kind === "bowling" && bowl.assignedTo).toEqual([bob.id]);
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
    expect(s.kbfIdentity).toEqual({ phase: "lookup", emailOrPhone: "", passId: null });
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
    });
  });
});
