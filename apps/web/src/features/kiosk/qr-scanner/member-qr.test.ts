import { describe, expect, it } from "vitest";
import { parseMemberQr } from "./member-qr";

const SAMPLE = 'https://smstim.in?["headpinzftmyers","3f59bc35-0548-46df-ba0c-f8cdedc6568d"]';

describe("parseMemberQr", () => {
  it("parses the live scan shape", () => {
    expect(parseMemberQr(SAMPLE)).toEqual({
      clientKey: "headpinzftmyers",
      code: "3f59bc35-0548-46df-ba0c-f8cdedc6568d",
    });
  });

  // The EXACT payload our wallet racing licence carries, byte for byte. The
  // first version of this parser accepted only UUIDs, so a licence scanned at a
  // kiosk fell through both classifiers and died in an "unrecognised" toast
  // while the same pass read fine at the BMI register.
  it("parses OUR licence payload — the short tag, not a UUID", () => {
    expect(parseMemberQr('https://smstim.in?["headpinzftmyers","mgrm2g8o42wxc"]')).toEqual({
      clientKey: "headpinzftmyers",
      code: "mgrm2g8o42wxc",
    });
  });

  it("takes the 6-digit tags BMI also mints", () => {
    // Seen live on real racer records alongside 13-char and UUID tags.
    expect(parseMemberQr('https://smstim.in?["headpinzftmyers","973273"]')?.code).toBe("973273");
  });

  it("still rejects a token that would turn the Office search into an oracle", () => {
    // A name+DOB token finds people by birthday — never let one through.
    expect(parseMemberQr('https://smstim.in?["headpinzftmyers","Osborn 2/12/1991"]')).toBeNull();
    expect(parseMemberQr('https://smstim.in?["headpinzftmyers","abc"]')).toBeNull();
  });

  it("tolerates http, trailing slash before ?, and URL-encoded payloads", () => {
    expect(
      parseMemberQr('http://smstim.in/?["headpinzftmyers","3f59bc35-0548-46df-ba0c-f8cdedc6568d"]'),
    ).not.toBeNull();
    expect(
      parseMemberQr(
        "https://smstim.in?%5B%22headpinzftmyers%22%2C%223f59bc35-0548-46df-ba0c-f8cdedc6568d%22%5D",
      ),
    ).toEqual({ clientKey: "headpinzftmyers", code: "3f59bc35-0548-46df-ba0c-f8cdedc6568d" });
  });

  it("rejects non-smstim URLs, junk codes, and malformed payloads", () => {
    expect(parseMemberQr("https://fasttraxent.com/checkin/abc123")).toBeNull();
    expect(parseMemberQr('https://smstim.in?["headpinzftmyers"]')).toBeNull();
    expect(parseMemberQr('https://smstim.in?["headpinzftmyers","<script>"]')).toBeNull();
    expect(parseMemberQr("https://smstim.in?not json at all")).toBeNull();
    expect(parseMemberQr("DCSDOE")).toBeNull();
  });
});
