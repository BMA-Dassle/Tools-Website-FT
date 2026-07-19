/**
 * Only people booked into an activity go on the BMI reservation (owner rule
 * 2026-07-19): the kiosk people roster is session-scoped, so a guest can be
 * signed in (account + waiver) without being put on any race or attraction —
 * they must never be registered as a projectPerson on the bill, and they must
 * not appear in racerNames metadata.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { bmiBookedMemberIds, registerProjectPersons } from "./bmi-register";
import { racerNamesFromHeats } from "./checkout";
import { newItem, newPartyMember } from "../state/types";
import type {
  AttractionItem,
  BowlingItem,
  PartyMember,
  RaceHeatAssignment,
  RaceItem,
} from "../state/types";

function heat(assignedTo: string | null, heatId: string | null = "2026-07-19T18:00:00") {
  return {
    productId: "12345",
    track: "Red",
    heatId,
    bmiLineId: null,
    assignedTo,
  } as RaceHeatAssignment;
}

function member(firstName: string, bmiPersonId?: string): PartyMember {
  return newPartyMember({ firstName, bmiPersonId });
}

describe("bmiBookedMemberIds", () => {
  it("collects race heats' assignedTo and attraction participants/assignedTo", () => {
    const race = { ...(newItem("race") as RaceItem), heats: [heat("a"), heat("b")] };
    const attraction = {
      ...(newItem("attraction") as AttractionItem),
      participants: ["c"],
      assignedTo: ["d"],
    };
    expect(bmiBookedMemberIds([race, attraction], ["a", "b", "c", "d", "e"])).toEqual(
      new Set(["a", "b", "c", "d"]),
    );
  });

  it("ignores unpicked heats (no heatId) and unassigned heats", () => {
    const race = { ...(newItem("race") as RaceItem), heats: [heat("a", null), heat(null)] };
    expect(bmiBookedMemberIds([race], ["a"])).toEqual(new Set());
  });

  it("attraction with participants NEVER toggled (undefined) means the whole party — the kiosk people-step default", () => {
    const attraction = newItem("attraction") as AttractionItem;
    expect(bmiBookedMemberIds([attraction], ["a", "b"])).toEqual(new Set(["a", "b"]));
  });

  it("attraction with an explicit participants selection excludes everyone toggled off", () => {
    const attraction = { ...(newItem("attraction") as AttractionItem), participants: ["a"] };
    expect(bmiBookedMemberIds([attraction], ["a", "b"])).toEqual(new Set(["a"]));
  });

  it("ignores bowling rosters — Conqueror-vendored, never on the BMI bill", () => {
    const bowling = { ...(newItem("bowling") as BowlingItem), assignedTo: ["a", "b"] };
    expect(bmiBookedMemberIds([bowling], ["a", "b"])).toEqual(new Set());
  });
});

describe("registerProjectPersons", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("registers only party members booked into a BMI activity", async () => {
    const racing = member("Alex", "63000000001111111");
    const signedInOnly = member("Bob", "63000000002222222"); // logged in, never put on a race
    const attractionOnly = member("Dana", "63000000003333333");
    const race = { ...(newItem("race") as RaceItem), heats: [heat(racing.id)] };
    const attraction = {
      ...(newItem("attraction") as AttractionItem),
      participants: [attractionOnly.id],
    };

    const bodies: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        bodies.push(String(init?.body ?? ""));
        return new Response("{}", { status: 200 });
      }),
    );

    await registerProjectPersons(
      "63000000009999999",
      [racing, signedInOnly, attractionOnly],
      [race, attraction],
    );

    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toContain(`"personId":${racing.bmiPersonId}`);
    expect(bodies[1]).toContain(`"personId":${attractionOnly.bmiPersonId}`);
    expect(bodies.join("\n")).not.toContain(signedInOnly.bmiPersonId!);
  });

  it("still skips booked members without a bmiPersonId (new racers — v1 parity)", async () => {
    const newRacer = member("Cara"); // no personId yet
    const race = { ...(newItem("race") as RaceItem), heats: [heat(newRacer.id)] };
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await registerProjectPersons("63000000009999999", [newRacer], [race]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("racerNamesFromHeats", () => {
  it("lists only members actually assigned to a heat, once, in party order", () => {
    const alex = member("Alex", "63000000001111111");
    const bob = member("Bob"); // signed in, not racing
    const cara = member("Cara");
    const heats = [heat(cara.id), heat(alex.id), heat(alex.id)];
    expect(racerNamesFromHeats(heats, [alex, bob, cara])).toEqual(["Alex", "Cara"]);
  });
});
