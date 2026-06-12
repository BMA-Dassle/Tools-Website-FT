import { describe, expect, it } from "vitest";
import type { GroupTicketMember, ParticipantTicketRef } from "@/lib/race-tickets";
import {
  buildArenaCheckinGroupSmsBody,
  buildArenaCheckinGuardianGroupSmsBody,
  buildArenaCheckinGuardianSingleSmsBody,
  buildArenaCheckinSingleSmsBody,
  buildArenaGroupMoveSmsBody,
  buildArenaGroupSmsBody,
  buildArenaGuardianGroupSmsBody,
  buildArenaGuardianSingleSmsBody,
  buildArenaSingleMoveSmsBody,
  buildArenaSingleSmsBody,
} from "./sms";
import { classifyArenaSession } from "./types";

/** GSM-7 basic set approximation — every body we build must be plain
 *  ASCII (a strict subset of GSM-7) so carriers never flip to UCS-2.
 *  One non-ASCII char would shrink segments 153 → 67 chars and trip
 *  the carrier "too long" rejection (code 4505, see tasks/lessons.md). */
function isAscii(s: string): boolean {
  return [...s].every((ch) => ch.charCodeAt(0) <= 0x7f);
}

/** 2 concatenated GSM-7 segments = 306 chars. */
const MAX_TWO_SEGMENTS = 306;

const SHORT_URL = "https://headpinz.com/s/Ab3dEf";

function member(overrides: Partial<GroupTicketMember> = {}): GroupTicketMember {
  return {
    sessionId: "50440549",
    personId: "63000000000021716",
    participantId: "49976218",
    firstName: "Alexandria-Catherine",
    lastName: "Wolfeschlegelsteinhausen",
    scheduledStart: "2026-06-11T21:00:00.000Z",
    track: "Laser Tag",
    raceType: "Laser Tag",
    heatNumber: 21,
    activity: "laser-tag",
    ...overrides,
  };
}

function movedFrom(overrides: Partial<ParticipantTicketRef> = {}): ParticipantTicketRef {
  return {
    sessionId: "50440500",
    ticketId: "AAAAAAAA",
    heatNumber: 15,
    track: "Laser Tag",
    raceType: "Laser Tag",
    scheduledStart: "2026-06-11T19:30:00.000Z",
    ...overrides,
  };
}

describe("arena SMS bodies — GSM-7 / segment budget", () => {
  const bodies: [string, string][] = [
    ["single", buildArenaSingleSmsBody(member(), SHORT_URL)],
    ["guardian single", buildArenaGuardianSingleSmsBody(member(), SHORT_URL)],
    ["single move", buildArenaSingleMoveSmsBody(member(), movedFrom(), SHORT_URL)],
    [
      "group (3 players, 2 sessions)",
      buildArenaGroupSmsBody(
        [
          member(),
          member({ personId: "2", firstName: "Christopher-James" }),
          member({
            personId: "3",
            sessionId: "50440550",
            firstName: "Bartholomew",
            track: "Gel Blaster",
            activity: "gel-blaster",
            heatNumber: 25,
            scheduledStart: "2026-06-11T22:00:00.000Z",
          }),
        ],
        SHORT_URL,
      ),
    ],
    [
      "guardian group",
      buildArenaGuardianGroupSmsBody(
        [member(), member({ personId: "2", firstName: "Christopher-James" })],
        SHORT_URL,
      ),
    ],
    [
      "group move",
      buildArenaGroupMoveSmsBody(
        [
          { member: member(), movedFrom: movedFrom() },
          { member: member({ personId: "2", firstName: "Christopher-James" }), movedFrom: null },
        ],
        SHORT_URL,
        { guardian: true },
      ),
    ],
    ["checkin single", buildArenaCheckinSingleSmsBody(member(), SHORT_URL)],
    ["checkin guardian single", buildArenaCheckinGuardianSingleSmsBody(member(), SHORT_URL)],
    [
      "checkin group",
      buildArenaCheckinGroupSmsBody(
        [member(), member({ personId: "2", firstName: "Christopher-James" })],
        SHORT_URL,
      ),
    ],
    [
      "checkin guardian group",
      buildArenaCheckinGuardianGroupSmsBody(
        [member(), member({ personId: "2", firstName: "Christopher-James" })],
        SHORT_URL,
      ),
    ],
  ];

  for (const [name, body] of bodies) {
    it(`${name} is ASCII-only`, () => {
      expect(isAscii(body), `non-ASCII chars in: ${body}`).toBe(true);
    });
    it(`${name} fits in 2 GSM-7 segments even with max-length names`, () => {
      expect(body.length, `body too long (${body.length}):\n${body}`).toBeLessThanOrEqual(
        MAX_TWO_SEGMENTS,
      );
    });
    it(`${name} carries the short link`, () => {
      expect(body).toContain(SHORT_URL);
    });
  }

  it("single body names the player and the session", () => {
    const body = buildArenaSingleSmsBody(
      member({ firstName: "Avery", lastName: "Test" }),
      SHORT_URL,
    );
    expect(body).toContain("Avery Test");
    expect(body).toContain("Laser Tag Session 21");
    expect(body).toContain("HeadPinz");
  });

  it("move body shows Was/Now lines", () => {
    const body = buildArenaSingleMoveSmsBody(
      member({ firstName: "Avery", lastName: "Test" }),
      movedFrom(),
      SHORT_URL,
    );
    expect(body).toContain("Was Laser Tag Session 15");
    expect(body).toContain("Now Laser Tag Session 21");
  });

  it("checkin body leads with the urgent header and names the desk", () => {
    const body = buildArenaCheckinSingleSmsBody(
      member({ firstName: "Avery", lastName: "Test" }),
      SHORT_URL,
    );
    expect(body.startsWith("HeadPinz: NOW CHECKING IN")).toBe(true);
    expect(body).toContain("HP Arena desk");
    expect(body).toContain("Avery Test");
  });

  it("group body groups players under their session", () => {
    const body = buildArenaGroupSmsBody(
      [member({ firstName: "Avery" }), member({ personId: "2", firstName: "Riley" })],
      SHORT_URL,
    );
    const sessionLineIndex = body.indexOf("Laser Tag Session 21");
    expect(sessionLineIndex).toBeGreaterThan(-1);
    expect(body.indexOf("- Avery")).toBeGreaterThan(sessionLineIndex);
    expect(body.indexOf("- Riley")).toBeGreaterThan(sessionLineIndex);
  });
});

describe("classifyArenaSession", () => {
  it("classifies live BMI session names", () => {
    expect(classifyArenaSession("7 - Nexus Laser Tag")).toBe("laser-tag");
    expect(classifyArenaSession("11 - Nexus Gel Blaster")).toBe("gel-blaster");
  });
  it("is case-insensitive", () => {
    expect(classifyArenaSession("3 - NEXUS LASER TAG")).toBe("laser-tag");
  });
  it("returns null for unknown session kinds (parties, events)", () => {
    expect(classifyArenaSession("2 - Birthday Party")).toBeNull();
    expect(classifyArenaSession("")).toBeNull();
  });
});
