import { describe, it, expect } from "vitest";
import { buildWaiverRoster } from "./roster";
import { makeDisplayName } from "@/lib/display-name";
import { unionValidWithJoins, type RegisteredPerson } from "~/features/kiosk/waiver/valid-count";

/**
 * The load-bearing property: the roster's covered rows and the count the header
 * renders are the SAME number, and that number is still whatever
 * `unionValidWithJoins` said before the roster existed. If either half of that
 * drifts, "3 of 8 signed" starts contradicting the list printed under it.
 */
const reg = (personId: string, displayName: string): RegisteredPerson => ({
  personId,
  displayName,
});

function invariants(
  registered: RegisteredPerson[],
  flags: boolean[],
  joins: Array<{ personId: string; displayName: string }>,
) {
  const { roster, validCount } = buildWaiverRoster(registered, flags, joins);
  expect(roster.filter((r) => r.waiverValid)).toHaveLength(validCount);
  // Same count the pre-roster code produced from the raw Pandora flags.
  expect(validCount).toBe(unionValidWithJoins(registered, flags, joins).length);
  return roster;
}

describe("buildWaiverRoster", () => {
  it("keeps unsigned people on the roster (the reason it exists)", () => {
    const roster = invariants(
      [reg("11", "Ann A."), reg("12", "Bob B."), reg("13", "Cid G.")],
      [true, false, true],
      [],
    );
    expect(roster).toEqual([
      { personId: "11", displayName: "Ann A.", waiverValid: true },
      { personId: "12", displayName: "Bob B.", waiverValid: false },
      { personId: "13", displayName: "Cid G.", waiverValid: true },
    ]);
  });

  it("credits a join to the REGISTERED row it belongs to, by id", () => {
    const roster = invariants(
      [reg("11", "Ann A."), reg("12", "Bob B.")],
      [false, false],
      [{ personId: "12", displayName: "Bob B." }],
    );
    expect(roster).toEqual([
      { personId: "11", displayName: "Ann A.", waiverValid: false },
      { personId: "12", displayName: "Bob B.", waiverValid: true },
    ]);
  });

  it("credits a join by display name when the ids differ for one human", () => {
    // A kiosk join carries the SHORT Pandora id; BMI surfaced the 17-digit Office
    // id for the same person. Without the name fallback Bob would appear twice —
    // once unsigned, once as a stranger.
    const roster = invariants(
      [reg("51383608123456789", "Bob B.")],
      [false],
      [{ personId: "412", displayName: "bob b." }],
    );
    expect(roster).toEqual([
      { personId: "51383608123456789", displayName: "Bob B.", waiverValid: true },
    ]);
  });

  it("appends a signer whose BMI attach failed", () => {
    const roster = invariants(
      [reg("11", "Ann A.")],
      [true],
      [{ personId: "99", displayName: "Dee D." }],
    );
    expect(roster).toEqual([
      { personId: "11", displayName: "Ann A.", waiverValid: true },
      { personId: "99", displayName: "Dee D.", waiverValid: true },
    ]);
  });

  it("does not let one valid person cover a namesake", () => {
    // Two real "John S."s on one booking: only the one Pandora vouches for is
    // covered. The name fallback is for JOINS, not for registered-to-registered.
    const roster = invariants([reg("11", "John S."), reg("12", "John S.")], [true, false], []);
    expect(roster.map((r) => r.waiverValid)).toEqual([true, false]);
  });

  it("handles an empty booking", () => {
    expect(buildWaiverRoster([], [], [])).toEqual({ roster: [], validCount: 0 });
  });

  // ── PII: no full name may leave this projection ─────────────────────
  // The output feeds a link the organizer forwards to the whole party. Fixing
  // makeDisplayName stops anything NEW arriving unredacted; these cover the shapes
  // that can still reach `buildWaiverRoster` from data already at rest.

  it("redacts a full name that arrives on a registered row anyway", () => {
    // buildWaiverRoster is pure and public — it must not depend on its caller
    // having redacted first.
    const roster = invariants(
      [reg("11", "Ann Alpha"), reg("12", "Mary Jane Watson-Parker")],
      [true, true],
      [],
    );
    expect(roster.map((r) => r.displayName)).toEqual(["Ann A.", "Mary W."]);
  });

  it("redacts a legacy kiosk_waiver_joins row written by the old helper", () => {
    // A guest who typed their whole name into the kiosk's first-name box before
    // 2026-07-30 has a full name stored in Neon RIGHT NOW. Her BMI attach failed,
    // so she is appended straight from that row — the one path the helper fix
    // cannot reach.
    const roster = invariants(
      [reg("11", "Ann A.")],
      [true],
      [{ personId: "99", displayName: "Mary Jane Watson-Parker" }],
    );
    expect(roster).toEqual([
      { personId: "11", displayName: "Ann A.", waiverValid: true },
      { personId: "99", displayName: "Mary W.", waiverValid: true },
    ]);
  });

  it("never emits more than a given name plus one initial", () => {
    const roster = invariants(
      [reg("11", "Ann Alpha"), reg("12", "Cher"), reg("13", "Ana García Pérez")],
      [true, false, true],
      [{ personId: "99", displayName: "Dee Delta" }],
    );
    for (const r of roster) {
      const tokens = r.displayName.split(" ");
      expect(tokens.length, r.displayName).toBeLessThanOrEqual(2);
      if (tokens.length === 2) expect(tokens[1], r.displayName).toMatch(/^\p{L}\.$/u);
    }
    expect(JSON.stringify(roster)).not.toMatch(/Alpha|Pérez|Delta/);
  });

  it("leaves an already-redacted name untouched (the guard is idempotent)", () => {
    // The guard runs on every row, so it must be a no-op for the normal case —
    // "Ann A." must not become "Ann A" or "Ann ..".
    const roster = invariants([reg("11", "Ann A."), reg("12", "A.")], [true, true], []);
    expect(roster.map((r) => r.displayName)).toEqual(["Ann A.", "A."]);
  });

  // ── The dedupe key, end to end through the real union ────────────────
  // Both sides of the match are folded by the SAME helper at the two real call
  // sites — `makeDisplayName(firstName, lastName)` in /api/kiosk/waiver/join, and
  // `makeDisplayName(p.firstName || "", p.name || "")` in the two roster routes.
  // These build the rows exactly that way instead of hand-writing "Ann A.", so a
  // change to the redaction rule that splits the key shows up HERE, as a guest
  // being asked to sign again and appearing twice.

  /** A registered row as the routes build it from a BMI persons_list entry. */
  const bmiReg = (
    personId: string,
    p: { firstName?: string; name?: string },
  ): RegisteredPerson => ({
    personId,
    displayName: makeDisplayName(p.firstName || "", p.name || ""),
  });

  /** A kiosk_waiver_joins row as /api/kiosk/waiver/join writes it. */
  const kioskJoin = (personId: string, firstName: string, lastName = "") => ({
    personId,
    displayName: makeDisplayName(firstName, lastName),
  });

  it("credits a kiosk join to its BMI row whatever field shape BMI used", () => {
    // Ann signed at the kiosk under the SHORT Pandora id; BMI surfaces the 17-digit
    // Office id for the same human, so ONLY the name key can connect them. Each of
    // these is a shape BMI has been seen to send for one person.
    for (const bmi of [
      { firstName: "Ann", name: "Alpha" },
      { firstName: "Ann Alpha", name: "" }, // whole name in firstName
      { firstName: "Ann Alpha" }, // no surname key at all
      { firstName: "  Ann   Alpha  ", name: "  " }, // padded, whitespace-only surname
      { firstName: "ANN", name: "ALPHA" }, // BMI shouts
    ]) {
      const { roster, validCount } = buildWaiverRoster(
        [bmiReg("51383608123456789", bmi)],
        [false], // Pandora says no; the Neon join is the only evidence
        [kioskJoin("412", "Ann", "Alpha")],
      );
      const label = JSON.stringify(bmi);
      // One human, ONE row — not a covered stranger standing next to an unsigned Ann.
      expect(roster, label).toHaveLength(1);
      expect(roster[0].waiverValid, label).toBe(true);
      expect(validCount, label).toBe(1);
      expect(roster[0].personId, label).toBe("51383608123456789");
      expect(roster[0].displayName, label).not.toMatch(/Alpha|ALPHA/);
    }
  });

  it("still matches by id when the name cannot be folded to the same key", () => {
    // The known cost of "no surname word is ever printed": a BMI row with an EMPTY
    // given name keys as "w.", which cannot equal a kiosk join's "Watson P.".
    // personId is the PRIMARY key in both dedupe passes and it still carries the
    // match, so the guest is credited once and is not asked to sign again.
    const registered = [bmiReg("77", { firstName: "", name: "Watson Parker" })];
    expect(registered[0].displayName).toBe("W."); // never "Watson P."
    const { roster, validCount } = buildWaiverRoster(
      registered,
      [false],
      [kioskJoin("77", "Watson", "Parker")],
    );
    expect(roster).toEqual([{ personId: "77", displayName: "W.", waiverValid: true }]);
    expect(validCount).toBe(1);
    expect(JSON.stringify(roster)).not.toContain("Watson");
  });

  it("does not fold two different humans onto one key", () => {
    // The other direction: tightening the rule must not make strangers collide.
    // Ann Alpha and Ann Beta are two people and stay two rows, one covered.
    const { roster, validCount } = buildWaiverRoster(
      [
        bmiReg("11", { firstName: "Ann", name: "Alpha" }),
        bmiReg("12", { firstName: "Ann", name: "Beta" }),
      ],
      [false, false],
      [kioskJoin("911", "Ann", "Alpha")],
    );
    expect(roster).toEqual([
      { personId: "11", displayName: "Ann A.", waiverValid: true },
      { personId: "12", displayName: "Ann B.", waiverValid: false },
    ]);
    expect(validCount).toBe(1);
  });
});
