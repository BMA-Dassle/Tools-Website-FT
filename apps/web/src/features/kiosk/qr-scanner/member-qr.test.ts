import { describe, expect, it } from "vitest";
import { parseMemberQr, parseMemberCode } from "./member-qr";

const SAMPLE = 'https://smstim.in?["headpinzftmyers","3f59bc35-0548-46df-ba0c-f8cdedc6568d"]';

describe("parseMemberQr — register/authenticate form", () => {
  // The shape a REAL BMI register QR uses, and what our wallet racing licence
  // carries. Byte-for-byte from a live register QR, 2026-08-04.
  it("parses the authenticate url", () => {
    expect(parseMemberQr("https://smstim.in/908/authenticate/?login_code=6pmyyfhg4397c")).toEqual({
      clientKey: "",
      code: "6pmyyfhg4397c",
    });
  });

  it("parses the two licences we have issued", () => {
    expect(
      parseMemberQr("https://smstim.in/908/authenticate/?login_code=mgrm2g8o42wxc")?.code,
    ).toBe("mgrm2g8o42wxc");
    expect(
      parseMemberQr("https://smstim.in/908/authenticate/?login_code=nkd59ba4ox8dy")?.code,
    ).toBe("nkd59ba4ox8dy");
  });

  it("tolerates no trailing slash, other params, and a different site id", () => {
    expect(parseMemberQr("https://smstim.in/12/authenticate?login_code=abc123")?.code).toBe(
      "abc123",
    );
    expect(
      parseMemberQr("https://smstim.in/908/authenticate/?lang=en&login_code=mgrm2g8o42wxc")?.code,
    ).toBe("mgrm2g8o42wxc");
  });

  it("rejects an authenticate url with no code, or a junk code", () => {
    expect(parseMemberQr("https://smstim.in/908/authenticate/")).toBeNull();
    expect(parseMemberQr("https://smstim.in/908/authenticate/?login_code=")).toBeNull();
    // Must never become an Office person-search oracle.
    expect(
      parseMemberQr("https://smstim.in/908/authenticate/?login_code=Osborn%202%2F12%2F1991"),
    ).toBeNull();
  });

  it("does not confuse the two forms", () => {
    // App payload has no path; register payload has one. Neither leaks.
    expect(parseMemberQr("https://smstim.in/908/authenticate/?login_code=abc123")?.clientKey).toBe(
      "",
    );
    expect(parseMemberQr(SAMPLE)?.clientKey).toBe("headpinzftmyers");
  });
});

describe("parseMemberQr", () => {
  it("parses the live scan shape", () => {
    expect(parseMemberQr(SAMPLE)).toEqual({
      clientKey: "headpinzftmyers",
      code: "3f59bc35-0548-46df-ba0c-f8cdedc6568d",
    });
  });

  // The EXACT payload the FastTrax wallet racing licence carries, byte for
  // byte. It uses the short tag rather than a UUID because the UUID form is
  // already the app's own QR, and most racers have no UUID tag at all. Rejecting
  // it meant the kiosk refused a pass the BMI register reads.
  it("parses the wallet licence payload — a short tag, not a UUID", () => {
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
    // A name+DOB token finds people by birthday — it must never resolve here.
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

describe("parseMemberCode — typed bare code", () => {
  it("accepts the code a staff member reads off the pass", () => {
    // The real one from the desk, 2026-08-20 — racer was on Red 31 and the
    // typed code was refused outright.
    expect(parseMemberCode("ksp98sahye7nw")).toEqual({ clientKey: "", code: "ksp98sahye7nw" });
    expect(parseMemberCode("mgrm2g8o42wxc")?.code).toBe("mgrm2g8o42wxc");
  });

  it("tolerates surrounding whitespace, because this one is typed", () => {
    expect(parseMemberCode("  ksp98sahye7nw \n")?.code).toBe("ksp98sahye7nw");
  });

  it("REFUSES bare digits — at this desk those are a paper QR participant id", () => {
    // The collision worth having a test for: CODE_RE alone would accept both.
    expect(parseMemberCode("49976218")).toBeNull();
    expect(parseMemberCode("973273")).toBeNull();
  });

  it("refuses a person-search token, same rule as the wrapped forms", () => {
    expect(parseMemberCode("Osborn 2/12/1991")).toBeNull();
    expect(parseMemberCode("abc")).toBeNull();
    expect(parseMemberCode("")).toBeNull();
    expect(parseMemberCode("   ")).toBeNull();
  });

  it("leaves payloads that belong to another parser alone", () => {
    expect(parseMemberCode("FT:63000000000021716:99887766")).toBeNull();
    expect(parseMemberCode("HP:TXBSQN0FEKQ11:12345:67890")).toBeNull();
    expect(parseMemberCode("https://smstim.in/908/authenticate/?login_code=abc123")).toBeNull();
  });
});
