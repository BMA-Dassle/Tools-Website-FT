import { describe, it, expect } from "vitest";
import { heatLabelShort, buildSingleMoveSmsBody, buildGroupMoveSmsBody } from "../race-move-sms";
import type { GroupTicketMember, ParticipantTicketRef } from "../race-tickets";

const CTA = "Have open for check-in";
const URL = "https://fasttraxent.com/s/abc123";

// June = EDT (UTC-4): 18:00Z -> 2:00 PM ET, 19:10Z -> 3:10 PM ET, 18:15Z -> 2:15 PM ET.
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

// Any non-GSM-7 char (em-dash, arrow, middot, narrow/no-break space) forces
// UCS-2 and carrier rejection. The bodies must be plain ASCII.
const NON_GSM7 = /[^\x00-\x7F]/;

describe("heatLabelShort", () => {
  it("formats heat number, track, type, and ET time with a plain space", () => {
    const label = heatLabelShort(NEW_HEAT);
    expect(label).toMatch(/^Heat 8 Red Pro 3:10 PM$/);
    expect(label).not.toMatch(NON_GSM7);
  });
});

describe("buildSingleMoveSmsBody", () => {
  it("names the racer and shows Was/Now on their own lines", () => {
    const body = buildSingleMoveSmsBody(NEW_HEAT, OLD_REF, URL, CTA);
    expect(body).toContain("FastTrax: race time change for Jordan Lee");
    expect(body).toContain("Was Heat 5 Blue Starter 2:00 PM");
    expect(body).toContain("Now Heat 8 Red Pro 3:10 PM");
    expect(body).toContain(URL);
    expect(body).toContain(CTA);
  });

  it("is GSM-7 safe (ASCII only)", () => {
    expect(buildSingleMoveSmsBody(NEW_HEAT, OLD_REF, URL, CTA)).not.toMatch(NON_GSM7);
  });
});

describe("buildGroupMoveSmsBody", () => {
  const CASEY: GroupTicketMember = {
    sessionId: "150",
    personId: "63000000000099999",
    participantId: "49976300",
    firstName: "Casey",
    lastName: "Lee",
    scheduledStart: "2026-06-05T18:15:00Z", // 2:15 PM - earlier than Jordan's new 3:10
    track: "Blue",
    raceType: "Starter",
    heatNumber: 6,
  };

  it("names each racer; movers show was/now, others their heat", () => {
    const body = buildGroupMoveSmsBody(
      [
        { member: NEW_HEAT, movedFrom: OLD_REF },
        { member: CASEY, movedFrom: null },
      ],
      URL,
      CTA,
    );
    expect(body).toContain("FastTrax: race time change");
    expect(body).toContain(
      "- Jordan Lee: was Heat 5 Blue Starter 2:00 PM, now Heat 8 Red Pro 3:10 PM",
    );
    expect(body).toContain("- Casey Lee: Heat 6 Blue Starter 2:15 PM");
    expect(body).not.toMatch(/Casey Lee: was/);
    expect(body).toContain(URL);
    expect(body).toContain(CTA);
    expect(body).not.toMatch(NON_GSM7);
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
    expect(body).toContain("FastTrax: race time change for your racers");
  });
});
