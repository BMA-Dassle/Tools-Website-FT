import { describe, it, expect } from "vitest";
import { optOutConfirmation, optInConfirmation, helpReply } from "./inbound-replies";
import { segmentsFor } from "./footer";

const ALL = [
  ["opt-out confirmation", optOutConfirmation()],
  ["opt-in confirmation", optInConfirmation()],
  ["HELP reply", helpReply()],
] as const;

describe("every inbound reply", () => {
  for (const [name, body] of ALL) {
    it(`${name} fits one GSM-7 segment`, () => {
      const r = segmentsFor(body);
      expect(r.encoding, `${name} must be GSM-7`).toBe("gsm7");
      expect(r.segments, `${name} is ${r.chars} chars: ${body}`).toBe(1);
    });

    it(`${name} names the brand (TCR 30887/30890)`, () => {
      expect(body).toContain("FastTrax");
      expect(body).toContain("HeadPinz");
    });
  }
});

describe("opt-out confirmation", () => {
  const body = optOutConfirmation();

  it("states plainly that messages stop", () => {
    // TCR 30887 wants confirmation that no further messages will be sent.
    expect(body).toMatch(/opted out/i);
    expect(body).toMatch(/no more/i);
  });

  it("names e-tickets specifically, not just 'messages'", () => {
    // The guest needs to know what they are losing, in concrete terms.
    expect(body).toMatch(/e-tickets/i);
  });

  it("offers the way back in", () => {
    expect(body).toMatch(/reply start/i);
  });

  it("gives an alternative that keeps them admitted", () => {
    // Consequence WITHOUT an alternative is a threat. This is the line
    // that makes it disclosure instead.
    expect(body).toMatch(/guest services/i);
  });

  it("does NOT claim we will email instead", () => {
    // No email failover exists yet. The one message we are allowed to
    // send must not promise something that will not happen.
    expect(body).not.toMatch(/email/i);
  });

  it("does NOT say they cannot enter or race", () => {
    // False (Guest Services works), and conditions service on consent.
    expect(body).not.toMatch(/can'?t enter|cannot enter|not be able to enter/i);
    expect(body).not.toMatch(/won'?t be able to race/i);
  });

  it("does NOT ask the guest to confirm or reconsider", () => {
    // Revocation is effective on receipt. Requiring further action to
    // complete it is prohibited, and "are you sure?" implies exactly that.
    expect(body).not.toMatch(/are you sure/i);
    expect(body).not.toMatch(/reply yes/i);
    expect(body).not.toMatch(/to confirm/i);
  });

  it("contains no marketing content", () => {
    // (a)(12): the confirmation may not contain marketing.
    expect(body).not.toMatch(/book|deal|offer|save|\$|free|discount/i);
  });

  it("gives a support contact", () => {
    expect(body).toMatch(/\d{3}-\d{3}-\d{4}/);
  });
});

describe("HELP reply", () => {
  const body = helpReply();

  it("gives a contact — TCR reject 30890", () => {
    expect(body).toMatch(/\d{3}-\d{3}-\d{4}/);
  });

  it("says what the program sends", () => {
    expect(body).toMatch(/e-tickets/i);
  });

  it("repeats the opt-out instruction", () => {
    // A guest texting HELP is often trying to work out how to stop.
    expect(body).toMatch(/stop/i);
  });

  it("carries the rates disclosure", () => {
    expect(body).toMatch(/msg & data rates/i);
  });
});

describe("opt-in confirmation", () => {
  const body = optInConfirmation();

  it("confirms texts resume", () => {
    expect(body).toMatch(/back on/i);
  });

  it("still tells them how to opt out again", () => {
    // Never leave a guest re-subscribed with no way back out.
    expect(body).toMatch(/reply stop/i);
  });
});
