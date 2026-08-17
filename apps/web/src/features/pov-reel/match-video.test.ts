import { describe, expect, it } from "vitest";
import { racerMatchesVideo } from "./match-video";

const v = (firstName: string, lastName: string) => ({ firstName, lastName });

describe("racerMatchesVideo", () => {
  it("matches a full name exactly", () => {
    expect(racerMatchesVideo("Genn Alvarez", v("Genn", "Alvarez"))).toBe(true);
  });

  it("matches the timing system's ABBREVIATED surname", () => {
    // ParticipantName is what a human typed at a kiosk. "Genn A" is the common
    // real shape, and an exact compare would silently drop most true pairs.
    expect(racerMatchesVideo("Genn A", v("Genn", "Alvarez"))).toBe(true);
  });

  it("ignores case and punctuation on both sides", () => {
    expect(racerMatchesVideo("CHRIS  O'BRIEN", v("chris", "obrien"))).toBe(true);
  });

  it("rejects a different forename", () => {
    expect(racerMatchesVideo("Sam Alvarez", v("Genn", "Alvarez"))).toBe(false);
  });

  it("rejects a different surname", () => {
    expect(racerMatchesVideo("Genn Bell", v("Genn", "Alvarez"))).toBe(false);
  });

  it("rejects a forename with NO surname — one name cannot identify a racer", () => {
    expect(racerMatchesVideo("Genn", v("Genn", "Alvarez"))).toBe(false);
  });

  it("rejects when the video side has no surname", () => {
    expect(racerMatchesVideo("Genn Alvarez", v("Genn", ""))).toBe(false);
  });

  it("matches when the abbreviation runs the other way", () => {
    expect(racerMatchesVideo("Genn Alvarez", v("Genn", "Alv"))).toBe(true);
  });

  it("treats a shared initial as a match on BOTH — which is why the caller fails closed", () => {
    // Prefix matching cannot separate these two. The service requires exactly
    // one hit per session and excludes the racer when more than one matches.
    expect(racerMatchesVideo("Genn A", v("Genn", "Alvarez"))).toBe(true);
    expect(racerMatchesVideo("Genn A", v("Genn", "Anderson"))).toBe(true);
  });

  it("rejects a surname that merely shares a middle substring", () => {
    expect(racerMatchesVideo("Genn Varez", v("Genn", "Alvarez"))).toBe(false);
  });

  it("handles a missing lastName field without throwing", () => {
    expect(racerMatchesVideo("Genn Alvarez", { firstName: "Genn" })).toBe(false);
  });
});
