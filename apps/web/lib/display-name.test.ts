import { describe, it, expect } from "vitest";
import { displayNameFromFull, makeDisplayName } from "./display-name";

/**
 * The contract, stated as tests. Nothing this module returns may carry more than a
 * given name and a single initial, no word from the SURNAME field may ever be
 * printed in full, and — the part round 2 got wrong — tightening the rule must
 * never reveal MORE than the original helper did for ANY input.
 *
 * Every caller feeds either a guest-visible list or a stored redacted label —
 * /api/waiver/context's forwardable roster, /api/kiosk/waiver/roster, the
 * kiosk_waiver_joins row written by /api/kiosk/waiver/join, and the check-in
 * person row.
 *
 * Two leaks are on the record, and the second is why `oldHelper` below is pinned
 * into this file as an oracle rather than trusted to memory:
 *
 *   2026-07-30 I  — the helper returned the FIRST-NAME FIELD verbatim whenever the
 *                   surname field was empty, and BMI records routinely carry the
 *                   whole name there, so a full name reached a forwardable link.
 *   2026-07-30 II — the fix for I re-split "whichever field is populated", which
 *                   made ("", "Watson Parker") print "Watson P." where the ORIGINAL
 *                   helper had printed only " W.". Tests were green: every
 *                   assertion was about the shapes that got better.
 */

/** Whitespace-normalized tokens of a rendered name — "  Ann A. " → ["Ann","A."]. */
function tokensOf(out: string): string[] {
  return out.trim().split(/\s+/).filter(Boolean);
}

/** True for a rendered initial ("A.", "É.") rather than a name printed in full. */
function isInitial(token: string): boolean {
  return token.length === 2 && token.endsWith(".");
}

/** Failure label: `["","Watson Parker"] → "W."` — says which shape broke. */
function shapeLabel(first: string, last: string, out: string): string {
  return `${JSON.stringify([first, last])} → ${JSON.stringify(out)}`;
}

/* ── The oracle: lib/display-name.ts as committed in 2681cd07 ─────────────
 * Verbatim, so "no more revealing than before" is measured against the code that
 * actually shipped instead of against a recollection of it. Do not "modernize"
 * this copy — its value is that it is frozen.
 */
function oldHelper(first: string, last: string): string {
  const f = (first || "").trim();
  const l = (last || "").trim();
  if (!l) return f;
  return `${f} ${l.charAt(0).toUpperCase()}.`;
}

/**
 * Everything a rendered name discloses about a human.
 *
 * A word printed in full discloses the word AND its initial; an initial discloses
 * only itself. Comparing these sets is what makes "no more revealing" a decidable
 * claim instead of a vibe: printing "A." where the old code printed "Alpha" is
 * strictly less, and printing "Watson P." where it printed "W." is strictly more.
 */
function discloses(out: string): Set<string> {
  const facts = new Set<string>();
  for (const token of tokensOf(out)) {
    if (isInitial(token)) {
      facts.add(`init:${token[0].toUpperCase()}`);
    } else {
      facts.add(`word:${token}`);
      facts.add(`init:${token.charAt(0).toUpperCase()}`);
    }
  }
  return facts;
}

/** Every field shape BMI, the kiosk form, or a Neon row at rest has been seen to
 *  produce — the table the properties below are quantified over. */
const SHAPES: Array<[string, string]> = [
  ["Ann", "Alpha"],
  ["Ann Alpha", ""],
  ["Mary Jane Watson-Parker", ""],
  ["Mary", "Watson-Parker"],
  ["Mary Jane", "Watson"],
  ["", "Alpha"],
  ["", "Watson Parker"],
  ["", "Van Der Berg"],
  ["", "Ann Alpha"],
  ["Cher", ""],
  ["Cher", "   "],
  ["", ""],
  ["  ", "  "],
  ["  Ann   Alpha  ", ""],
  ["Ana", "García Pérez"],
  ["Ana García Pérez", ""],
  ["Eric", "Van Der Berg"],
  ["JEAN-LUC PICARD", ""],
  ["ann", "alpha"],
  // Already-redacted values: `roster.redactRosterName` re-applies the rule to rows
  // read back out of kiosk_waiver_joins.
  ["Ann A.", ""],
  ["A.", ""],
  ["Cher", ""],
];

describe("makeDisplayName", () => {
  it("keeps the source's own split when BOTH fields are populated", () => {
    expect(makeDisplayName("Ann", "Alpha")).toBe("Ann A.");
    expect(makeDisplayName("Eric", "Osborn")).toBe("Eric O.");
    // A two-part surname still initials to its FIRST letter — "Ana G.", never
    // "Ana P.". Latino two-surname records are common here; that split is real
    // information and the field boundary is authoritative when BMI populated it.
    expect(makeDisplayName("Ana", "García Pérez")).toBe("Ana G.");
    expect(makeDisplayName("Eric", "Van Der Berg")).toBe("Eric V.");
    expect(makeDisplayName("ann", "alpha")).toBe("ann A."); // initial uppercased
    // Only the FIRST given token is printed, even with a surname field present.
    expect(makeDisplayName("Mary Jane", "Watson")).toBe("Mary W.");
  });

  it("redacts a whole name parked in the first-name field (leak I)", () => {
    expect(makeDisplayName("Ann Alpha", "")).toBe("Ann A.");
    expect(makeDisplayName("Mary Jane Watson-Parker", "")).toBe("Mary W.");
    expect(makeDisplayName("Ana García Pérez", "")).toBe("Ana P.");
  });

  it("prints only an initial for ANY bare surname field, one token or five (leak II)", () => {
    // Nothing in the given-name field identifies a given name, so no word here is
    // printable. The token COUNT of the surname field must not change that: reading
    // a multi-token surname as "it must be a whole name, so re-split it" is exactly
    // how round 2 turned " W." into "Watson P." on a forwardable link.
    expect(makeDisplayName("", "Alpha")).toBe("A.");
    expect(makeDisplayName("", "Watson Parker")).toBe("W.");
    expect(makeDisplayName("", "Van Der Berg")).toBe("V.");
    expect(makeDisplayName("", "Ann Alpha")).toBe("A.");
    expect(makeDisplayName("", "García Pérez")).toBe("G.");
  });

  it("passes a true mononym through — there is nothing left to redact", () => {
    expect(makeDisplayName("Cher", "")).toBe("Cher");
    expect(makeDisplayName("Cher", "   ")).toBe("Cher");
  });

  it("is empty for empty and whitespace-only input", () => {
    expect(makeDisplayName("", "")).toBe("");
    expect(makeDisplayName("   ", "\t\n ")).toBe("");
  });

  it("is idempotent — re-redacting its own output changes nothing", () => {
    // Load-bearing: ~/features/waiver/roster re-applies the rule to names that may
    // already be redacted (rows read back from kiosk_waiver_joins).
    for (const out of ["Ann A.", "Cher", "A.", "W.", ""]) {
      expect(makeDisplayName(out, "")).toBe(out);
      expect(displayNameFromFull(out)).toBe(out);
    }
    // And idempotent over the whole reachable output range, not just those five.
    for (const [first, last] of SHAPES) {
      const once = makeDisplayName(first, last);
      expect(displayNameFromFull(once), `${JSON.stringify([first, last])}`).toBe(once);
    }
  });

  // ── The properties, quantified over every known shape ────────────────

  it("never prints a word that did not come from the GIVEN-name field", () => {
    // The exact statement of "no surname token, ever, in full" — immune to a human
    // whose given and family names happen to be the same word.
    for (const [first, last] of SHAPES) {
      const out = makeDisplayName(first, last);
      const printableWord = (first || "").trim().split(/\s+/).filter(Boolean)[0];
      for (const token of tokensOf(out)) {
        const label = `${shapeLabel(first, last, out)} printed ${token}`;
        expect(isInitial(token) || token === printableWord, label).toBe(true);
      }
    }
  });

  it("never emits more than a given name plus one initial", () => {
    for (const [first, last] of SHAPES) {
      const out = makeDisplayName(first, last);
      const tokens = tokensOf(out);
      const label = shapeLabel(first, last, out);
      expect(tokens.length, label).toBeLessThanOrEqual(2);
      if (tokens.length === 2) expect(isInitial(tokens[1]), label).toBe(true);
      // The specific failure mode of both leaks: a second full name token surviving.
      expect(out).not.toMatch(/Alpha|Watson|Parker|Pérez|PICARD|Berg|Osborn/);
    }
  });

  it("is MONOTONIC — never more revealing than the pre-2026-07-30 helper", () => {
    // The assertion round 2 did not have, and the only one that catches a redaction
    // rule getting looser. ("", "Watson Parker") fails this as "Watson P.": it
    // discloses word:Watson and init:P where the old output disclosed only init:W.
    for (const [first, last] of SHAPES) {
      const out = makeDisplayName(first, last);
      const before = oldHelper(first, last);
      const label = `${shapeLabel(first, last, out)} (old: ${JSON.stringify(before)})`;
      const oldFacts = discloses(before);
      for (const fact of discloses(out)) {
        expect(oldFacts.has(fact), `${label} newly discloses ${fact}`).toBe(true);
      }
      expect(tokensOf(out).length, label).toBeLessThanOrEqual(tokensOf(before).length);
    }
  });

  it("returns an already-trimmed, single-spaced name for every shape", () => {
    // Contract 4, and NOT cosmetic: `unionValidWithJoins` keys `name.toLowerCase()`
    // while `buildWaiverRoster` keys `name.trim().toLowerCase()`. The two dedupe
    // passes agree only while this holds. The old helper broke it — ("", "Alpha")
    // returned " A.", which also slipped every `.filter(p => p.displayName)` guard
    // as a truthy, blank-looking name.
    for (const [first, last] of SHAPES) {
      const out = makeDisplayName(first, last);
      const label = shapeLabel(first, last, out);
      expect(out, label).toBe(out.trim());
      expect(out, label).not.toMatch(/\s\s/);
      expect(out.toLowerCase(), label).toBe(out.trim().toLowerCase());
    }
  });
});

describe("displayNameFromFull", () => {
  it("reduces a one-string name to given + surname initial", () => {
    expect(displayNameFromFull("Eric Osborn")).toBe("Eric O.");
    expect(displayNameFromFull("Mary Jane Watson-Parker")).toBe("Mary W.");
    expect(displayNameFromFull("  Ross   Gallagher ")).toBe("Ross G.");
  });

  it("passes single tokens through and tolerates blanks", () => {
    expect(displayNameFromFull("Cher")).toBe("Cher");
    expect(displayNameFromFull("")).toBe("");
    expect(displayNameFromFull("   ")).toBe("");
  });

  it("agrees with makeDisplayName on the same human", () => {
    // The two entry points are one rule; a caller must not get a different
    // redaction depending on whether BMI handed it one field or two.
    expect(displayNameFromFull("Mary Jane Watson-Parker")).toBe(
      makeDisplayName("Mary Jane Watson-Parker", ""),
    );
    expect(displayNameFromFull("Eric Osborn")).toBe(makeDisplayName("Eric", "Osborn"));
    expect(displayNameFromFull("Ann Alpha")).toBe(makeDisplayName("Ann", "Alpha"));
  });
});

/**
 * THE KEY — the invariant that outranks the redaction cosmetics.
 *
 * This output is the dedupe key between kiosk_waiver_joins rows and BMI registered
 * rows. `unionValidWithJoins` matches on `displayName.toLowerCase()`;
 * `buildWaiverRoster` matches on `displayName.trim().toLowerCase()`. Fold the two
 * sides differently and a guest who already signed is asked to sign again AND
 * appears twice on the roster.
 *
 * These fold exactly the way the two production call sites fold, so the proof is
 * of the real key and not of a paraphrase of it.
 */
const joinRowName = (firstName: string, lastName: string) => makeDisplayName(firstName, lastName); // app/api/kiosk/waiver/join/route.ts:48

const bmiRowName = (p: { firstName?: string; name?: string }) =>
  makeDisplayName(p.firstName || "", p.name || ""); // both waiver roster routes

const unionKey = (displayName: string) => displayName.toLowerCase(); // valid-count.ts
const rosterKey = (displayName: string) => displayName.trim().toLowerCase(); // roster.ts

describe("the kiosk-join ↔ BMI dedupe key", () => {
  it("folds both sides identically for every shape BMI sends for one human", () => {
    // "Ann Alpha" signed at the kiosk (first + last boxes) and is also registered on
    // the reservation, where BMI may surface her name in any of these shapes.
    const join = joinRowName("Ann", "Alpha");
    expect(join).toBe("Ann A.");
    for (const bmi of [
      { firstName: "Ann", name: "Alpha" },
      { firstName: "Ann Alpha", name: "" }, // whole name in firstName — leak I's shape
      { firstName: "Ann Alpha" }, // surname key absent entirely
      { firstName: "  Ann   Alpha  ", name: "  " }, // padded / whitespace-only surname
      { firstName: "ANN", name: "ALPHA" }, // BMI shouts; the key is case-folded
      { firstName: "Ann", name: "Alpha Beta" }, // two-part surname, field wins
    ]) {
      const label = JSON.stringify(bmi);
      expect(unionKey(bmiRowName(bmi)), label).toBe(unionKey(join));
      // …and the roster's trimming variant of the same key agrees, which only holds
      // because the helper never returns padded output.
      expect(rosterKey(bmiRowName(bmi)), label).toBe(rosterKey(join));
      expect(unionKey(bmiRowName(bmi)), label).toBe(rosterKey(bmiRowName(bmi)));
    }
  });

  it("keys the two dedupe passes identically for every shape", () => {
    // valid-count does not trim and roster does; if the helper ever emits padding,
    // one pass dedupes and the other does not.
    for (const [first, last] of SHAPES) {
      const out = makeDisplayName(first, last);
      expect(unionKey(out), JSON.stringify([first, last])).toBe(rosterKey(out));
    }
  });

  it("survives the roster's extra redaction pass without moving", () => {
    // `redactRosterName` re-applies `displayNameFromFull` to every row on the way
    // out. For a name the helper already produced that must be a no-op, or the
    // rendered name would stop matching the key it was deduped on.
    for (const [first, last] of SHAPES) {
      const out = makeDisplayName(first, last);
      expect(rosterKey(displayNameFromFull(out)), JSON.stringify([first, last])).toBe(
        rosterKey(out),
      );
    }
  });

  it("cannot name-match a BMI row that has NO given name — by design", () => {
    // The one dedupe cost of contract 2, recorded on purpose. If BMI parks a whole
    // name in the SURNAME field ("", "Watson Parker") the row keys as "w." and can
    // no longer match a kiosk join of ("Watson", "Parker"). Making those keys agree
    // would require printing "Watson" in full on a forwardable link, which is the
    // leak this module exists to prevent — so the ranking is deliberate:
    //   PII first, and let personId carry the match (which is the PRIMARY key in
    //   both dedupe passes; the name is only the fallback for when the kiosk's short
    //   Pandora id and BMI's 17-digit Office id disagree for one human).
    // Asserted rather than commented so that "fixing" it by re-leaking goes red.
    const bmi = bmiRowName({ firstName: "", name: "Watson Parker" });
    expect(bmi).toBe("W.");
    expect(unionKey(bmi)).not.toBe(unionKey(joinRowName("Watson", "Parker")));
    // Neither side prints a surname word, whichever way the fold went.
    expect(bmi).not.toContain("Watson");
    expect(joinRowName("Watson", "Parker")).toBe("Watson P.");
    // A kiosk join can never BE this shape: /api/kiosk/waiver/join requires a
    // non-empty firstName (`z.string().trim().min(1)`), so the unmatchable class is
    // BMI-side only and always has the id available.
  });
});
