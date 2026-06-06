import { describe, it, expect } from "vitest";
import { heatLabelShort, buildSingleMoveSmsBody, buildGroupMoveSmsBody } from "../race-move-sms";
import type { GroupTicketMember, ParticipantTicketRef } from "../race-tickets";

const CTA = "Have open for check-in";
const URL = "https://fasttraxent.com/s/abc123";

// June = EDT (UTC-4): 18:00Z → 2:00 PM ET, 19:10Z → 3:10 PM ET, 18:15Z → 2:15 PM ET.
const NEW_HEAT: GroupTicketMember = {
  sessionId: "200",
  personId: "63000000000021716",
  participantId: "49976218",
  firstName: "Jordan",
  lastName: "Lee",
  scheduledStart: "2026-06-05T19:10:00Z",
  track: "Red",
  raceType: "Pro",
  heatNumber: 8,
};

const OLD_REF: ParticipantTicketRef = {
  sessionId: "100",
  ticketId: "oldTicket1",
  heatNumber: 5,
  track: "Blue",
  raceType: "Starter",
  scheduledStart: "2026-06-05T18:00:00Z",
};

describe("heatLabelShort", () => {
  it("formats heat number, track, type, and ET time", () => {
    expect(heatLabelShort(NEW_HEAT)).toMatch(/^Heat 8 Red Pro .*3:10/);
  });
});

describe("buildSingleMoveSmsBody", () => {
  it("racer flavor names it 'Your race moved' with from→to", () => {
    const body = buildSingleMoveSmsBody(NEW_HEAT, OLD_REF, URL, CTA);
    expect(body).toContain("FastTrax — Your race moved.");
    expect(body).toMatch(/Was Heat 5 Blue Starter .*2:00/);
    expect(body).toMatch(/now Heat 8 Red Pro .*3:10/);
    expect(body).toContain(URL);
    expect(body).toContain(CTA);
  });

  it("guardian flavor names the racer", () => {
    const body = buildSingleMoveSmsBody(NEW_HEAT, OLD_REF, URL, CTA, { guardian: true });
    expect(body).toContain("FastTrax — Jordan's race moved.");
  });
});

describe("buildGroupMoveSmsBody", () => {
  const CASEY: GroupTicketMember = {
    sessionId: "150",
    personId: "63000000000099999",
    participantId: "49976300",
    firstName: "Casey",
    lastName: "Lee",
    scheduledStart: "2026-06-05T18:15:00Z", // 2:15 PM — earlier than Jordan's new 3:10
    track: "Blue",
    raceType: "Starter",
    heatNumber: 6,
  };

  it("flags the change, shows a moved line for movers and a normal line for others", () => {
    const body = buildGroupMoveSmsBody(
      [
        { member: NEW_HEAT, movedFrom: OLD_REF },
        { member: CASEY, movedFrom: null },
      ],
      URL,
      CTA,
    );
    expect(body).toContain("(a race time changed)");
    expect(body).toMatch(
      /Jordan Lee: moved — was Heat 5 Blue Starter .*2:00.*now Heat 8 Red Pro .*3:10/,
    );
    expect(body).toMatch(/Casey Lee: Heat 6 Blue Starter .*2:15/);
    expect(body).not.toMatch(/Casey Lee: moved/);
    expect(body).toContain(URL);
    expect(body).toContain(CTA);
  });

  it("sorts members by their (new) heat time", () => {
    const body = buildGroupMoveSmsBody(
      [
        { member: NEW_HEAT, movedFrom: OLD_REF }, // 3:10
        { member: CASEY, movedFrom: null }, // 2:15
      ],
      URL,
      CTA,
    );
    expect(body.indexOf("Casey Lee")).toBeLessThan(body.indexOf("Jordan Lee"));
  });

  it("guardian flavor uses the 'your racers' header", () => {
    const body = buildGroupMoveSmsBody([{ member: NEW_HEAT, movedFrom: OLD_REF }], URL, CTA, {
      guardian: true,
    });
    expect(body).toContain("FastTrax e-tickets for your racers (a race time changed):");
  });
});
