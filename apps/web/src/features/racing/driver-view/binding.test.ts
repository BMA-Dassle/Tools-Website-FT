import { describe, expect, it } from "vitest";
import { bindingsFrom, mergeBinding } from "./binding";

const AT = Date.parse("2026-09-05T07:31:48.000Z");

/** Real shapes from `kart:events:queue`, 2026-09-05. */
const PASSING = {
  $type: "TimingPassingNotification",
  RentalObjectName: "15",
  ParticipantId: "60307227",
  ParticipantName: "Eric Osborn",
  SessionId: "58691643",
  SessionName: "65 - Blue Starter",
  ResourceId: "11208654",
};

/** Assignment really does arrive with an EMPTY name — seen live. */
const ASSIGNMENT = {
  $type: "AssignmentNotification",
  ParticipantId: "60307227",
  ParticipantName: "",
  RentalObjectId: "11230373",
  RentalObjectName: "15",
};

const ADVICE = {
  $type: "RaceAdvice",
  RaceId: "58691643",
  Name: "65 - Blue Starter",
  ResourceId: "11208654",
  Drivers: [
    {
      $type: "BcDriver",
      DriverId: "60307227",
      Kart: { $type: "BcKart", KartId: "11230373", Color: "#3E95D1", Name: "15" },
      PersonId: "63000000009540610",
      Alias: "Eric Osborn",
    },
    {
      $type: "BcDriver",
      DriverId: "60307228",
      Kart: { $type: "BcKart", KartId: "11230480", Color: "#eb3636", Name: "21" },
      PersonId: "44649565",
      Alias: "Someone Else",
    },
  ],
};

describe("bindingsFrom", () => {
  it("binds kart to participant off a passing — the strongest evidence", () => {
    const [b] = bindingsFrom(PASSING, AT);
    expect(b.kart).toBe("15");
    expect(b.participantId).toBe("60307227");
    expect(b.sessionId).toBe("58691643");
    expect(b.track).toBe("blue");
    expect(b.source).toBe("passing");
  });

  it("binds off an assignment, and does not invent a name it was not given", () => {
    const [b] = bindingsFrom(ASSIGNMENT, AT);
    expect(b.kart).toBe("15");
    expect(b.participantId).toBe("60307227");
    expect(b.participantName).toBeNull();
  });

  it("yields one binding per driver on a RaceAdvice roster, with the person id", () => {
    const bs = bindingsFrom(ADVICE, AT);
    expect(bs).toHaveLength(2);
    expect(bs[0].kart).toBe("15");
    // 17 digits, intact. A Number round-trip would land on ...608.
    expect(bs[0].personId).toBe("63000000009540610");
    expect(bs[1].kart).toBe("21");
  });

  it("ignores a record that binds nothing", () => {
    expect(bindingsFrom({ $type: "CrashNotification", RentalObjectName: "15" }, AT)).toEqual([]);
    expect(bindingsFrom({ $type: "BcTime" }, AT)).toEqual([]);
  });
});

describe("mergeBinding", () => {
  it("takes the candidate when there is nothing stored", () => {
    const [next] = bindingsFrom(PASSING, AT);
    expect(mergeBinding(null, next)).toEqual(next);
  });

  it("lets a roster fill in the person id without erasing the passing's name", () => {
    const [passing] = bindingsFrom(PASSING, AT);
    const advice = bindingsFrom(ADVICE, AT + 500)[0];
    const merged = mergeBinding(passing, advice);
    expect(merged.personId).toBe("63000000009540610");
    expect(merged.participantName).toBe("Eric Osborn");
    // The passing is stronger evidence and keeps the source rank.
    expect(merged.source).toBe("passing");
  });

  it("never lets an empty assignment name overwrite a real one", () => {
    const [passing] = bindingsFrom(PASSING, AT);
    const [assignment] = bindingsFrom(ASSIGNMENT, AT + 100);
    expect(mergeBinding(passing, assignment).participantName).toBe("Eric Osborn");
  });

  it("moves the kart on to a new driver when the session changes", () => {
    const [passing] = bindingsFrom(PASSING, AT);
    const [nextHeat] = bindingsFrom(
      { ...PASSING, SessionId: "58691700", ParticipantId: "60400000", ParticipantName: "Next Up" },
      AT + 600_000,
    );
    const merged = mergeBinding(passing, nextHeat);
    expect(merged.participantId).toBe("60400000");
    expect(merged.sessionId).toBe("58691700");
    // and must NOT keep the previous driver's person id
    expect(merged.personId).toBeNull();
  });

  it("ignores a replayed record older than what we already know", () => {
    const [passing] = bindingsFrom(PASSING, AT);
    const [stale] = bindingsFrom(
      { ...PASSING, SessionId: "58691500", ParticipantId: "60100000" },
      AT - 600_000,
    );
    expect(mergeBinding(passing, stale).participantId).toBe("60307227");
  });
});
