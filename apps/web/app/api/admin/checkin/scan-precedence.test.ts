import { describe, expect, it } from "vitest";
import { parseCheckinQr } from "@/lib/qr-checkin";
import { parseMemberQr } from "~/features/kiosk/qr-scanner/member-qr";

/**
 * The race check-in page (e-ticket scans) now accepts a wallet racing licence,
 * which meant putting a SECOND parser in front of `parseCheckinQr`. That is the
 * classic way to break a working scanner: a greedy new branch quietly swallows
 * payloads the old one used to handle.
 *
 * These tests pin the property that makes the ordering safe — the two parsers
 * are DISJOINT. Every payload the desk handled before must be invisible to
 * `parseMemberQr`, and the licence must be invisible to `parseCheckinQr`. If
 * either guard is ever loosened, this fails here rather than at a desk with a
 * queue of racers waiting.
 */

/** The exact payload our wallet licence carries — a real register QR shape. */
const LICENCE = "https://smstim.in/908/authenticate/?login_code=mgrm2g8o42wxc";
/** The SMS-Timing app's own personal QR — the other licence-ish shape. */
const APP_QR = 'https://smstim.in?["headpinzftmyers","3f59bc35-0548-46df-ba0c-f8cdedc6568d"]';

describe("race check-in scan precedence", () => {
  describe("the licence branch must not steal an existing desk payload", () => {
    const existing = [
      ["3-part e-ticket", "FT:12345:67890"],
      ["4-part e-ticket (move-resilient)", "FT:12345:67890:49976218"],
      ["17-digit personId e-ticket", "FT:63000000000021716:99887766"],
      ["HP arena ticket", "HP:TXBSQN0FEKQ11:12345:67890"],
      ["bare paper QR (participant id)", "0000000001063464"],
      ["short numeric paper QR", "597195"],
    ] as const;

    for (const [label, payload] of existing) {
      it(`ignores a ${label}`, () => {
        expect(parseMemberQr(payload)).toBeNull();
      });
    }
  });

  describe("the old parser cannot handle a licence — which is why the branch exists", () => {
    it("parseCheckinQr rejects both licence shapes", () => {
      expect(parseCheckinQr(LICENCE)).toBeNull();
      expect(parseCheckinQr(APP_QR)).toBeNull();
    });

    it("parseMemberQr claims both licence shapes", () => {
      expect(parseMemberQr(LICENCE)?.code).toBe("mgrm2g8o42wxc");
      expect(parseMemberQr(APP_QR)?.code).toBe("3f59bc35-0548-46df-ba0c-f8cdedc6568d");
    });
  });

  it("a 6-digit BMI tag is a PAPER QR here, never a licence", () => {
    // BMI mints 6-digit tags (seen live), and the desk reads a bare number as a
    // participant id. A licence must therefore always arrive wrapped in its URL
    // — a bare code at this desk belongs to the paper-QR path, not to us.
    expect(parseMemberQr("597195")).toBeNull();
    expect(parseMemberQr("https://smstim.in/908/authenticate/?login_code=597195")?.code).toBe(
      "597195",
    );
  });
});
