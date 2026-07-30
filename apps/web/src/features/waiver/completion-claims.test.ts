/**
 * Contract test for every GROUP-WIDE claim the /waiver page makes.
 *
 * "All waivers signed" is a statement about a whole reservation, and the page has
 * been wrong about it twice. Round 1 said it unconditionally. Round 2 gated it on
 * "no unsigned roster rows are on this screen" — which is also true of a booking
 * whose BMI persons_list came back EMPTY (`persons: 8`, `persons_list: []`), of one
 * whose cards the guest removed, and of one this phone already wiped with "I'm done".
 * Two more surfaces said the same thing without the word: the head progress bar,
 * filled from `signedCount / party.length`, and the terminal card, which printed the
 * outstanding line only when it held a POSITIVE count — so a booking we could not
 * vouch for read exactly like a finished one.
 *
 * Every one of those was green under the unit tests, because none of them is a
 * function: they are the wiring between an honest number and a sentence. There is no
 * RTL harness for WaiverFlow, so this pins the wiring from source, in the same style
 * as share-disclosure.test.ts — and then EVALUATES the licence it just found against
 * the reported booking, so the pin cannot pass by naming a gate that says yes anyway.
 *
 * The other half of the contract is that the guest can still LEAVE. Round 1's gate
 * waited on all eight rows, so a guest who signed their own row on a forwarded link
 * had no end to the flow at all. Nothing here may re-couple the exit to the group.
 *
 * When one of these goes red, re-read roster-preload.ts invariant 6 and check the
 * sentence against what the reservation actually knows. Do not relax the assertion.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { mergeRosterIntoParty, reservationWaiverStatus } from "./roster-preload";
import type { WaiverRosterEntry } from "./roster";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, "WaiverFlow.tsx"), "utf8");

/** The rendered claim, verbatim. */
const ALL_SIGNED = "All waivers signed";
/** …and the claim as it is actually RENDERED. The phrase alone also appears in the
 *  prose explaining why it is gated, so every locator below anchors on the ternary
 *  rather than on the words. */
const RENDERED_CLAIM = `? "${ALL_SIGNED}"`;

/**
 * The body of a top-level `function <name>(` declaration, to the `}` in column 0 that
 * closes it. NOT the first `\n}`: a multi-line destructured parameter list (WaiverHead)
 * closes with `\n}: {` in column 0 too, which cuts the body off before it starts —
 * silently, since every `.toContain` on the remainder then just fails.
 */
function functionSource(name: string): string {
  const start = source.indexOf(`function ${name}(`);
  expect(start, `function ${name} not found in WaiverFlow.tsx`).toBeGreaterThan(-1);
  const end = source.indexOf("\n}\n", start);
  const body = source.slice(start, end === -1 ? undefined : end);
  expect(body, `function ${name} came back empty — the extractor is broken`).toContain("{");
  return body;
}

/** A `{<flag> && ( … )}` JSX block, to the `)}` that closes it. */
function jsxBlock(flag: string): string {
  const start = source.indexOf(`{${flag} && (`);
  expect(start, `the {${flag} && …} block is gone from WaiverFlow.tsx`).toBeGreaterThan(-1);
  const end = source.indexOf("\n      )}", start);
  expect(end, `could not find the end of the {${flag} && …} block`).toBeGreaterThan(start);
  return source.slice(start, end);
}

/** The `if (finished) { … }` terminal branch. */
function terminalBranch(): string {
  const start = source.indexOf("if (finished) {");
  expect(start, "the terminal branch is gone from WaiverFlow.tsx").toBeGreaterThan(-1);
  const end = source.indexOf("\n  }", start);
  expect(end, "could not find the end of the terminal branch").toBeGreaterThan(start);
  return source.slice(start, end);
}

/** The single line declaring `const <name> =`. */
function declaration(name: string): string {
  const re = new RegExp(`^.*\\bconst ${name}(:[^=]*)? =.*$`, "m");
  const line = re.exec(source)?.[0];
  expect(line, `const ${name} not found in WaiverFlow.tsx`).toBeTruthy();
  return line as string;
}

/** The reported booking: 8 registered, 4 of them without a waiver. */
const eightPerson: WaiverRosterEntry[] = [
  { personId: "11", displayName: "Ann A.", waiverValid: false },
  { personId: "12", displayName: "Bob B.", waiverValid: false },
  { personId: "13", displayName: "Cid C.", waiverValid: false },
  { personId: "14", displayName: "Dee D.", waiverValid: false },
  { personId: "15", displayName: "Eve E.", waiverValid: true },
  { personId: "16", displayName: "Fay F.", waiverValid: true },
  { personId: "17", displayName: "Gus G.", waiverValid: true },
  { personId: "18", displayName: "Hal H.", waiverValid: true },
];

describe("the all-signed claim", () => {
  it("is still in the copy, and said exactly once (non-vacuity)", () => {
    // Everything below locates this sentence and inspects what guards it. If it is
    // reworded or removed, these tests silently stop checking anything at all — so
    // they fail loudly here instead, and whoever reworded it re-points them.
    const claims = source.split(RENDERED_CLAIM).length - 1;
    expect(
      claims,
      "no rendered 'All waivers signed' claim left in WaiverFlow.tsx — the copy was " +
        "reworded, so this whole file is no longer checking anything. Re-point it at the " +
        "new sentence. (More than one means a second, unguarded surface grew the claim.)",
    ).toBe(1);
    // …and the machinery it is supposed to be wired to is really there.
    for (const symbol of [
      "mayClaimAllSigned(",
      "reservationWaiverStatus({",
      "groupWaiverLine(",
      "waiverProgress({",
    ]) {
      expect(
        source,
        `${symbol} is gone — the claim is no longer wired to the reservation`,
      ).toContain(symbol);
    }
  });

  it("is licensed by the authoritative reservation status, never by this device's rows", () => {
    const at = source.indexOf(RENDERED_CLAIM);
    // Window includes the claim itself: the `?` it hangs off is part of the guard.
    const guard = source.slice(Math.max(0, at - 200), at + RENDERED_CLAIM.length);
    expect(guard, `"${ALL_SIGNED}" is not guarded by mayClaimAllSigned(groupStatus)`).toMatch(
      /mayClaimAllSigned\(groupStatus\)\s*\?/,
    );
    // The licence may consult the STATUS and nothing else. Any of these names inside
    // it would mean the claim is back to being derived from this phone's party.
    const licence = functionSource("mayClaimAllSigned");
    expect(licence).toContain('status.kind === "covered"');
    for (const local of [
      "party",
      "signedCount",
      "myMembers",
      "signedHere",
      "unsignedPreloadCount",
      "signable",
    ]) {
      expect(
        licence,
        `mayClaimAllSigned reads ${local} — that is a device-scoped claim`,
      ).not.toMatch(new RegExp(`\\b${local}\\b`));
    }
  });

  it("derives the status from ctx.signed / ctx.total — the counts the server owns", () => {
    const call = source.slice(source.indexOf("reservationWaiverStatus({"));
    const args = call.slice(0, call.indexOf("})") + 2);
    expect(args).toContain("signed: ctx?.signed");
    expect(args).toContain("total: ctx?.total");
    expect(args).toContain("roster: ctx?.roster");
    // …and the proofs that outlive the "I'm done" wipe, or the count creeps back up.
    expect(args).toContain("covered: carriedCovered");
    expect(source).toMatch(/setCarriedCovered\(\(prev\) => coveredPersonIds\(party, prev\)\)/);
  });

  it("is FALSE for the reported booking — the licence, evaluated", () => {
    // The pin above proves the claim is gated on `mayClaimAllSigned(groupStatus)`.
    // This proves the gate actually says no: 8 registered, 4 unsigned, the guest on
    // the forwarded link signs their own row. Both halves are needed — round 2 had an
    // honest number and still printed the claim.
    const party = mergeRosterIntoParty([], eightPerson).map((m) =>
      m.id === "res:11" ? { ...m, waiverValid: true } : m,
    );
    const status = reservationWaiverStatus({
      signed: 4,
      total: 8,
      roster: eightPerson,
      party,
    });
    expect(status).toEqual({ kind: "outstanding", count: 3 });
    expect(status.kind === "covered").toBe(false);

    // And it stays no through every way this device can empty its own screen: the
    // guest removes the cards that are not their family, and "I'm done" wipes the lot.
    const trimmed = party.filter((m) => !["res:12", "res:13", "res:14"].includes(m.id));
    expect(
      reservationWaiverStatus({ signed: 4, total: 8, roster: eightPerson, party: trimmed }),
    ).toEqual({ kind: "outstanding", count: 3 });
    expect(
      reservationWaiverStatus({ signed: 4, total: 8, roster: eightPerson, party: [] }),
    ).not.toMatchObject({ kind: "covered" });
    // …and for the booking whose persons_list came back empty on a headcount of 8.
    expect(
      reservationWaiverStatus({ signed: 0, total: 8, roster: [], party: [] }),
    ).not.toMatchObject({ kind: "covered" });
  });
});

describe("the surfaces that claim completion without the words", () => {
  it("fills the head progress bar from the reservation, not from the party", () => {
    // A full bar over "N of N signed" is the same claim as the headline. Fed
    // `signedCount / party.length` it filled for a wiped or edited party on a booking
    // with four people outstanding.
    expect(source).toContain("signed={progress.signed}");
    expect(source).toContain("total={progress.total}");
    expect(source, "the head bar is back on this device's own rows").not.toContain(
      "signed={signedCount}",
    );
    expect(source, "the head bar is back on this device's own rows").not.toContain(
      "total={party.length}",
    );
    // WaiverHead itself must keep printing exactly what it is handed — no local
    // arithmetic that could re-open the gap between the bar and the sentence.
    const head = functionSource("WaiverHead");
    expect(head).toContain("{signed} of {total} signed");
    expect(head).not.toMatch(/\bparty\b/);
  });

  it("never lets the terminal card go quiet about people who are outstanding", () => {
    const terminal = terminalBranch();
    // The regression: `{!!finished.othersLeft && …}`. A falsy count printed NOTHING,
    // and "nothing" is how a guest reads "everyone is done" — including in the case
    // where we frankly do not know.
    expect(source, "finished.othersLeft is back — a falsy count prints nothing").not.toContain(
      "othersLeft",
    );
    expect(terminal).toContain("groupWaiverLine(finished.status)");
    expect(terminal).toContain("{finishedLine && (");
    // Frozen, never recomputed: the wipe emptied `party`, so a live recount here would
    // have no unsigned rows left to contradict it.
    expect(terminal).not.toContain("groupWaiverLine(groupStatus)");
    // The terminal card speaks for THIS DEVICE only. The group-wide sentence is the
    // one below it; the headline must not borrow the reservation's words.
    expect(terminal).not.toContain(ALL_SIGNED);
  });

  it("words the group the same way in both cards, from one function", () => {
    // Two hand-written sentences drifted apart once already: the ready card grew a
    // "we cannot tell" branch and the terminal card never did.
    const line = functionSource("groupWaiverLine");
    expect(line).toContain('status.kind === "covered"');
    expect(line).toContain('status.kind === "unknown"');
    expect(line).toContain("count === null");
    expect(line).toContain("stillNeedWaiverLine(");
    // Both cards read it.
    expect(source).toContain("groupWaiverLine(groupStatus)");
    expect(source).toContain("groupWaiverLine(finished.status)");
  });
});

describe("the way out", () => {
  it("gates the completion card on THIS DEVICE's members only", () => {
    // Round 1's gate was `peopleReady(party, EVERY party id)`: a guest on a forwarded
    // link for an 8-person booking with 4 unsigned signed their own row and the flow
    // never ended. Re-coupling the exit to the group brings that straight back.
    const gate = declaration("ready");
    expect(gate).toMatch(/myIds\.length > 0/);
    expect(gate).toMatch(/peopleReady\(party,\s*myIds\)\s*===\s*true/);
    for (const group of ["groupStatus", "groupLine", "covered", "mayClaimAllSigned", "ctx"]) {
      expect(
        gate,
        `the exit is gated on ${group} — that is the unreachable terminal again`,
      ).not.toMatch(new RegExp(`\\b${group}\\b`));
    }
    expect(declaration("myMembers")).toContain("membersOwnedHere(party, signedHere)");
  });

  it("keeps the exit inside that gate, and reachable while the booking is outstanding", () => {
    const readyCard = jsxBlock("ready");
    expect(readyCard).toContain("I&apos;m done");
    expect(readyCard).toContain("setFinished({");
    // The card is shown, and the button exists, whatever the group status says — the
    // status only chooses the WORDS. A conditional around the button would be the
    // round-1 dead end wearing a different hat.
    const buttonAt = readyCard.indexOf("setFinished({");
    const beforeButton = readyCard.slice(0, buttonAt);
    expect(
      beforeButton.match(/\{(groupStatus|groupLine|mayClaimAllSigned)[^}]*&&/),
      "the 'I'm done' button was put behind a group-wide condition",
    ).toBeNull();
  });

  it("still tells the truth on the way out — the exit records what was outstanding", () => {
    const readyCard = jsxBlock("ready");
    expect(readyCard).toMatch(/status: groupStatus/);
    expect(readyCard).toMatch(/names: myMembers\.map/);
  });
});
