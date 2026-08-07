/**
 * Two code shapes, two trust contexts. Conflating them was the bug: the wallet
 * route validated a URL with the SCAN regex, which accepts 6-character tags.
 *
 * A scan is handed over by a person physically present. A URL is typed, shared,
 * crawled and enumerated — and behind these routes sits a racer's name, their
 * sign-in barcode, and a newly minted BILLED pass.
 */
import { describe, it, expect } from "vitest";
import { RACER_LOGIN_CODE_RE, RACER_PUBLIC_CODE_RE } from "./types";

/** Real shapes, measured on a live Office record 2026-08-06. */
const SHORT_NUMERIC = "781136"; // 6-char, looks like a counter
const SHORT_NUMERIC_2 = "973273";
const THIRTEEN = "mgrm2g8o42wxc";
const THIRTEEN_2 = "oe4wrr8x2m4qv";
const UUID = "3f59bcd2-1a4e-4c88-9f2b-77d0e1a4bb31";

describe("RACER_LOGIN_CODE_RE — what a SCANNER accepts", () => {
  it("accepts every tag shape BMI mints", () => {
    // Nothing may key off length here: a racer holds 6, 13 and 36-char tags at
    // once and any of them can come off a barcode.
    for (const code of [SHORT_NUMERIC, SHORT_NUMERIC_2, THIRTEEN, THIRTEEN_2]) {
      expect(RACER_LOGIN_CODE_RE.test(code), code).toBe(true);
    }
  });

  it("still refuses the shapes that make the Office search a people-oracle", () => {
    // The token search answers `LastName M/D/YYYY` too, so spaces and slashes
    // would turn an unauthenticated route into a birthday lookup.
    for (const bad of ["Osborn 2/12/1991", "abc/def", "abc def", "", "abc"]) {
      expect(RACER_LOGIN_CODE_RE.test(bad), bad).toBe(false);
    }
  });
});

describe("RACER_PUBLIC_CODE_RE — what a PUBLISHED URL accepts", () => {
  it("REJECTS 6-char tags — a 10^6 space is walkable in minutes", () => {
    expect(RACER_PUBLIC_CODE_RE.test(SHORT_NUMERIC)).toBe(false);
    expect(RACER_PUBLIC_CODE_RE.test(SHORT_NUMERIC_2)).toBe(false);
    // and every other counter-sized value in that space
    for (const n of ["000000", "000001", "999999", "12345678", "1234567890"]) {
      expect(RACER_PUBLIC_CODE_RE.test(n), n).toBe(false);
    }
  });

  it("accepts the shapes we actually publish", () => {
    // codeForPersonId prefers the 13-char tag, so every link we hand out is one
    // of these — hardening costs us nothing.
    expect(RACER_PUBLIC_CODE_RE.test(THIRTEEN)).toBe(true);
    expect(RACER_PUBLIC_CODE_RE.test(THIRTEEN_2)).toBe(true);
    expect(RACER_PUBLIC_CODE_RE.test(UUID)).toBe(true);
  });

  it("is strictly narrower than the scan shape, never wider", () => {
    const samples = [
      SHORT_NUMERIC,
      THIRTEEN,
      UUID,
      "Osborn 2/12/1991",
      "abc",
      "",
      "abc/def",
    ];
    for (const s of samples) {
      if (RACER_PUBLIC_CODE_RE.test(s)) {
        // A UUID carries hyphens, which the scan regex rejects — that is the one
        // deliberate exception and it is not an enumeration risk at 10^38.
        if (!s.includes("-")) {
          expect(RACER_LOGIN_CODE_RE.test(s), `public accepted but scan rejected: ${s}`).toBe(
            true,
          );
        }
      }
    }
  });
});
