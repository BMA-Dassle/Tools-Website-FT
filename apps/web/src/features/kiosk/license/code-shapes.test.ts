/**
 * Two code shapes, two trust contexts. Conflating them was the bug: the wallet
 * route validated a URL with the SCAN regex, which accepts 6-character tags.
 *
 * A scan is handed over by a person physically present. A URL is typed, shared,
 * crawled and enumerated — and behind these routes sits a racer's name, their
 * sign-in barcode, and a newly minted BILLED pass.
 */
import { describe, it, expect } from "vitest";
import { RACER_LOGIN_CODE_RE, RACER_PUBLIC_CODE_RE, pickPublishableLoginCode } from "./types";

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
    const samples = [SHORT_NUMERIC, THIRTEEN, UUID, "Osborn 2/12/1991", "abc", "", "abc/def"];
    for (const s of samples) {
      if (RACER_PUBLIC_CODE_RE.test(s)) {
        // A UUID carries hyphens, which the scan regex rejects — that is the one
        // deliberate exception and it is not an enumeration risk at 10^38.
        if (!s.includes("-")) {
          expect(RACER_LOGIN_CODE_RE.test(s), `public accepted but scan rejected: ${s}`).toBe(true);
        }
      }
    }
  });
});

describe("pickPublishableLoginCode — tags are not all login codes", () => {
  /** A real record, measured live 2026-09-05: a returning racer whose
   *  Intercard card was scanned THAT NIGHT, so the kind-2 card tag is the
   *  most-recent tag. `tags[0]` here minted /r/597195/wallet — which the
   *  route's shape gate bounced to /book/race for every scan. */
  const CARD_SCANNED_LAST = [
    { tag: "597195", lastSeen: "2026-09-05T04:09:12.751", kind: 2 },
    { tag: "nkd59ba4ox8dy", lastSeen: "2026-08-05T22:21:36.036", kind: 9 },
    { tag: "eddbb6c6-0310-4d6c-af7a-a8e01283dd05", lastSeen: "2026-04-09T23:45:17.71", kind: 10 },
    { tag: "545136", lastSeen: "2025-08-09T21:32:16.102", kind: 5 },
  ];

  it("skips a freshly-scanned card tag and picks the kind-9 login code", () => {
    expect(pickPublishableLoginCode(CARD_SCANNED_LAST)).toBe("nkd59ba4ox8dy");
  });

  it("order in the array must not matter — lastSeen decides recency", () => {
    const shuffled = [...CARD_SCANNED_LAST].reverse();
    expect(pickPublishableLoginCode(shuffled)).toBe("nkd59ba4ox8dy");
  });

  it("prefers the MOST RECENT kind-9 when several exist", () => {
    expect(
      pickPublishableLoginCode([
        { tag: "aaaaaaaaaaaa1", lastSeen: "2024-01-01T00:00:00", kind: 9 },
        { tag: "bbbbbbbbbbbb2", lastSeen: "2026-01-01T00:00:00", kind: 9 },
      ]),
    ).toBe("bbbbbbbbbbbb2");
  });

  it("prefers an OLDER kind-9 over a NEWER app-QR UUID — stable, typeable", () => {
    // Measured live (Andrew Bell): UUID newest, 13-char older — the code on a
    // pass must not flip to a UUID because the guest opened the app once.
    expect(
      pickPublishableLoginCode([
        {
          tag: "0eeb26b2-d87c-4f7e-ade4-4d00c9eef7be",
          lastSeen: "2026-01-13T18:45:03.011",
          kind: 10,
        },
        { tag: "qoq5qcgyha1pu", lastSeen: "2025-09-06T23:46:47.7486", kind: 9 },
      ]),
    ).toBe("qoq5qcgyha1pu");
  });

  it("falls back to the app-QR UUID when no kind-9 exists", () => {
    expect(
      pickPublishableLoginCode([
        { tag: "771460", lastSeen: "2026-01-01T00:00:00", kind: 5 },
        { tag: "d6db94ca-6e5d-4d17-be2d-d00813bb4895", lastSeen: "2025-01-01T00:00:00", kind: 10 },
      ]),
    ).toBe("d6db94ca-6e5d-4d17-be2d-d00813bb4895");
  });

  it("returns '' when only card / legacy tags exist — the chip must hide, never dead-end", () => {
    expect(
      pickPublishableLoginCode([
        { tag: "597338", lastSeen: "2026-09-05T01:22:22.284", kind: 2 },
        { tag: "853707", lastSeen: "2024-01-01T02:26:14.0766", kind: 5 },
      ]),
    ).toBe("");
  });

  it("returns '' for no tags at all", () => {
    expect(pickPublishableLoginCode([])).toBe("");
    expect(pickPublishableLoginCode(undefined)).toBe("");
    expect(pickPublishableLoginCode(null)).toBe("");
  });

  it("without a kind, falls back to shape — and a 13-DIGIT run is NOT a login code", () => {
    // Kindless cached shapes: the letter requirement keeps a long card number out.
    expect(
      pickPublishableLoginCode([
        { tag: "1234567890123", lastSeen: "2026-01-02T00:00:00" },
        { tag: "mgrm2g8o42wxc", lastSeen: "2026-01-01T00:00:00" },
      ]),
    ).toBe("mgrm2g8o42wxc");
  });

  it("every pick it publishes passes the route's own gate", () => {
    const sets = [
      CARD_SCANNED_LAST,
      [{ tag: "gexsshy7mzxbs", lastSeen: "2026-05-03T01:12:02.3712", kind: 9 }],
      [{ tag: "d6db94ca-6e5d-4d17-be2d-d00813bb4895", lastSeen: "2025-01-01", kind: 10 }],
    ];
    for (const tags of sets) {
      const code = pickPublishableLoginCode(tags);
      expect(code === "" || RACER_PUBLIC_CODE_RE.test(code), code).toBe(true);
    }
  });
});
