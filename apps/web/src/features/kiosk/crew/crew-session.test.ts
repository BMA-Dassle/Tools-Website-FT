import { beforeEach, describe, expect, it } from "vitest";
import { emptySession, reducer, type PartyMember } from "~/features/booking";
import { readSession } from "~/features/booking/hooks/usePersistedReducer";
import { newCrewItem } from "./crew-item";

/** Minimal in-memory sessionStorage — these tests run in the node environment
 *  (same stub as entry-scan/handoff.test.ts). */
function installStorage(): Storage {
  const map = new Map<string, string>();
  const storage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
  globalThis.sessionStorage = storage;
  return storage;
}

const member = (id: string, firstName: string): PartyMember => ({
  id,
  firstName,
  isNewRacer: false,
});

function crewSession() {
  return emptySession({
    entryBrand: "fasttrax",
    context: { center: "fort-myers", kiosk: true },
  });
}

describe("crew page session contract", () => {
  // H8: the synthetic item is a PROP to the people step, never session state —
  // and nothing the people step dispatches (party/contact mutations) may create
  // an item. If this fails, the crew page is putting a phantom line in the cart.
  it("party dispatches never create items — the synthetic item stays a prop", () => {
    let s = crewSession();
    s = reducer(s, { type: "addPartyMember", member: member("m1", "Mike") });
    s = reducer(s, { type: "addPartyMember", member: member("m2", "Sara") });
    s = reducer(s, {
      type: "updatePartyMember",
      id: "m1",
      patch: { bmiPersonId: "12345", waiverValid: true },
    });
    s = reducer(s, { type: "setContact", patch: { firstName: "Mike", phone: "2395550100" } });
    s = reducer(s, { type: "removePartyMember", id: "m2" });

    expect(s.party.map((m) => m.id)).toEqual(["m1"]);
    expect(s.party[0]).toMatchObject({ bmiPersonId: "12345", waiverValid: true });
    expect(s.contact).toMatchObject({ firstName: "Mike" });
    expect(s.items).toEqual([]);
    expect(s.items.some((i) => i.id === newCrewItem().id)).toBe(false);
  });

  it("the synthetic item is never priced and never booked", () => {
    const item = newCrewItem();
    expect(item).toMatchObject({
      kind: "attraction",
      slug: null,
      price: 0,
      bmiLineId: null,
      slot: null,
      assignedTo: [],
    });
  });

  // The crew page and KioskFlow share one storageKey + schemaVersion (both
  // import from state/registry.ts), so what one writes the other restores.
  // This pins the envelope mechanism they ride: same-version party survives,
  // an older-build envelope is discarded rather than resumed half-stale.
  describe("persisted envelope round trip", () => {
    beforeEach(() => {
      installStorage();
    });

    it("a party written at the current schema version survives readSession", () => {
      let s = crewSession();
      s = reducer(s, { type: "addPartyMember", member: member("m1", "Mike") });
      sessionStorage.setItem("kiosk_booking_session", JSON.stringify({ v: 7, session: s }));

      const restored = readSession("kiosk_booking_session", 7);
      expect(restored).not.toBeNull();
      expect(restored?.party.map((m) => m.firstName)).toEqual(["Mike"]);
      expect(restored?.items).toEqual([]);
    });

    it("an older-schema envelope is discarded, not resumed", () => {
      const s = crewSession();
      sessionStorage.setItem("kiosk_booking_session", JSON.stringify({ v: 6, session: s }));

      expect(readSession("kiosk_booking_session", 7)).toBeNull();
      // The stale key is gone too — the next guest starts clean.
      expect(sessionStorage.getItem("kiosk_booking_session")).toBeNull();
    });
  });
});
