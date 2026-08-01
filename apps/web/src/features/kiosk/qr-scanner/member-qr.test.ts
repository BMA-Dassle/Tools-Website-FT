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
