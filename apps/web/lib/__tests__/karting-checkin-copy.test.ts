import { describe, it, expect } from "vitest";
import { KARTING_CHECKIN_SMS_NOTE } from "../karting-checkin-copy";

// Any non-GSM-7 char (em-dash, arrow, middot, narrow/no-break space) forces
// UCS-2 encoding (70 chars/segment) and carrier rejection of longer bodies —
// see tasks/lessons.md. The SMS note must stay plain ASCII forever.
describe("KARTING_CHECKIN_SMS_NOTE", () => {
  it("is GSM-7 safe (ASCII only)", () => {
    expect(KARTING_CHECKIN_SMS_NOTE).toMatch(/^[\x00-\x7F]+$/);
  });

  it("stays short enough to not blow the SMS segment budget", () => {
    expect(KARTING_CHECKIN_SMS_NOTE.length).toBeLessThanOrEqual(60);
  });
});
